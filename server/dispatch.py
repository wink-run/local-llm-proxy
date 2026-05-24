import asyncio
import json
import os
import time
import uuid

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

import database as db
from worker_pool import pool

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))


async def handle_chat(body: dict, consumer_user_id: int | None = None, key_id: int | None = None):
    model = body.get("model", "")
    streaming = body.get("stream", False)

    # Build ordered list of models to try: scene route steps, then the requested model
    models_to_try: list[str] = []
    if key_id is not None:
        scene = await db.get_scene_route_by_key(key_id)
        if scene:
            raw_steps = scene.get("steps", "[]")
            steps = json.loads(raw_steps) if isinstance(raw_steps, str) else raw_steps
            models_to_try = [s["model"] for s in steps if s.get("model")]
    if not models_to_try:
        models_to_try = [model]

    # Credits check once before attempting any step
    if consumer_user_id is not None:
        rate = None
        for m in models_to_try:
            rate = await db.get_consume_rate(m)
            if rate is not None:
                break
        if rate is None:
            raise HTTPException(
                400,
                f"模型「{model}」未在后台启用或未配置消费率；请在管理端「模型配置」添加与 Worker 上报完全一致的模型名称。",
            )
        user = await db.get_user_by_id(consumer_user_id)
        if not user or user["credits_balance"] <= 0:
            raise HTTPException(402, "Insufficient credits")

    last_error: str = "No worker available"
    for attempt_model in models_to_try:
        worker = pool.pick(attempt_model, model_type="chat")
        if not worker:
            last_error = f"No worker available for model '{attempt_model}'"
            continue

        req_id = str(uuid.uuid4())
        q: asyncio.Queue = asyncio.Queue()
        worker.pending[req_id] = {
            "queue": q,
            "model": attempt_model,
            "dispatch_time": time.time(),
            "ttft_ms": None,
        }
        worker.active_requests += 1

        dispatch_body = dict(body)
        dispatch_body["model"] = attempt_model

        try:
            await worker.send({"type": "request", "req_id": req_id, "payload": dispatch_body})
        except Exception:
            worker.pending.pop(req_id, None)
            worker.active_requests = max(0, worker.active_requests - 1)
            last_error = f"Failed to reach worker for '{attempt_model}'"
            continue

        if streaming:
            async def sse_gen(w=worker, rid=req_id, q=q, m=attempt_model):
                try:
                    while True:
                        kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
                        if kind == "done":
                            usage = data if isinstance(data, dict) else {}
                            if consumer_user_id:
                                await db.consume_credits_for_usage(consumer_user_id, m, usage)
                            yield "data: [DONE]\n\n"
                            return
                        if kind == "error":
                            yield f'data: {{"error":"{data}"}}\n\n'
                            return
                        yield data
                except asyncio.TimeoutError:
                    yield 'data: {"error":"gateway timeout"}\n\n'

            return StreamingResponse(
                sse_gen(),
                media_type="text/event-stream",
                headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
            )

        # Non-streaming: wait for result; on worker error try next model in chain
        result_data = None
        got_error = False
        try:
            while True:
                kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
                if kind == "error":
                    worker.pending.pop(req_id, None)
                    last_error = str(data)
                    got_error = True
                    break
                if kind == "chunk":
                    result_data = json.loads(data)
                    break
                if kind == "done":
                    break
        except asyncio.TimeoutError:
            worker.pending.pop(req_id, None)
            last_error = f"Timeout on '{attempt_model}'"
            continue

        if got_error:
            continue  # try next model in chain

        if result_data is not None:
            return result_data

        raise HTTPException(502, "Empty response from worker")

    raise HTTPException(503, last_error)

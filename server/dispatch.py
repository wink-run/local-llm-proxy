import asyncio
import json
import os
import time
import uuid

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from worker_pool import pool

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))


async def handle_chat(body: dict, consumer_user_id: int | None = None):
    model = body.get("model", "")
    streaming = body.get("stream", False)

    # 消费积分检查（user_id 有值时）
    if consumer_user_id is not None:
        import database as db
        rate = await db.get_consume_rate(model)
        if rate is None:
            raise HTTPException(404, f"Model '{model}' not found or disabled")
        # 粗估：先检查余额是否 > 0，实际扣费在请求完成后（非阻塞乐观扣费）
        user = await db.get_user_by_id(consumer_user_id)
        if not user or user["credits_balance"] <= 0:
            raise HTTPException(402, "Insufficient credits")

    worker = pool.pick(model)
    if not worker:
        raise HTTPException(503, f"No worker available for model '{model}'")

    req_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue()
    worker.pending[req_id] = {
        "queue": q,
        "model": model,
        "dispatch_time": time.time(),
    }
    worker.active_requests += 1

    try:
        await worker.send({"type": "request", "req_id": req_id, "payload": body})
    except Exception:
        worker.pending.pop(req_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        raise HTTPException(502, "Failed to reach worker")

    if streaming:
        async def sse_gen():
            try:
                while True:
                    kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
                    if kind == "done":
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

    try:
        while True:
            kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
            if kind == "error":
                raise HTTPException(502, data)
            if kind == "chunk":
                return json.loads(data)
            if kind == "done":
                break
    except asyncio.TimeoutError:
        worker.pending.pop(req_id, None)
        raise HTTPException(504, "Gateway timeout")

    raise HTTPException(502, "Empty response from worker")

import asyncio
import hashlib
import json
import os
import time
import uuid

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

import database as db
from caveman import inject_caveman, VALID_LEVELS as CAVEMAN_VALID_LEVELS
from worker_pool import pool

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))


def _session_key(body: dict, consumer_user_id: int | None) -> str | None:
    """会话粘性键：同一用户 + 同一对话（首条 user 消息）尽量固定打到同一账号。"""
    if consumer_user_id is None:
        return None
    first_user = ""
    for m in body.get("messages") or []:
        if m.get("role") == "user":
            c = m.get("content")
            first_user = c if isinstance(c, str) else json.dumps(c, sort_keys=True)
            break
    digest = hashlib.sha256(f"{consumer_user_id}:{first_user}".encode()).hexdigest()[:16]
    return f"u{consumer_user_id}:{digest}"


async def handle_chat(body: dict, consumer_user_id: int | None = None, key_id: int | None = None):
    model = body.get("model", "")
    streaming = body.get("stream", False)

    # Build ordered list of models to try: scene route steps, then the requested model
    models_to_try: list[str] = []
    caveman_level: str | None = None
    if key_id is not None:
        scene = await db.get_scene_route_by_key(key_id)
        if scene:
            raw_steps = scene.get("steps", "[]")
            steps = json.loads(raw_steps) if isinstance(raw_steps, str) else raw_steps
            models_to_try = [s["model"] for s in steps if s.get("model")]
            caveman_level = scene.get("caveman_level")
    if not models_to_try:
        models_to_try = [model]

    # 该用户是否拥有可服务本次任一模型的个人供给源；有则用自己的订阅额度，跳过平台积分预检
    owns_personal = pool.has_owned_worker(models_to_try, consumer_user_id)

    # Credits check once before attempting any step（个人源用户豁免）
    if consumer_user_id is not None and not owns_personal:
        rate = None
        for m in models_to_try:
            rate = await db.get_or_ensure_consume_rate(m)
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

    session_key = _session_key(body, consumer_user_id)

    # Look up user's circle memberships for worker visibility
    user_circles: set[int] = set()
    if consumer_user_id is not None:
        user_circles = set(await db.get_user_circle_ids(consumer_user_id))

    last_error: str = "No worker available"
    for attempt_model in models_to_try:
        # 该模型下的候选账号（个人源优先 + 粘性 + 负载感知），逐个 failover
        cands = pool.candidates(attempt_model, model_type="chat",
                                session_key=session_key, owner_user_id=consumer_user_id,
                                user_circle_ids=user_circles)
        if not cands:
            last_error = f"No worker available for model '{attempt_model}'"
            continue

        for worker in cands:
            # 由本人个人源服务的请求免扣平台积分（用的是自己的订阅额度）
            served_by_own = (consumer_user_id is not None
                             and getattr(worker, "owner_user_id", None) == consumer_user_id)
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
            if caveman_level and caveman_level in CAVEMAN_VALID_LEVELS:
                dispatch_body["messages"] = list(dispatch_body.get("messages") or [])
                inject_caveman(dispatch_body, caveman_level)

            try:
                await worker.send({"type": "request", "req_id": req_id, "payload": dispatch_body})
            except Exception:
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                last_error = f"Failed to reach worker for '{attempt_model}'"
                continue  # 换下一个账号

            if streaming:
                # 已提交到该账号；流式无法中途换号，绑定粘性后直接返回。
                if session_key:
                    pool.bind_sticky(session_key, worker.worker_id)

                async def sse_gen(w=worker, rid=req_id, q=q, m=attempt_model, own=served_by_own):
                    try:
                        while True:
                            kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
                            if kind == "done":
                                usage = data if isinstance(data, dict) else {}
                                if consumer_user_id and not own:
                                    await db.consume_credits_for_usage(consumer_user_id, m, usage)
                                yield "data: [DONE]\n\n"
                                return
                            if kind == "error":
                                yield f'data: {json.dumps({"error": str(data)})}\n\n'
                                return
                            yield data
                    except asyncio.TimeoutError:
                        yield 'data: {"error":"gateway timeout"}\n\n'

                return StreamingResponse(
                    sse_gen(),
                    media_type="text/event-stream",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
                )

            # 非流式：等待结果；账号出错/超时则换下一个账号
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
                continue  # 换下一个账号

            if got_error:
                continue  # 换下一个账号

            if result_data is not None:
                # 非流式扣费集中在此（流式在 sse_gen 内）；本人个人源服务则豁免
                if consumer_user_id and not served_by_own:
                    await db.consume_credits_for_usage(
                        consumer_user_id, attempt_model, result_data.get("usage") or {}
                    )
                if session_key:
                    pool.bind_sticky(session_key, worker.worker_id)
                return result_data

            raise HTTPException(502, "Empty response from worker")

    raise HTTPException(503, last_error)

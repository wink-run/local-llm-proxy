import asyncio
import hashlib
import json
import logging
import os
import time
import uuid

from fastapi.responses import StreamingResponse

import database as db
from usage_utils import normalize_usage, usage_sse_chunk
from api_errors import (
    DispatchError,
    error_message_from_payload,
    openai_error_content,
    parse_worker_error,
    payload_has_openai_error,
    raise_dispatch_error,
    should_offline_contributor_model,
)
from caveman import inject_caveman, VALID_LEVELS as CAVEMAN_VALID_LEVELS
from worker_pool import pool, worker_has_model, worker_model_names, offline_contributor_model

logger = logging.getLogger("server")

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))
# P2P：首 token 超过该秒数则断开并返回超时错误
P2P_TTFT_TIMEOUT = int(os.getenv("P2P_TTFT_TIMEOUT", "20"))
P2P_TTFT_TIMEOUT_MSG = f"First token timeout ({P2P_TTFT_TIMEOUT}s)"


def _p2p_worker_summary(w) -> str:
    """单行 worker 摘要，便于转发日志检索。"""
    wid = getattr(w, "worker_id", "?")
    name = getattr(w, "name", "") or "-"
    uid = getattr(w, "owner_user_id", None)
    kind = "virtual" if str(wid).startswith("vw-") else "real"
    active = getattr(w, "active_requests", 0)
    return f"{wid}({name},{kind},uid={uid},load={active})"


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
            raise DispatchError(
                400,
                f"模型「{model}」未在后台启用或未配置消费率；请在管理端「模型配置」添加与 Worker 上报完全一致的模型名称。",
                "invalid_request_error",
            )
        user = await db.get_user_by_id(consumer_user_id)
        if not user or user["credits_balance"] <= 0:
            raise DispatchError(402, "Insufficient credits", "insufficient_credits")

    session_key = _session_key(body, consumer_user_id)

    # Look up user's circle memberships for worker visibility
    user_circles: set[int] = set()
    if consumer_user_id is not None:
        user_circles = set(await db.get_user_circle_ids(consumer_user_id))

    logger.info(
        "[p2p] chat start user=%s model=%s stream=%s route=%s circles=%s own_source=%s",
        consumer_user_id,
        model,
        streaming,
        models_to_try,
        sorted(user_circles),
        owns_personal,
    )

    last_error: str = "No worker available"
    for attempt_model in models_to_try:
        # 该模型下的候选账号（个人源优先 + 粘性 + 负载感知），逐个 failover
        cands = pool.candidates(attempt_model, model_type="chat",
                                session_key=session_key, owner_user_id=consumer_user_id,
                                user_circle_ids=user_circles)
        if not cands:
            last_error = f"No worker available for model '{attempt_model}'"
            logger.warning(
                "[p2p] no worker model=%s user=%s circles=%s",
                attempt_model, consumer_user_id, sorted(user_circles),
            )
            continue

        logger.info(
            "[p2p] candidates model=%s user=%s count=%d workers=%s",
            attempt_model,
            consumer_user_id,
            len(cands),
            [_p2p_worker_summary(w) for w in cands],
        )

        for worker in cands:
            # 防御：不向未声明该模型的 worker 派发（避免误路由后返回误导性网关错误）
            if not worker_has_model(worker, attempt_model):
                last_error = f"No worker available for model '{attempt_model}'"
                logger.warning(
                    "[p2p] skip worker model mismatch want=%s worker=%s has=%s",
                    attempt_model,
                    _p2p_worker_summary(worker),
                    sorted(worker_model_names(worker)),
                )
                continue
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
            # 流式 OpenAI 兼容 API 需 include_usage 才在末帧返回 token；上游不支持时会忽略
            if streaming and dispatch_body.get("stream") and not dispatch_body.get("stream_options"):
                dispatch_body["stream_options"] = {"include_usage": True}
            if caveman_level and caveman_level in CAVEMAN_VALID_LEVELS:
                dispatch_body["messages"] = list(dispatch_body.get("messages") or [])
                inject_caveman(dispatch_body, caveman_level)

            try:
                await worker.send({"type": "request", "req_id": req_id, "payload": dispatch_body})
                logger.info(
                    "[p2p] dispatch req=%s model=%s user=%s stream=%s worker=%s own=%s",
                    req_id[:8], attempt_model, consumer_user_id, streaming,
                    _p2p_worker_summary(worker), served_by_own,
                )
            except Exception as e:
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                last_error = f"Failed to reach worker for '{attempt_model}'"
                logger.warning(
                    "[p2p] send failed req=%s model=%s worker=%s err=%s",
                    req_id[:8], attempt_model, _p2p_worker_summary(worker), e,
                )
                continue  # 换下一个账号

            if streaming:
                # 已提交到该账号；流式无法中途换号，绑定粘性后直接返回。
                if session_key:
                    pool.bind_sticky(session_key, worker.worker_id)

                dispatched_at = worker.pending[req_id]["dispatch_time"]

                async def sse_gen(w=worker, rid=req_id, q=q, m=attempt_model, own=served_by_own, req_body=dispatch_body, t0=dispatched_at):
                    awaiting_first = True
                    try:
                        while True:
                            timeout = P2P_TTFT_TIMEOUT if awaiting_first else REQUEST_TIMEOUT
                            try:
                                kind, data = await asyncio.wait_for(q.get(), timeout=timeout)
                            except asyncio.TimeoutError:
                                w.pending.pop(rid, None)
                                w.active_requests = max(0, w.active_requests - 1)
                                msg = P2P_TTFT_TIMEOUT_MSG if awaiting_first else "Gateway timeout"
                                logger.warning(
                                    "[p2p] stream timeout req=%s model=%s worker=%s ttft=%s",
                                    rid[:8], m, _p2p_worker_summary(w), awaiting_first,
                                )
                                yield f"data: {json.dumps(openai_error_content(msg, 'timeout'))}\n\n"
                                return
                            if kind == "done":
                                usage = normalize_usage(data if isinstance(data, dict) else {}, req_body)
                                logger.info(
                                    "[p2p] stream done req=%s model=%s worker=%s tokens=%s own=%s",
                                    rid[:8], m, _p2p_worker_summary(w),
                                    usage.get("completion_tokens", 0), own,
                                )
                                # 客户端 sniff 常拿不到 input；补一帧 usage 再 [DONE]
                                if (usage.get("completion_tokens") or 0) > 0:
                                    yield usage_sse_chunk(usage, m)
                                if consumer_user_id and not own:
                                    await db.consume_credits_for_usage(consumer_user_id, m, usage)
                                yield "data: [DONE]\n\n"
                                return
                            if kind == "error":
                                err_str = str(data)
                                _, msg, etype = parse_worker_error(err_str)
                                logger.warning(
                                    "[p2p] stream error req=%s model=%s worker=%s type=%s msg=%s",
                                    rid[:8], m, _p2p_worker_summary(w), etype, msg,
                                )
                                if should_offline_contributor_model(err_str):
                                    await offline_contributor_model(w, m, err_str)
                                yield f"data: {json.dumps(openai_error_content(msg, etype))}\n\n"
                                return
                            if kind == "chunk":
                                if awaiting_first:
                                    ttft_ms = (time.time() - t0) * 1000
                                    logger.info(
                                        "[p2p] stream first_token req=%s model=%s worker=%s ttft_ms=%.0f",
                                        rid[:8], m, _p2p_worker_summary(w), ttft_ms,
                                    )
                                awaiting_first = False
                            yield data
                    except asyncio.TimeoutError:
                        w.pending.pop(rid, None)
                        w.active_requests = max(0, w.active_requests - 1)
                        logger.warning(
                            "[p2p] stream timeout req=%s model=%s worker=%s",
                            rid[:8], m, _p2p_worker_summary(w),
                        )
                        yield f"data: {json.dumps(openai_error_content('Gateway timeout', 'timeout'))}\n\n"

                return StreamingResponse(
                    sse_gen(),
                    media_type="text/event-stream",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
                )

            # 非流式：等待结果；账号出错/超时则换下一个账号
            result_data = None
            got_error = False
            awaiting_first = True
            dispatched_at = worker.pending[req_id]["dispatch_time"]
            try:
                while True:
                    timeout = P2P_TTFT_TIMEOUT if awaiting_first else REQUEST_TIMEOUT
                    try:
                        kind, data = await asyncio.wait_for(q.get(), timeout=timeout)
                    except asyncio.TimeoutError:
                        worker.pending.pop(req_id, None)
                        worker.active_requests = max(0, worker.active_requests - 1)
                        last_error = (
                            P2P_TTFT_TIMEOUT_MSG if awaiting_first
                            else f"Timeout on '{attempt_model}'"
                        )
                        logger.warning(
                            "[p2p] sync timeout req=%s model=%s worker=%s ttft=%s err=%s",
                            req_id[:8], attempt_model, _p2p_worker_summary(worker),
                            awaiting_first, last_error,
                        )
                        got_error = True
                        break
                    if kind == "error":
                        worker.pending.pop(req_id, None)
                        last_error = str(data)
                        logger.warning(
                            "[p2p] sync error req=%s model=%s worker=%s err=%s",
                            req_id[:8], attempt_model, _p2p_worker_summary(worker), last_error,
                        )
                        got_error = True
                        break
                    if kind == "chunk":
                        if awaiting_first:
                            ttft_ms = (time.time() - dispatched_at) * 1000
                            logger.info(
                                "[p2p] sync first_token req=%s model=%s worker=%s ttft_ms=%.0f",
                                req_id[:8], attempt_model, _p2p_worker_summary(worker), ttft_ms,
                            )
                        awaiting_first = False
                        try:
                            result_data = json.loads(data)
                        except Exception:
                            last_error = f"Invalid JSON from worker for '{attempt_model}'"
                            got_error = True
                            break
                        if payload_has_openai_error(result_data):
                            last_error = error_message_from_payload(result_data)
                            got_error = True
                            break
                        break
                    if kind == "done":
                        awaiting_first = False
                        break
            except asyncio.TimeoutError:
                worker.pending.pop(req_id, None)
                last_error = f"Timeout on '{attempt_model}'"
                continue  # 换下一个账号

            if got_error:
                if should_offline_contributor_model(last_error):
                    await offline_contributor_model(worker, attempt_model, last_error)
                continue  # 换下一个账号

            if result_data is not None:
                usage = normalize_usage(result_data.get("usage") or {}, dispatch_body)
                logger.info(
                    "[p2p] sync done req=%s model=%s worker=%s tokens=%s own=%s",
                    req_id[:8], attempt_model, _p2p_worker_summary(worker),
                    usage.get("completion_tokens", 0), served_by_own,
                )
                # 非流式扣费集中在此（流式在 sse_gen 内）；本人个人源服务则豁免
                if consumer_user_id and not served_by_own:
                    await db.consume_credits_for_usage(
                        consumer_user_id, attempt_model, usage,
                    )
                if session_key:
                    pool.bind_sticky(session_key, worker.worker_id)
                return result_data

            raise DispatchError(502, "Empty response from worker", "api_error")

    logger.warning(
        "[p2p] chat failed user=%s model=%s route=%s err=%s",
        consumer_user_id, model, models_to_try, last_error,
    )
    raise_dispatch_error(last_error)

"""Image generation dispatch — routes /v1/images/generations to Worker."""
import asyncio
import base64
import logging
import os
import time
import uuid
from pathlib import Path

from api_errors import DispatchError, raise_dispatch_error
import database as db
from worker_pool import pool

logger = logging.getLogger("server")

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))
IMG_CACHE_DIR = Path(__file__).resolve().parent / "static" / "img_cache"


async def handle_image(body: dict, consumer_user_id: int | None = None):
    model = body.get("model", "")
    n = int(body.get("n") or 1)
    response_format = body.get("response_format", "b64_json")

    logger.info(
        "[p2p] image start user=%s model=%s n=%s format=%s",
        consumer_user_id, model, n, response_format,
    )

    if consumer_user_id is not None:
        rate = await db.get_or_ensure_consume_rate(model, model_type="image")
        if rate is None:
            raise DispatchError(
                400,
                f"模型「{model}」未在后台启用或未配置消费率；"
                "请在管理端「模型配置」添加与 Worker 上报完全一致的模型名称。",
                "invalid_request_error",
            )
        user = await db.get_user_by_id(consumer_user_id)
        if not user or float(user["credits_balance"] or 0) <= 0:
            raise DispatchError(402, "Insufficient credits", "insufficient_credits")

    # 图像请求只路由到声明了 image 类型的 worker；虚拟 worker 是 chat 端点转发器、
    # 未实现图像生成，若被选中会把图像请求误发到 /chat/completions 并泄漏 active_requests，
    # 故在自增计数前直接排除（真实图像 worker 注册时已声明 type="image"，不受影响）。
    from virtual_worker import VirtualWorkerConnection
    cands = pool.candidates(model, model_type="image",
                            owner_user_id=consumer_user_id,
                            user_circle_ids=set())
    worker = cands[0] if cands else None
    if not worker or isinstance(worker, VirtualWorkerConnection):
        logger.warning(
            "[p2p] image no worker model=%s user=%s candidates=%d",
            model, consumer_user_id, len(cands),
        )
        raise DispatchError(
            503,
            f"No image-capable worker available for model '{model}'",
            "service_unavailable",
        )

    req_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue()
    worker.pending[req_id] = {
        "queue": q,
        "model": model,
        "dispatch_time": time.time(),
    }
    worker.active_requests += 1

    try:
        await worker.send({"type": "image_request", "req_id": req_id, "payload": body})
        logger.info(
            "[p2p] image dispatch req=%s model=%s user=%s worker=%s",
            req_id[:8], model, consumer_user_id, getattr(worker, "worker_id", "?"),
        )
    except Exception as e:
        worker.pending.pop(req_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        logger.warning(
            "[p2p] image send failed req=%s model=%s worker=%s err=%s",
            req_id[:8], model, getattr(worker, "worker_id", "?"), e,
        )
        raise DispatchError(502, "Failed to reach worker", "api_error")

    try:
        kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
    except asyncio.TimeoutError:
        worker.pending.pop(req_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        logger.warning(
            "[p2p] image timeout req=%s model=%s worker=%s",
            req_id[:8], model, getattr(worker, "worker_id", "?"),
        )
        raise DispatchError(504, "Gateway timeout", "timeout")

    if kind == "error":
        logger.warning(
            "[p2p] image error req=%s model=%s worker=%s err=%s",
            req_id[:8], model, getattr(worker, "worker_id", "?"), data,
        )
        raise_dispatch_error(str(data))

    images_raw: list[dict] = data if isinstance(data, list) else []
    created = int(time.time())
    result_items = []

    for img in images_raw:
        b64 = img.get("b64", "")
        revised = img.get("revised_prompt")
        if response_format == "url":
            img_path = IMG_CACHE_DIR / f"{uuid.uuid4().hex}.png"
            IMG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            img_path.write_bytes(base64.b64decode(b64))
            item = {"url": f"/static/img_cache/{img_path.name}"}
        else:
            item = {"b64_json": b64}
        if revised:
            item["revised_prompt"] = revised
        result_items.append(item)

    if consumer_user_id:
        weight = await db.get_image_tokens_weight()
        virtual_usage = {"completion_tokens": n * weight}
        await db.consume_credits_for_usage(consumer_user_id, model, virtual_usage)

    # active_requests / pending already cleaned up by server.py image_done handler;
    # only record stats here (does not touch ws state)
    worker.record_image_complete(model, n)
    logger.info(
        "[p2p] image done req=%s model=%s user=%s worker=%s n=%d",
        req_id[:8], model, consumer_user_id, getattr(worker, "worker_id", "?"), n,
    )

    return {"created": created, "data": result_items}

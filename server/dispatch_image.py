"""Image generation dispatch — routes /v1/images/generations to Worker."""
import asyncio
import base64
import logging
import os
import time
import uuid
from pathlib import Path

from api_errors import (
    DispatchError,
    raise_dispatch_error,
    should_offline_contributor_model,
)
import database as db
from worker_pool import pool, offline_contributor_model

logger = logging.getLogger("server")

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))
IMG_CACHE_DIR = Path(__file__).resolve().parent / "static" / "img_cache"


def _worker_summary(w) -> str:
    wid = getattr(w, "worker_id", "?")
    name = getattr(w, "name", "") or "-"
    kind = "virtual" if str(wid).startswith("vw-") else "real"
    return f"{wid}({name},{kind},load={getattr(w, 'active_requests', 0)})"


async def handle_image(body: dict, consumer_user_id: int | None = None,
                       sharer: str | None = None):
    model = body.get("model", "")
    n = int(body.get("n") or 1)
    response_format = body.get("response_format", "b64_json")

    logger.info(
        "[p2p] image start user=%s model=%s n=%s format=%s sharer=%s",
        consumer_user_id, model, n, response_format, sharer,
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

    # 圈子可见性（个人虚拟源 / 圈内真实节点）
    user_circles: set = set()
    if consumer_user_id is not None:
        user_circles = set(await db.get_user_circle_ids(consumer_user_id))

    # 图像请求：按有效类型选 image worker；冷却节点已下沉，逐个 failover
    cands = pool.candidates(
        model,
        model_type="image",
        owner_user_id=consumer_user_id,
        user_circle_ids=user_circles,
        sharer=sharer,
    )
    if not cands:
        logger.warning(
            "[p2p] image no worker model=%s user=%s",
            model, consumer_user_id,
        )
        raise DispatchError(
            503,
            f"No image-capable worker available for model '{model}'",
            "service_unavailable",
        )

    logger.info(
        "[p2p] image candidates model=%s user=%s count=%d workers=%s",
        model, consumer_user_id, len(cands),
        [_worker_summary(w) for w in cands],
    )

    last_error = f"No image-capable worker available for model '{model}'"
    tried_workers: list[str] = []
    last_failed_worker: str | None = None

    for worker in cands:
        wid = getattr(worker, "worker_id", "?")
        req_id = str(uuid.uuid4())
        q: asyncio.Queue = asyncio.Queue()
        worker.pending[req_id] = {
            "queue": q,
            "model": model,
            "dispatch_time": time.time(),
        }
        worker.active_requests += 1
        tried_workers.append(wid)

        try:
            await worker.send({"type": "image_request", "req_id": req_id, "payload": body})
            logger.info(
                "[p2p] image dispatch req=%s model=%s user=%s worker=%s",
                req_id[:8], model, consumer_user_id, _worker_summary(worker),
            )
        except Exception as e:
            worker.pending.pop(req_id, None)
            worker.active_requests = max(0, worker.active_requests - 1)
            last_error = f"Failed to reach worker: {e}"
            last_failed_worker = wid
            pool.note_cooldown(wid, model, last_error)
            logger.warning(
                "[p2p] image send failed req=%s model=%s worker=%s err=%s",
                req_id[:8], model, _worker_summary(worker), e,
            )
            continue  # 换下一个节点

        try:
            kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
        except asyncio.TimeoutError:
            worker.pending.pop(req_id, None)
            worker.active_requests = max(0, worker.active_requests - 1)
            last_error = "Gateway timeout"
            last_failed_worker = wid
            pool.note_cooldown(wid, model, last_error)
            logger.warning(
                "[p2p] image timeout req=%s model=%s worker=%s → failover",
                req_id[:8], model, _worker_summary(worker),
            )
            continue

        if kind == "error":
            last_error = str(data)
            last_failed_worker = wid
            pool.note_cooldown(wid, model, last_error)
            logger.warning(
                "[p2p] image error req=%s model=%s worker=%s err=%s → failover",
                req_id[:8], model, _worker_summary(worker), last_error,
            )
            if should_offline_contributor_model(last_error):
                await offline_contributor_model(worker, model, last_error)
            continue

        # ── 成功：清冷却、扣费、返回 ──────────────────────────────────────────
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

        # active_requests / pending already cleaned up by server.py image_done handler
        worker.record_image_complete(model, n)
        pool.clear_cooldown(wid, model)
        logger.info(
            "[p2p] image done req=%s model=%s user=%s worker=%s n=%d tried=%s",
            req_id[:8], model, consumer_user_id, _worker_summary(worker), n, tried_workers,
        )

        return {"created": created, "data": result_items}

    logger.warning(
        "[p2p] image failed user=%s model=%s err=%s workers=%s",
        consumer_user_id, model, last_error, tried_workers,
    )
    raise_dispatch_error(last_error, worker_id=last_failed_worker, workers=tried_workers)

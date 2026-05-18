"""Image generation dispatch — routes /v1/images/generations to Worker."""
import asyncio
import base64
import os
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

import database as db
from worker_pool import pool

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))
IMG_CACHE_DIR = Path(__file__).resolve().parent / "static" / "img_cache"


async def handle_image(body: dict, consumer_user_id: int | None = None):
    model = body.get("model", "")
    n = int(body.get("n") or 1)
    response_format = body.get("response_format", "b64_json")

    if consumer_user_id is not None:
        rate = await db.get_consume_rate(model)
        if rate is None:
            raise HTTPException(
                400,
                f"模型「{model}」未在后台启用或未配置消费率；"
                "请在管理端「模型配置」添加与 Worker 上报完全一致的模型名称。",
            )
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
        await worker.send({"type": "image_request", "req_id": req_id, "payload": body})
    except Exception:
        worker.pending.pop(req_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        raise HTTPException(502, "Failed to reach worker")

    try:
        kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
    except asyncio.TimeoutError:
        worker.pending.pop(req_id, None)
        worker.active_requests = max(0, worker.active_requests - 1)
        raise HTTPException(504, "Gateway timeout")

    if kind == "error":
        raise HTTPException(502, data)

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

    worker.record_image_complete(model, n)
    worker.active_requests = max(0, worker.active_requests - 1)
    worker.pending.pop(req_id, None)

    return {"created": created, "data": result_items}

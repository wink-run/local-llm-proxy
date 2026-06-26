import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles

import database as db
from admin_router import router as admin_router
from catalog import PROVIDER_CATALOG, TIERS
from device_router import router as device_router
from auth import get_current_user_id
from dispatch import handle_chat
from dispatch_image import handle_image
from settler import run_settler
from user_router import router as user_router
from scene_router import router as scene_router
from provider_router import router as provider_router
from config_router import router as config_router
from circle_router import router as circle_router
from worker_pool import pool, WorkerConnection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("server")

BASE_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = BASE_DIR / "static" / "downloads"

_bearer = HTTPBearer(auto_error=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    logger.info("Database ready")
    from config_seed import seed_default_configs
    await seed_default_configs()
    logger.info("Default config seeded (if empty)")
    from admin_router import _sync_virtual_pool
    await _sync_virtual_pool()
    logger.info("Virtual agents synced")
    _cleanup_img_cache()
    task = asyncio.create_task(run_settler())
    yield
    task.cancel()


# landing 页产品截图，需长期保留
_LANDING_SCREENSHOTS = frozenset({
    "dashboard.webp", "gateway.webp", "provider.webp",
    "dashboard_en.webp", "gateway_en.webp", "provider_en.webp",
})


def _cleanup_img_cache() -> None:
    """Delete img_cache files older than 1 hour on startup."""
    from dispatch_image import IMG_CACHE_DIR
    if not IMG_CACHE_DIR.is_dir():
        return
    cutoff = time.time() - 3600
    for p in IMG_CACHE_DIR.iterdir():
        if p.name in _LANDING_SCREENSHOTS:
            continue
        if p.is_file() and p.stat().st_mtime < cutoff:
            try:
                p.unlink()
            except OSError:
                pass


app = FastAPI(title="LLM Proxy", lifespan=lifespan)
# CORS：直连 8000 / 开发调试；经 nginx HTTPS 反代时由 nginx 统一加头（见 default.conf.template）
_cors_raw = os.getenv("CORS_ORIGINS", "*").strip()
_cors_origins = ["*"] if _cors_raw in ("", "*") else [o.strip() for o in _cors_raw.split(",") if o.strip()]
# 与 allow_origins=["*"] 二选一，避免同时回显 Origin 与 * 导致重复头
_cors_use_wildcard = "*" in _cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=None if _cors_use_wildcard else r"https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)
app.include_router(admin_router, prefix="/admin")
app.include_router(user_router, prefix="/user")
app.include_router(scene_router, prefix="/user")
app.include_router(provider_router, prefix="/user")   # 个人供给源 /user/providers + /user/oauth/claude/*
app.include_router(config_router, prefix="/api")   # GET /api/config/tools|routes (user JWT)
app.include_router(circle_router, prefix="/user")
                                                    # PUT/DELETE /api/config/tools|routes (admin)
app.include_router(device_router, tags=["device"])


# ── 静态文件 & 落地页 ─────────────────────────────────────────────────────────

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """避免浏览器默认请求 favicon 触发 404。"""
    from fastapi.responses import Response
    return Response(status_code=204)


@app.get("/")
async def landing():
    return FileResponse("static/landing.html")


@app.get("/app")
async def user_app():
    return FileResponse("static/app.html")


@app.get("/wall")
async def wall_page():
    return FileResponse("static/wall.html")


@app.get("/api/catalog")
async def public_catalog():
    """公开接口：供给源目录（客户端启动时拉取，离线则用内置兜底）"""
    return {"tiers": TIERS, "providers": PROVIDER_CATALOG}


@app.get("/api/rates")
async def public_rates():
    """公开接口：模型汇率 + 跨层折算矩阵"""
    all_models = await db.list_model_configs()
    enabled = [m for m in all_models if m.get("enabled")]

    model_list = [
        {
            "name": m["name"],
            "display_name": m.get("display_name") or m["name"],
            "tier": m["tier"],
            "contribute_rate": m["contribute_rate"],
            "consume_rate": m["consume_rate"],
        }
        for m in enabled
    ]

    # 按 tier 分组，计算每层的平均贡献率 / 消费率
    tier_stats: dict[str, dict] = {}
    for m in enabled:
        t = m["tier"]
        s = tier_stats.setdefault(t, {"contribute": [], "consume": []})
        s["contribute"].append(m["contribute_rate"])
        s["consume"].append(m["consume_rate"])

    tiers = {}
    for t, s in tier_stats.items():
        avg_c = sum(s["contribute"]) / len(s["contribute"])
        avg_x = sum(s["consume"])    / len(s["consume"])
        tiers[t] = {"avg_contribute_rate": round(avg_c, 2),
                    "avg_consume_rate":    round(avg_x, 2)}

    # 跨层折算矩阵：贡献 tier A 的 1K tokens 能消耗 tier B 的多少 K tokens
    # exchange[from_tier][to_tier] = avg_contribute_rate(A) / avg_consume_rate(B)
    exchange: dict[str, dict] = {}
    for from_tier, fs in tiers.items():
        exchange[from_tier] = {}
        for to_tier, ts in tiers.items():
            ratio = round(fs["avg_contribute_rate"] / ts["avg_consume_rate"], 2) if ts["avg_consume_rate"] else 0
            exchange[from_tier][to_tier] = ratio

    return {"models": model_list, "tiers": tiers, "exchange": exchange}


@app.get("/api/wall")
async def wall():
    users = await db.get_wall_users()
    return {"users": users}


def _mask_name(name: str) -> str:
    """T***r 脱敏：保留首尾字符，中间用星号"""
    if not name:
        return "***"
    if len(name) <= 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 2) + name[-1]


def _stars(multiplier: float) -> int:
    if multiplier >= 1.3: return 5
    if multiplier >= 1.1: return 4
    if multiplier >= 0.9: return 3
    if multiplier >= 0.7: return 2
    return 1


def _worker_row(w) -> dict:
    stats = w.period_stats
    total_req = sum(s["requests"] for s in stats.values())
    total_success = sum(s["success"] for s in stats.values())
    total_ttft = sum(s.get("ttft_sum", 0) for s in stats.values())
    total_ttft_count = sum(s.get("ttft_count", 0) for s in stats.values())
    total_tokens = sum(s["output_tokens"] for s in stats.values())
    avg_ttft_ms = total_ttft / total_ttft_count if total_ttft_count > 0 else 0
    success_rate = total_success / total_req if total_req > 0 else 1.0
    online_mins = w.period_online_mins()
    multiplier = 1.0
    if total_req > 0:
        online_f = min(0.5 + 0.8 * min(online_mins / 5, 1.0), 1.3)
        latency_f = max(0.6, min(1.5, 500 / avg_ttft_ms)) if avg_ttft_ms > 0 else 1.0
        stability_f = 0.5 + 0.7 * success_rate
        multiplier = round(max(0.5, min(1.5, 0.4 * online_f + 0.4 * latency_f + 0.2 * stability_f)), 3)
    return {
        "worker_id": w.worker_id,
        "name": _mask_name(w.name),
        "models": w.models,
        "active_requests": w.active_requests,
        "period_tokens": total_tokens,
        "avg_latency_ms": round(avg_ttft_ms),
        "multiplier": multiplier,
        "stars": _stars(multiplier),
        "online_mins": round(online_mins, 1),
        "connected_at": w.connected_at.isoformat(),
    }


@app.get("/api/workers-wall")
async def workers_wall():
    """公开接口：大屏展示用，脱敏后返回在线 Worker 列表"""
    rows = [_worker_row(w) for w in pool.all_workers()]
    return {"workers": rows, "total": len(rows)}


@app.get("/public/network")
async def public_network():
    """公开：全局运营统计 + 在线 Worker 列表（脱敏）"""
    all_ws = pool.all_workers()   # capture once
    workers_data = [_worker_row(w) for w in all_ws]
    distinct_users = len({w.user_id for w in all_ws if w.user_id})
    return {
        "summary": {
            "online_workers": len(workers_data),
            "active_users": distinct_users,
        },
        "workers": workers_data,
    }


@app.get("/api/agent-downloads")
async def agent_downloads():
    items: list[dict] = []
    if not DOWNLOADS_DIR.is_dir():
        return {"items": items}
    root = DOWNLOADS_DIR.resolve()
    for p in sorted(DOWNLOADS_DIR.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.parent.resolve() != root:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        items.append({"filename": p.name, "url": f"/download/llm-agent/{p.name}", "bytes": st.st_size})
    return {"items": items}


@app.get("/download/llm-agent/{filename}")
async def download_agent(filename: str):
    safe = Path(filename).name
    if not safe or safe != filename:
        raise HTTPException(400, "Invalid filename")
    path = DOWNLOADS_DIR / safe
    if not path.is_file() or path.parent.resolve() != DOWNLOADS_DIR.resolve():
        raise HTTPException(404, "Not found")
    return FileResponse(path, filename=safe, media_type="application/octet-stream",
                        content_disposition_type="attachment")


app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Worker WebSocket ──────────────────────────────────────────────────────────

@app.websocket("/ws/worker")
async def worker_ws(ws: WebSocket):
    await ws.accept()
    peer = ws.client  # (host, port)，便于排查来源
    logger.info("[worker/ws] connected peer=%s path=/ws/worker", peer)
    worker: Optional[WorkerConnection] = None
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
        msg = json.loads(raw)

        if msg.get("type") != "register":
            logger.warning(
                "[worker/ws] register denied peer=%s reason=bad_message_type",
                peer,
            )
            await ws.close(code=4001, reason="Unauthorized")
            return

        worker_key = (msg.get("worker_key") or "").strip()
        if not worker_key:
            logger.warning(
                "[worker/ws] register denied peer=%s reason=missing_worker_key",
                peer,
            )
            await ws.close(code=4001, reason="Unauthorized")
            return

        user = await db.get_user_by_worker_key(worker_key)
        if not user:
            logger.warning(
                "[worker/ws] register denied peer=%s reason=unknown_worker_key",
                peer,
            )
            await ws.close(code=4001, reason="Unauthorized")
            return

        user_id = user["id"]

        worker_id = str(uuid.uuid4())[:8]
        name = (msg.get("name") or "").strip() or f"worker-{worker_id}"
        raw_models = msg.get("models", [])
        models = []
        model_types: dict[str, str] = {}
        for entry in raw_models:
            if isinstance(entry, str):
                name = entry.strip()
                if name:
                    models.append(name)
                    model_types[name] = "chat"
            elif isinstance(entry, dict):
                name = (entry.get("name") or "").strip()
                mtype = entry.get("type", "chat")
                if name and mtype in ("chat", "image"):
                    models.append(name)
                    model_types[name] = mtype

        # 首次出现的模型名自动写入 model_configs（open + 默认倍率），便于计费与列表一致
        auto_models = await db.ensure_default_open_models(models, model_types)
        if auto_models:
            logger.info(
                "[worker/ws] auto-created model_configs (open defaults): %s",
                auto_models,
            )

        # Optional circle scope: worker can declare which circle(s) it contributes to
        circle_ids_raw = msg.get("circle_ids") or []
        if not circle_ids_raw and msg.get("circle_id") is not None:
            circle_ids_raw = [msg.get("circle_id")]
        worker_circle_ids_list: list[int] = []
        for cid_raw in circle_ids_raw:
            try:
                cid = int(cid_raw)
                if await db.is_circle_member(cid, user_id):
                    worker_circle_ids_list.append(cid)
            except (ValueError, TypeError):
                pass
        # 去重并保持顺序
        worker_circle_ids_list = list(dict.fromkeys(worker_circle_ids_list))

        worker = WorkerConnection(
            ws=ws, models=models, worker_id=worker_id,
            name=name, user_id=user_id,
            model_types=model_types,
            circle_id=worker_circle_ids_list[0] if len(worker_circle_ids_list) == 1 else None,
            circle_ids=worker_circle_ids_list,
        )
        pool.add(worker)
        await ws.send_text(json.dumps({"type": "registered", "worker_id": worker_id}))
        logger.info(
            "[worker/ws] online peer=%s worker_id=%s name=%s user_id=%s models=%s",
            peer,
            worker_id,
            name,
            user_id,
            models,
        )

        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            req_id = msg.get("req_id")
            if not req_id or req_id not in worker.pending:
                continue

            entry = worker.pending[req_id]
            q = entry["queue"]
            kind = msg.get("type")

            if kind == "chunk":
                # 首包到达时间 = 首 Token 延迟（TTFT）；非流式单次 body 也在首 chunk 时记一次
                if entry.get("ttft_ms") is None:
                    entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                await q.put(("chunk", msg.get("data", "")))

            elif kind == "image_done":
                images = msg.get("images", [])
                await q.put(("done", images))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)

            elif kind == "done":
                # 附带 usage，供流式响应结束时扣积分（与 Agent done 消息一致）
                usage_done = msg.get("usage") or {}
                await q.put(("done", usage_done))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                # 周期统计：成功请求用 TTFT；若从未收到 chunk（异常）则用总耗时
                usage = msg.get("usage") or {}
                output_tokens = int(
                    usage.get("completion_tokens") or usage.get("output_tokens") or 0
                )
                ttft_ms = entry.get("ttft_ms")
                if ttft_ms is None:
                    ttft_ms = (time.time() - entry["dispatch_time"]) * 1000
                worker.record_complete(entry["model"], output_tokens, True, ttft_ms)

            elif kind == "error":
                await q.put(("error", msg.get("error", "worker error")))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                # 失败请求不参与首 Token 平均
                worker.record_complete(entry["model"], 0, False, None)

    except WebSocketDisconnect:
        if worker is None:
            logger.info("[worker/ws] disconnected before register peer=%s", peer)
    except asyncio.TimeoutError:
        logger.warning("[worker/ws] registration timeout peer=%s", peer)
        try:
            await ws.close(code=4008, reason="Registration timeout")
        except Exception:
            pass
    except Exception as e:
        logger.error(
            "[worker/ws] error peer=%s worker_id=%s: %s",
            peer,
            worker.worker_id if worker else None,
            e,
        )
        if worker is None:
            try:
                await ws.close(code=1011, reason="Registration failed")
            except Exception:
                pass
    finally:
        if worker:
            pool.remove(worker)
            for entry in worker.pending.values():
                await entry["queue"].put(("error", "worker disconnected"))
            worker.pending.clear()
            logger.info(
                "[worker/ws] offline peer=%s worker_id=%s name=%s",
                peer,
                worker.worker_id,
                worker.name,
            )


# ── 网关使用上报 ──────────────────────────────────────────────────────────────

class GatewayUsageReport(BaseModel):
    model: str = ""
    tokens: int = 0
    tier: str = "free"        # free | paid
    provider_id: str = ""


@app.post("/api/gateway/record-usage")
async def gateway_record_usage(
    req: GatewayUsageReport,
    uid: int = Depends(get_current_user_id),
):
    """Gateway reports free/paid-direct calls so they appear in dashboard stats."""
    if req.tokens < 0:
        raise HTTPException(400, "tokens must be >= 0")
    await db.record_gateway_usage(
        user_id=uid,
        model_name=req.model,
        tokens=req.tokens,
        tier=req.tier,
        provider_id=req.provider_id,
    )
    return {"ok": True}


# ── 用户 LLM 接口 ─────────────────────────────────────────────────────────────

async def auth_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    """验证用户 API Key，返回 (key_info_dict)"""
    if not creds:
        raise HTTPException(401, "Missing API key")
    info = await db.verify_key(creds.credentials)
    if not info:
        raise HTTPException(401, "Invalid or disabled API key")
    return info


@app.get("/v1/models")
async def list_models(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    # 支持 API Key 或 JWT 两种鉴权方式
    uid: Optional[int] = None
    if creds:
        info = await db.verify_key(creds.credentials)
        if info:
            uid = info.get("user_id")
        else:
            from auth import decode_token
            uid = decode_token(creds.credentials)
    circle_ids = set(await db.get_user_circle_ids(uid)) if uid else set()
    model_types = pool.models_for_user(owner_user_id=uid, user_circle_ids=circle_ids)
    circle_model_map = pool.circle_model_ids_for_user(owner_user_id=uid, user_circle_ids=circle_ids)
    # Build circle_id -> circle_name lookup
    circle_names: dict[int, str] = {}
    for cid in set(circle_model_map.values()):
        c = await db.get_circle_by_id(cid)
        if c:
            circle_names[cid] = c["name"]
    data = []
    for m in sorted(model_types):
        entry = {"id": m, "object": "model", "created": 0, "owned_by": "local",
                 "model_type": model_types.get(m, "chat")}
        cid = circle_model_map.get(m)
        if cid is not None:
            entry["circle_id"]   = cid
            entry["circle_name"] = circle_names.get(cid, "")
        data.append(entry)
    return {"object": "list", "data": data}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    resp = await handle_chat(body, consumer_user_id=consumer_user_id, key_id=key_info.get("id"))
    # 扣费（含个人源豁免）统一在 dispatch.handle_chat 内完成，避免双重扣费
    return resp


@app.post("/v1/images/generations")
async def image_generations(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    return await handle_image(body, consumer_user_id=consumer_user_id)


# ── Anthropic Messages API (/v1/messages) ────────────────────────────────────

async def _auth_anthropic(request: Request) -> dict:
    """Accept x-api-key (Anthropic style) or Authorization: Bearer."""
    api_key = request.headers.get("x-api-key") or request.headers.get("X-Api-Key")
    if not api_key:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            api_key = auth[7:]
    if not api_key:
        raise HTTPException(401, "Missing API key")
    info = await db.verify_key(api_key)
    if not info:
        raise HTTPException(401, "Invalid or disabled API key")
    return info


def _anthropic_to_openai(body: dict) -> dict:
    """Anthropic Messages request → OpenAI Chat Completions request."""
    messages = list(body.get("messages", []))
    if body.get("system"):
        messages = [{"role": "system", "content": body["system"]}] + messages
    oai: dict = {
        "model": body.get("model", ""),
        "messages": messages,
        "stream": body.get("stream", False),
    }
    for key, oai_key in [("max_tokens", "max_tokens"), ("temperature", "temperature"),
                          ("top_p", "top_p")]:
        if key in body:
            oai[oai_key] = body[key]
    if "stop_sequences" in body:
        oai["stop"] = body["stop_sequences"]
    return oai


def _openai_to_anthropic(oai: dict, model: str) -> dict:
    """OpenAI Chat Completions response → Anthropic Messages response."""
    choice = (oai.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    finish = choice.get("finish_reason", "stop")
    stop_reason = "end_turn" if finish in ("stop", None) else finish
    usage = oai.get("usage") or {}
    return {
        "id": oai.get("id", "msg_" + uuid.uuid4().hex[:24]),
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


@app.post("/v1/messages")
async def messages(request: Request, key_info: dict = Depends(_auth_anthropic)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    model = body.get("model", "")
    streaming = body.get("stream", False)

    oai_body = _anthropic_to_openai(body)
    resp = await handle_chat(oai_body, consumer_user_id=consumer_user_id, key_id=key_info.get("id"))

    if streaming:
        msg_id = "msg_" + uuid.uuid4().hex[:24]

        async def anthropic_sse():
            yield (
                f'event: message_start\ndata: {{"type":"message_start","message":{{"id":"{msg_id}",'
                f'"type":"message","role":"assistant","content":[],"model":"{model}",'
                f'"stop_reason":null,"stop_sequence":null,"usage":{{"input_tokens":0,"output_tokens":0}}}}}}\n\n'
            )
            yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
            yield 'event: ping\ndata: {"type":"ping"}\n\n'

            output_tokens = 0
            async for chunk in resp.body_iterator:
                if isinstance(chunk, bytes):
                    chunk = chunk.decode()
                for line in chunk.splitlines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        continue
                    try:
                        oai_chunk = json.loads(data_str)
                    except Exception:
                        continue
                    delta = (oai_chunk.get("choices") or [{}])[0].get("delta") or {}
                    text = delta.get("content") or ""
                    finish = (oai_chunk.get("choices") or [{}])[0].get("finish_reason")
                    if text:
                        output_tokens += 1
                        yield f'event: content_block_delta\ndata: {{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":{json.dumps(text)}}}}}\n\n'
                    if finish:
                        stop_reason = "end_turn" if finish == "stop" else finish
                        yield f'event: content_block_stop\ndata: {{"type":"content_block_stop","index":0}}\n\n'
                        yield f'event: message_delta\ndata: {{"type":"message_delta","delta":{{"stop_reason":"{stop_reason}","stop_sequence":null}},"usage":{{"output_tokens":{output_tokens}}}}}\n\n'
                        yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

        return StreamingResponse(
            anthropic_sse(),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    # Non-streaming: 扣费已在 dispatch.handle_chat 内完成（含个人源豁免），此处仅转换格式
    return _openai_to_anthropic(resp, model)

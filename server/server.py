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
from fastapi.responses import FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles

import database as db
from admin_router import router as admin_router
from dispatch import handle_chat
from settler import run_settler
from user_router import router as user_router
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
    task = asyncio.create_task(run_settler())
    yield
    task.cancel()


app = FastAPI(title="LLM Proxy", lifespan=lifespan)
app.include_router(admin_router, prefix="/admin")
app.include_router(user_router, prefix="/user")


# ── 静态文件 & 落地页 ─────────────────────────────────────────────────────────

@app.get("/")
async def landing():
    return FileResponse("static/landing.html")


@app.get("/app")
async def user_app():
    return FileResponse("static/app.html")


@app.get("/wall")
async def wall_page():
    return FileResponse("static/wall.html")


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


@app.get("/api/workers-wall")
async def workers_wall():
    """公开接口：大屏展示用，脱敏后返回在线 Worker 列表"""
    rows = []
    for w in pool.all_workers():
        stats = w.period_stats
        total_req = sum(s["requests"] for s in stats.values())
        total_success = sum(s["success"] for s in stats.values())
        total_latency = sum(s["latency_sum"] for s in stats.values())
        total_tokens = sum(s["output_tokens"] for s in stats.values())

        avg_latency = total_latency / total_req if total_req > 0 else 0
        success_rate = total_success / total_req if total_req > 0 else 1.0
        online_mins = w.period_online_mins()

        # 简单估算当前质量分
        multiplier = 1.0
        if total_req > 0:
            online_f = min(0.5 + 0.8 * min(online_mins / 5, 1.0), 1.3)
            latency_f = max(0.6, min(1.5, 500 / avg_latency)) if avg_latency > 0 else 1.0
            stability_f = 0.5 + 0.7 * success_rate
            multiplier = round(max(0.5, min(1.5, 0.4 * online_f + 0.4 * latency_f + 0.2 * stability_f)), 3)

        rows.append({
            "worker_id": w.worker_id,
            "name": _mask_name(w.name),
            "models": w.models,
            "active_requests": w.active_requests,
            "period_tokens": total_tokens,
            "avg_latency_ms": round(avg_latency),
            "multiplier": multiplier,
            "stars": _stars(multiplier),
            "online_mins": round(online_mins, 1),
            "connected_at": w.connected_at.isoformat(),
        })
    return {"workers": rows, "total": len(rows)}


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
        models = [m.strip() for m in msg.get("models", []) if m.strip()]

        worker = WorkerConnection(
            ws=ws, models=models, worker_id=worker_id,
            name=name, user_id=user_id,
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
                await q.put(("chunk", msg.get("data", "")))

            elif kind == "done":
                await q.put(("done", None))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                # 记录周期统计
                usage = msg.get("usage") or {}
                output_tokens = int(
                    usage.get("completion_tokens") or usage.get("output_tokens") or 0
                )
                latency_ms = (time.time() - entry["dispatch_time"]) * 1000
                worker.record_complete(entry["model"], output_tokens, True, latency_ms)

            elif kind == "error":
                await q.put(("error", msg.get("error", "worker error")))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                latency_ms = (time.time() - entry["dispatch_time"]) * 1000
                worker.record_complete(entry["model"], 0, False, latency_ms)

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
async def list_models(key_info: dict = Depends(auth_user)):
    # Worker 上报的模型名须与后台 model_configs 一致才会计费；仅对用户 Key 过滤列表，避免出现「列表里有、调用却 404」
    online = pool.all_models()
    if key_info.get("user_id") is not None:
        online = await db.models_enabled_for_billing(online)
    return {
        "object": "list",
        "data": [
            {"id": m, "object": "model", "created": 0, "owned_by": "local"}
            for m in online
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    resp = await handle_chat(body, consumer_user_id=consumer_user_id)

    # 非流式：异步扣费（已从 handle_chat 拿到响应）
    if consumer_user_id and isinstance(resp, dict):
        model = body.get("model", "")
        usage = resp.get("usage") or {}
        total_tokens = int(
            (usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
            + (usage.get("completion_tokens") or usage.get("output_tokens") or 0)
        )
        if total_tokens > 0:
            rate = await db.get_consume_rate(model)
            if rate:
                cost = total_tokens / 1000 * rate
                await db.deduct_credits(consumer_user_id, cost, model_name=model, tokens=total_tokens)

    return resp

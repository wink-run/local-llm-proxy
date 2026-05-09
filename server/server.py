import asyncio
import json
import logging
import os
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
from worker_pool import pool, WorkerConnection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("server")

WORKER_TOKEN = os.getenv("WORKER_TOKEN", "change-me-worker")

# 落地页可下载的 PyInstaller 产物目录（agent/build.sh 后复制至此）
BASE_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = BASE_DIR / "static" / "downloads"

_bearer = HTTPBearer()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    logger.info("Database ready")
    yield


app = FastAPI(title="LLM Proxy", lifespan=lifespan)
app.include_router(admin_router, prefix="/admin")


@app.get("/")
async def landing_page():
    """项目介绍落地页（静态 HTML）。"""
    return FileResponse("static/landing.html")


@app.get("/api/agent-downloads")
async def list_agent_downloads():
    """列出 static/downloads/ 下可供下载的 llm-agent 构建文件。"""
    items: list[dict] = []
    if not DOWNLOADS_DIR.is_dir():
        return {"items": items}
    root = DOWNLOADS_DIR.resolve()
    for p in sorted(DOWNLOADS_DIR.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.name.upper().startswith("README"):
            continue
        if p.parent.resolve() != root:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        items.append({
            "filename": p.name,
            "url": f"/download/llm-agent/{p.name}",
            "bytes": st.st_size,
        })
    return {"items": items}


@app.get("/download/llm-agent/{filename}")
async def download_llm_agent(filename: str):
    """以附件形式下载，避免浏览器误判类型。"""
    safe = Path(filename).name
    if not safe or safe != filename:
        raise HTTPException(400, "Invalid filename")
    path = DOWNLOADS_DIR / safe
    root = DOWNLOADS_DIR.resolve()
    if not path.is_file() or path.parent.resolve() != root:
        raise HTTPException(404, "Not found")
    return FileResponse(
        path,
        filename=safe,
        media_type="application/octet-stream",
        content_disposition_type="attachment",
    )


app.mount("/static", StaticFiles(directory="static"), name="static")


async def auth_user(creds: HTTPAuthorizationCredentials = Depends(_bearer)):
    if not await db.verify_key(creds.credentials):
        raise HTTPException(401, "Invalid API key")


@app.websocket("/ws/worker")
async def worker_ws(ws: WebSocket):
    await ws.accept()
    worker: Optional[WorkerConnection] = None
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
        msg = json.loads(raw)

        if msg.get("type") != "register" or msg.get("token") != WORKER_TOKEN:
            await ws.close(code=4001, reason="Unauthorized")
            return

        worker_id = str(uuid.uuid4())[:8]
        name = (msg.get("name") or "").strip() or f"worker-{worker_id}"
        models = [m.strip() for m in msg.get("models", []) if m.strip()]

        worker = WorkerConnection(ws=ws, models=models, worker_id=worker_id, name=name)
        pool.add(worker)
        await ws.send_text(json.dumps({"type": "registered", "worker_id": worker_id}))
        logger.info(f"Worker online: {name} ({worker_id}) models={models}")

        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            req_id = msg.get("req_id")
            if not req_id or req_id not in worker.pending:
                continue

            q = worker.pending[req_id]
            kind = msg.get("type")
            if kind == "chunk":
                await q.put(("chunk", msg.get("data", "")))
            elif kind == "done":
                await q.put(("done", None))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
            elif kind == "error":
                await q.put(("error", msg.get("error", "worker error")))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)

    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        logger.warning("Worker registration timeout")
    except Exception as e:
        logger.error(f"Worker WS error: {e}")
    finally:
        if worker:
            pool.remove(worker)
            for q in worker.pending.values():
                await q.put(("error", "worker disconnected"))
            worker.pending.clear()
            logger.info(f"Worker offline: {worker.name} ({worker.worker_id})")


@app.get("/v1/models", dependencies=[Depends(auth_user)])
async def list_models():
    return {
        "object": "list",
        "data": [
            {"id": m, "object": "model", "created": 0, "owned_by": "local"}
            for m in pool.all_models()
        ],
    }


@app.post("/v1/chat/completions", dependencies=[Depends(auth_user)])
async def chat_completions(request: Request):
    return await handle_chat(await request.json())

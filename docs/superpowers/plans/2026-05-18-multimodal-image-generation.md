# Multimodal Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/v1/images/generations` (OpenAI-compatible) to the proxy, routing requests to Worker image models via WebSocket, with per-image credit billing (1 image = 2000 virtual tokens).

**Architecture:** New `dispatch_image.py` handles image requests independently from chat dispatch. `WorkerConnection` gains `model_types: dict[str, str]` so a single worker can register both chat and image models. Credits deducted via existing `consume_credits_for_usage` using virtual token count.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, existing WebSocket worker protocol.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `server/worker_pool.py` | Add `model_types`, update `pick()` with `model_type` param |
| Modify | `server/database.py` | Migration: `model_configs.model_type` column + `image_tokens_weight` config |
| Modify | `server/server.py` | `POST /v1/images/generations` endpoint + lifespan img_cache cleanup |
| Create | `server/dispatch_image.py` | Image request dispatch, base64↔URL handling, billing |
| Modify | `server/settler.py` | Recognize `image_count` stat key for contribution settlement |
| Modify | `server/admin_router.py` | Pass `model_type` in model config CRUD |
| Create | `server/static/img_cache/.gitkeep` | Ensure directory exists, excluded from git |
| Create | `tests/mock_image_llm.py` | Mock image worker for manual integration testing |

---

## Task 1: WorkerPool — model_types support

**Files:**
- Modify: `server/worker_pool.py`

- [ ] **Step 1: Update `WorkerConnection` dataclass**

Replace lines 13–27 in `server/worker_pool.py`:

```python
@dataclass
class WorkerConnection:
    ws: object
    models: list          # list[str] — model names, for display/compatibility
    worker_id: str
    name: str
    model_types: dict = field(default_factory=dict)  # {model_name: "chat"|"image"}
    user_id: Optional[int] = None
    connected_at: datetime = field(default_factory=datetime.now)
    active_requests: int = 0
    pending: dict = field(default_factory=dict)
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    period_start: float = field(default_factory=time.time)
    period_stats: dict = field(default_factory=dict)
```

- [ ] **Step 2: Update `WorkerPool.pick()` to accept `model_type`**

Replace the `pick` method (lines 99–105):

```python
def pick(self, model: str, model_type: str = "chat") -> Optional[WorkerConnection]:
    """Real workers first; fall back to virtual. Filters by model name AND type."""
    real = [
        w for w in self._workers
        if model in w.models and w.model_types.get(model, "chat") == model_type
    ]
    if real:
        return random.choice(real)
    virtual = [
        v for v in self._virtual
        if model in v.models and v.model_types.get(model, "chat") == model_type
    ]
    return random.choice(virtual) if virtual else None
```

- [ ] **Step 3: Commit**

```bash
git add server/worker_pool.py
git commit -m "feat(worker): add model_types field and model_type param to pool.pick()"
```

---

## Task 2: Worker registration — parse new models format

**Files:**
- Modify: `server/server.py` (lines 268–271, the models parsing block)

- [ ] **Step 1: Replace model list parsing in `worker_ws`**

Find this block in `server/server.py` (around line 268):
```python
models = [m.strip() for m in msg.get("models", []) if m.strip()]
```

Replace with:
```python
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
```

- [ ] **Step 2: Pass `model_types` to `WorkerConnection` constructor**

Find (around line 278):
```python
worker = WorkerConnection(
    ws=ws, models=models, worker_id=worker_id,
    name=name, user_id=user_id,
)
```

Replace with:
```python
worker = WorkerConnection(
    ws=ws, models=models, worker_id=worker_id,
    name=name, user_id=user_id,
    model_types=model_types,
)
```

- [ ] **Step 3: Commit**

```bash
git add server/server.py
git commit -m "feat(worker): parse mixed str/dict models list in registration"
```

---

## Task 3: Database migration — model_type column + image_tokens_weight config

**Files:**
- Modify: `server/database.py`

- [ ] **Step 1: Add `_migrate_image_support()` function**

Add after `_migrate_virtual_agents` function (around line 231), before `_migrate_apikey_default_open`:

```python
async def _migrate_image_support() -> None:
    """Add model_type column to model_configs and image_tokens_weight system config."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("PRAGMA table_info(model_configs)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "model_type" not in cols:
            await db.execute(
                "ALTER TABLE model_configs ADD COLUMN model_type TEXT NOT NULL DEFAULT 'chat'"
            )
        await db.execute(
            "INSERT OR IGNORE INTO system_config(key,value) VALUES('image_tokens_weight','2000')"
        )
        await db.commit()
```

- [ ] **Step 2: Call the migration in `init_db()`**

Find the migration call block near the end of `init_db()` (around line 158–162):
```python
    await _migrate()
    await _migrate_apikey_default_open()
    await _migrate_checkins()
    await _migrate_spin_logs()
    await _migrate_virtual_agents()
```

Add the new migration:
```python
    await _migrate()
    await _migrate_apikey_default_open()
    await _migrate_checkins()
    await _migrate_spin_logs()
    await _migrate_virtual_agents()
    await _migrate_image_support()
```

- [ ] **Step 3: Update `ensure_default_open_models` to accept `model_type`**

Replace the function signature and INSERT statement (around lines 503–519):

```python
async def ensure_default_open_models(
    names: list[str], model_types: dict[str, str] | None = None
) -> list[str]:
    """Insert missing model names with open defaults. model_types maps name→type."""
    if not names:
        return []
    model_types = model_types or {}
    created: list[str] = []
    async with aiosqlite.connect(DB_PATH) as db:
        for name in names:
            async with db.execute("SELECT 1 FROM model_configs WHERE name=?", (name,)) as cur:
                if await cur.fetchone():
                    continue
            mtype = model_types.get(name, "chat")
            await db.execute(
                """INSERT INTO model_configs
                   (name,display_name,tier,contribute_rate,consume_rate,enabled,model_type)
                   VALUES(?,?,?,?,?,?,?)""",
                (name, name, "open", _OPEN_DEFAULT_CONTRIBUTE, _OPEN_DEFAULT_CONSUME, 1, mtype),
            )
            created.append(name)
        await db.commit()
    return created
```

- [ ] **Step 4: Update `upsert_model_config` to include `model_type`**

Replace the function signature and body (around lines 523–539):

```python
async def upsert_model_config(
    name: str, display_name: str, tier: str,
    contribute_rate: float, consume_rate: float,
    enabled: bool, model_type: str = "chat"
) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO model_configs
               (name,display_name,tier,contribute_rate,consume_rate,enabled,model_type)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(name) DO UPDATE SET
                 display_name=excluded.display_name,
                 tier=excluded.tier,
                 contribute_rate=excluded.contribute_rate,
                 consume_rate=excluded.consume_rate,
                 enabled=excluded.enabled,
                 model_type=excluded.model_type""",
            (name, display_name, tier, contribute_rate, consume_rate, int(enabled), model_type),
        )
        await db.commit()
    return {"name": name, "tier": tier, "contribute_rate": contribute_rate,
            "consume_rate": consume_rate, "enabled": enabled, "model_type": model_type}
```

- [ ] **Step 5: Add helper to get image_tokens_weight**

Add after `get_consume_rate` (around line 563):

```python
async def get_image_tokens_weight() -> int:
    val = await get_config("image_tokens_weight", "2000")
    try:
        return int(val)
    except ValueError:
        return 2000
```

- [ ] **Step 6: Commit**

```bash
git add server/database.py
git commit -m "feat(db): add model_type column, image_tokens_weight config, update model helpers"
```

---

## Task 4: Update server.py worker registration to pass model_types to DB

**Files:**
- Modify: `server/server.py`

- [ ] **Step 1: Pass `model_types` to `ensure_default_open_models`**

Find (around line 272):
```python
auto_models = await db.ensure_default_open_models(models)
```

Replace with:
```python
auto_models = await db.ensure_default_open_models(models, model_types)
```

- [ ] **Step 2: Commit**

```bash
git add server/server.py
git commit -m "feat(server): forward model_types to DB on worker auto-registration"
```

---

## Task 5: dispatch_image.py — new file

**Files:**
- Create: `server/dispatch_image.py`

- [ ] **Step 1: Create the file**

```python
"""Image generation dispatch — routes /v1/images/generations to Worker."""
import asyncio
import base64
import os
import time
import uuid
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import JSONResponse

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

    worker = pool.pick(model, model_type="image")
    if not worker:
        raise HTTPException(503, f"No image worker available for model '{model}'")

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

    # data is list of {"b64": "...", "revised_prompt": "..."}
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

    # Billing: n images × image_tokens_weight virtual output tokens
    if consumer_user_id:
        weight = await db.get_image_tokens_weight()
        virtual_usage = {"completion_tokens": n * weight}
        await db.consume_credits_for_usage(consumer_user_id, model, virtual_usage)

    # Contribution stats: record image_count for settler
    worker.record_image_complete(model, n)
    worker.active_requests = max(0, worker.active_requests - 1)
    worker.pending.pop(req_id, None)

    return {"created": created, "data": result_items}
```

- [ ] **Step 2: Commit**

```bash
git add server/dispatch_image.py
git commit -m "feat: add dispatch_image.py for image generation routing and billing"
```

---

## Task 6: WorkerConnection — add `record_image_complete`

**Files:**
- Modify: `server/worker_pool.py`

- [ ] **Step 1: Add `record_image_complete` method to `WorkerConnection`**

Add after `record_complete` method (around line 46):

```python
def record_image_complete(self, model: str, image_count: int) -> None:
    """Record completed image generation for settler contribution tracking."""
    s = self.period_stats.setdefault(
        model,
        {"output_tokens": 0, "requests": 0, "success": 0,
         "ttft_sum": 0.0, "ttft_count": 0, "image_count": 0},
    )
    s["requests"] += 1
    s["success"] += 1
    s["image_count"] = s.get("image_count", 0) + image_count
```

- [ ] **Step 2: Commit**

```bash
git add server/worker_pool.py
git commit -m "feat(worker): add record_image_complete for image contribution stats"
```

---

## Task 7: settler.py — handle image_count for contribution

**Files:**
- Modify: `server/settler.py`

- [ ] **Step 1: Update `settle_once` to handle image models**

Replace the per-model credits loop (around lines 65–82):

```python
        for model_name, s in stats.items():
            # Chat models: bill by output_tokens
            # Image models: bill by image_count
            image_count = s.get("image_count", 0)
            output_tokens = s["output_tokens"]

            if image_count > 0:
                rate = await db.get_contribute_rate(model_name)
                if rate is None:
                    continue
                credits = image_count * rate * multiplier
                total_credits += credits
                await db.award_credits(
                    user_id=worker.user_id,
                    delta=credits,
                    type_="contribute",
                    model_name=model_name,
                    tokens=0,
                    base_credits=image_count * rate,
                    multiplier=multiplier,
                    note=f"worker={worker.worker_id} images={image_count}",
                )
            elif output_tokens > 0:
                rate = await db.get_contribute_rate(model_name)
                if rate is None:
                    continue
                credits = (output_tokens / 1000) * rate * multiplier
                total_credits += credits
                await db.award_credits(
                    user_id=worker.user_id,
                    delta=credits,
                    type_="contribute",
                    model_name=model_name,
                    tokens=output_tokens,
                    base_credits=(output_tokens / 1000) * rate,
                    multiplier=multiplier,
                    note=f"worker={worker.worker_id}",
                )
```

- [ ] **Step 2: Commit**

```bash
git add server/settler.py
git commit -m "feat(settler): award contribution credits for image models by image_count"
```

---

## Task 8: server.py WebSocket — handle image_done message

**Files:**
- Modify: `server/server.py`

- [ ] **Step 1: Add `image_done` handling in the WebSocket receive loop**

Find the `elif kind == "done":` block in `worker_ws` (around line 311). Add a new branch before it:

```python
            elif kind == "image_done":
                images = msg.get("images", [])
                await q.put(("done", images))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
```

- [ ] **Step 2: Commit**

```bash
git add server/server.py
git commit -m "feat(server): handle image_done WebSocket message from worker"
```

---

## Task 9: server.py — new endpoint + img_cache cleanup

**Files:**
- Modify: `server/server.py`

- [ ] **Step 1: Import `handle_image` at the top of server.py**

Find:
```python
from dispatch import handle_chat
```

Replace with:
```python
from dispatch import handle_chat
from dispatch_image import handle_image
```

- [ ] **Step 2: Add img_cache cleanup to lifespan**

Find the `lifespan` function:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    logger.info("Database ready")
    from admin_router import _sync_virtual_pool
    await _sync_virtual_pool()
    logger.info("Virtual agents synced")
    task = asyncio.create_task(run_settler())
    yield
    task.cancel()
```

Replace with:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    logger.info("Database ready")
    from admin_router import _sync_virtual_pool
    await _sync_virtual_pool()
    logger.info("Virtual agents synced")
    _cleanup_img_cache()
    task = asyncio.create_task(run_settler())
    yield
    task.cancel()


def _cleanup_img_cache() -> None:
    """Delete img_cache files older than 1 hour on startup."""
    from dispatch_image import IMG_CACHE_DIR
    if not IMG_CACHE_DIR.is_dir():
        return
    cutoff = time.time() - 3600
    for p in IMG_CACHE_DIR.iterdir():
        if p.is_file() and p.stat().st_mtime < cutoff:
            try:
                p.unlink()
            except OSError:
                pass
```

- [ ] **Step 3: Add `/v1/images/generations` endpoint**

Add after the `/v1/chat/completions` endpoint (around line 404):

```python
@app.post("/v1/images/generations")
async def image_generations(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    return await handle_image(body, consumer_user_id=consumer_user_id)
```

- [ ] **Step 4: Commit**

```bash
git add server/server.py
git commit -m "feat(server): add /v1/images/generations endpoint and img_cache startup cleanup"
```

---

## Task 10: admin_router.py — pass model_type in model CRUD

**Files:**
- Modify: `server/admin_router.py` (lines 90–106)

- [ ] **Step 1: Add `model_type` to `ModelConfigRequest` and `upsert_model` call**

Replace lines 90–106:

```python
class ModelConfigRequest(BaseModel):
    name: str
    display_name: str = ""
    tier: str = "open"          # premium / open
    contribute_rate: float = 8
    consume_rate: float = 5
    enabled: bool = True
    model_type: str = "chat"    # chat / image


@router.post("/models", dependencies=[Depends(auth_admin)])
async def upsert_model(req: ModelConfigRequest):
    if req.tier not in ("premium", "open"):
        raise HTTPException(400, "tier 必须是 premium 或 open")
    if req.model_type not in ("chat", "image"):
        raise HTTPException(400, "model_type 必须是 chat 或 image")
    return await db.upsert_model_config(
        req.name, req.display_name, req.tier,
        req.contribute_rate, req.consume_rate, req.enabled,
        model_type=req.model_type,
    )
```

- [ ] **Step 2: Commit**

```bash
git add server/admin_router.py
git commit -m "feat(admin): expose model_type field in model config CRUD"
```

---

## Task 11: img_cache directory + .gitignore

**Files:**
- Create: `server/static/img_cache/.gitkeep`
- Modify: `server/.gitignore` (create if absent)

- [ ] **Step 1: Create the cache directory**

```bash
mkdir -p server/static/img_cache
touch server/static/img_cache/.gitkeep
```

- [ ] **Step 2: Ignore generated images**

Create or append to `server/.gitignore`:
```
static/img_cache/*.png
static/img_cache/*.jpg
static/img_cache/*.webp
```

- [ ] **Step 3: Commit**

```bash
git add server/static/img_cache/.gitkeep server/.gitignore
git commit -m "chore: add img_cache directory and gitignore for generated images"
```

---

## Task 12: Mock image worker for integration testing

**Files:**
- Create: `tests/mock_image_llm.py`

- [ ] **Step 1: Create mock server**

```python
"""Mock image generation service for integration testing.

Run: uvicorn tests.mock_image_llm:app --port 11435
Then register a worker pointing at this server with model type 'image'.
"""
import base64
import time
import uuid

from fastapi import FastAPI, Request

app = FastAPI(title="Mock Image LLM")

# 1x1 red PNG, base64-encoded
_RED_1X1_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
)


@app.post("/v1/images/generations")
async def generate(request: Request):
    body = await request.json()
    n = int(body.get("n") or 1)
    prompt = body.get("prompt", "")
    return {
        "created": int(time.time()),
        "data": [
            {
                "b64_json": _RED_1X1_PNG,
                "revised_prompt": f"[mock] {prompt}",
            }
            for _ in range(n)
        ],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=11435)
```

- [ ] **Step 2: Commit**

```bash
git add tests/mock_image_llm.py
git commit -m "test: add mock image generation server for integration testing"
```

---

## Task 13: Manual end-to-end verification

No automated tests exist for the WebSocket integration path — verify manually.

- [ ] **Step 1: Start the proxy server**

```bash
cd server && uvicorn server:app --reload --port 8000
```

Expected: Server starts, logs "Database ready", "Virtual agents synced".

- [ ] **Step 2: Verify DB migration**

```bash
sqlite3 server/proxy.db "PRAGMA table_info(model_configs);"
```

Expected: Column `model_type` appears in the output.

```bash
sqlite3 server/proxy.db "SELECT key,value FROM system_config WHERE key='image_tokens_weight';"
```

Expected: `image_tokens_weight|2000`

- [ ] **Step 3: Register a worker with mixed model types**

Open a second terminal and run a quick WebSocket test. You can use `wscat` or Python:

```python
import asyncio, json, websockets

async def test():
    async with websockets.connect("ws://localhost:8000/ws/worker") as ws:
        # Use a valid worker_key from your DB:
        # sqlite3 server/proxy.db "SELECT worker_key FROM users LIMIT 1;"
        await ws.send(json.dumps({
            "type": "register",
            "worker_key": "<YOUR_WORKER_KEY>",
            "name": "test-worker",
            "models": [
                {"name": "mock-chat", "type": "chat"},
                {"name": "mock-image", "type": "image"}
            ]
        }))
        resp = await ws.recv()
        print("Registered:", resp)
        # Keep alive
        await asyncio.sleep(30)

asyncio.run(test())
```

Expected: `{"type": "registered", "worker_id": "..."}` printed.

- [ ] **Step 4: Call `/v1/images/generations`**

```bash
curl -s -X POST http://localhost:8000/v1/images/generations \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-image","prompt":"a cat","n":1,"response_format":"b64_json"}' | python3 -m json.tool
```

Expected: JSON with `"data": [{"b64_json": "..."}]`

- [ ] **Step 5: Verify chat still works**

```bash
curl -s -X POST http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"hi"}]}' | python3 -m json.tool
```

Expected: Normal chat response (routed to chat worker, not image worker).

- [ ] **Step 6: Verify cross-type routing blocked**

```bash
curl -s -X POST http://localhost:8000/v1/images/generations \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-chat","prompt":"a cat","n":1}' | python3 -m json.tool
```

Expected: `503` — "No image worker available for model 'mock-chat'"

- [ ] **Step 7: Final commit**

```bash
git add -p  # stage any remaining changes
git commit -m "feat: multimodal image generation support complete"
```

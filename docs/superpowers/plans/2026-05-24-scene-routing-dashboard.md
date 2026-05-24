# Scene Routing + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user scene routing (fallback chains of models) and a 盘点 dashboard showing usage analytics per scene application.

**Architecture:** Scene routes are per-user ordered lists of model steps stored in SQLite. Each API key can be bound to a scene route; when a request arrives, dispatch tries each step's model in order until one succeeds. A new Dashboard page shows per-key usage analytics pulled from the existing transactions table.

**Tech Stack:** Python FastAPI + aiosqlite (backend), React 18 + Tailwind CSS + MemoryRouter (frontend), Electron IPC bridge (window.electronAPI)

---

## File Map

**Create:**
- `server/scene_router.py` — FastAPI router: CRUD for scene_routes, bind key to route
- `client/src/pages/Dashboard.jsx` — 盘点 analytics page

**Modify:**
- `server/database.py` — add scene_routes table, migrate api_keys with scene_route_id + app_name
- `server/dispatch.py` — add scene-aware fallback dispatch (tries each model step)
- `server/server.py` — pass key_id to handle_chat, include scene_router
- `server/user_router.py` — add /user/dashboard-stats endpoint
- `client/src/api/client.js` — add scene route + dashboard API functions
- `client/src/pages/Gateway.jsx` — redesign: scene routes panel + scene applications panel
- `client/src/components/Sidebar.jsx` — add 📊 盘点 nav item
- `client/src/App.jsx` — add /dashboard route

---

### Task 1: Database — scene_routes table + api_keys migration

**Files:**
- Modify: `server/database.py`

**Data model for scene_routes.steps (JSON):**
```json
[
  {"label": "Groq / llama-3.3-70b-versatile", "model": "llama-3.3-70b-versatile", "tier": "free"},
  {"label": "Ollama / llama3.2", "model": "llama3.2", "tier": "free"},
  {"label": "OpenRouter / claude-3-haiku", "model": "claude-3-haiku", "tier": "paid"}
]
```

- [ ] **Step 1: Add scene_routes table in `init_db`**

In `server/database.py`, inside `init_db()` after the `spin_logs` CREATE TABLE block (before the `for k, v in [...]` block), add:

```python
        # scene_routes
        await db.execute("""
            CREATE TABLE IF NOT EXISTS scene_routes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL REFERENCES users(id),
                scene_name  TEXT NOT NULL,
                icon        TEXT DEFAULT '🔀',
                steps       TEXT NOT NULL DEFAULT '[]',
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
```

- [ ] **Step 2: Add migration for api_keys — scene_route_id and app_name columns**

Add a new migration function after `_migrate_image_support` in `server/database.py`:

```python
async def _migrate_scene_routes() -> None:
    """Add scene_route_id + app_name to api_keys if missing."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("PRAGMA table_info(api_keys)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "scene_route_id" not in cols:
            await db.execute(
                "ALTER TABLE api_keys ADD COLUMN scene_route_id INTEGER REFERENCES scene_routes(id)"
            )
        if "app_name" not in cols:
            await db.execute(
                "ALTER TABLE api_keys ADD COLUMN app_name TEXT DEFAULT ''"
            )
        await db.commit()
```

- [ ] **Step 3: Call the migration in `init_db`**

In `init_db()`, find the line:
```python
    await _migrate_image_support()
```
Change it to:
```python
    await _migrate_image_support()
    await _migrate_scene_routes()
```

- [ ] **Step 4: Add CRUD database functions for scene_routes**

Add these functions at the end of `server/database.py`:

```python
# ── Scene Routes ──────────────────────────────────────────────────────────────

async def list_scene_routes(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM scene_routes WHERE user_id=? ORDER BY id", (user_id,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def create_scene_route(user_id: int, scene_name: str, icon: str, steps: list) -> dict:
    import json as _json
    steps_json = _json.dumps(steps, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO scene_routes(user_id, scene_name, icon, steps) VALUES(?,?,?,?)",
            (user_id, scene_name, icon, steps_json),
        )
        row_id = cur.lastrowid
        await db.commit()
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM scene_routes WHERE id=?", (row_id,)) as c:
            row = await c.fetchone()
    return dict(row)


async def update_scene_route(route_id: int, user_id: int, scene_name: str, icon: str, steps: list) -> bool:
    import json as _json
    steps_json = _json.dumps(steps, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE scene_routes SET scene_name=?, icon=?, steps=? WHERE id=? AND user_id=?",
            (scene_name, icon, steps_json, route_id, user_id),
        )
        await db.commit()
    return cur.rowcount > 0


async def delete_scene_route(route_id: int, user_id: int) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        # Unbind any keys pointing to this route
        await db.execute(
            "UPDATE api_keys SET scene_route_id=NULL WHERE scene_route_id=? AND user_id=?",
            (route_id, user_id),
        )
        cur = await db.execute(
            "DELETE FROM scene_routes WHERE id=? AND user_id=?", (route_id, user_id)
        )
        await db.commit()
    return cur.rowcount > 0


async def get_scene_route_by_key(key_id: int) -> dict | None:
    """Return the scene_route bound to this api_key, or None."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT sr.* FROM scene_routes sr
               JOIN api_keys ak ON ak.scene_route_id = sr.id
               WHERE ak.id=?""",
            (key_id,),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def bind_key_to_scene_route(key_id: int, user_id: int, scene_route_id: int | None, app_name: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE api_keys SET scene_route_id=?, app_name=? WHERE id=? AND user_id=?",
            (scene_route_id, app_name, key_id, user_id),
        )
        await db.commit()
    return cur.rowcount > 0


async def list_keys_with_scene(user_id: int) -> list[dict]:
    """List user's API keys with scene route info joined."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ak.id, ak.key, ak.note, ak.app_name, ak.is_active,
                      ak.scene_route_id, sr.scene_name, sr.icon, sr.steps,
                      ak.created_at
               FROM api_keys ak
               LEFT JOIN scene_routes sr ON sr.id = ak.scene_route_id
               WHERE ak.user_id=?
               ORDER BY ak.id""",
            (user_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]
```

- [ ] **Step 5: Verify the migration runs without error**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python3 -c "
import asyncio, database as db
asyncio.run(db.init_db())
print('OK')
asyncio.run(db._migrate_scene_routes())
print('Migration OK')
"
```

Expected: two OK lines, no exceptions.

- [ ] **Step 6: Commit**

```bash
git add server/database.py
git commit -m "feat(db): add scene_routes table + api_keys migration for scene routing"
```

---

### Task 2: Backend — scene_router.py (REST API)

**Files:**
- Create: `server/scene_router.py`
- Modify: `server/server.py` (include router)

- [ ] **Step 1: Create `server/scene_router.py`**

```python
"""Scene routes CRUD + key binding endpoints."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import database as db
from server import auth_user  # re-use existing dependency

router = APIRouter()


class SceneRouteBody(BaseModel):
    scene_name: str
    icon: str = "🔀"
    steps: list  # [{label, model, tier}]


class BindKeyBody(BaseModel):
    scene_route_id: int | None = None
    app_name: str = ""


@router.get("/scene-routes")
async def list_routes(key_info: dict = Depends(auth_user)):
    routes = await db.list_scene_routes(key_info["user_id"])
    for r in routes:
        if isinstance(r.get("steps"), str):
            r["steps"] = json.loads(r["steps"])
    return {"routes": routes}


@router.post("/scene-routes")
async def create_route(body: SceneRouteBody, key_info: dict = Depends(auth_user)):
    route = await db.create_scene_route(
        key_info["user_id"], body.scene_name, body.icon, body.steps
    )
    if isinstance(route.get("steps"), str):
        route["steps"] = json.loads(route["steps"])
    return route


@router.put("/scene-routes/{route_id}")
async def update_route(route_id: int, body: SceneRouteBody, key_info: dict = Depends(auth_user)):
    ok = await db.update_scene_route(
        route_id, key_info["user_id"], body.scene_name, body.icon, body.steps
    )
    if not ok:
        raise HTTPException(404, "Route not found")
    return {"ok": True}


@router.delete("/scene-routes/{route_id}")
async def delete_route(route_id: int, key_info: dict = Depends(auth_user)):
    ok = await db.delete_scene_route(route_id, key_info["user_id"])
    if not ok:
        raise HTTPException(404, "Route not found")
    return {"ok": True}


@router.get("/keys-with-scene")
async def keys_with_scene(key_info: dict = Depends(auth_user)):
    keys = await db.list_keys_with_scene(key_info["user_id"])
    for k in keys:
        if k.get("steps") and isinstance(k["steps"], str):
            k["steps"] = json.loads(k["steps"])
    return {"keys": keys}


@router.put("/keys/{key_id}/bind-scene")
async def bind_scene(key_id: int, body: BindKeyBody, key_info: dict = Depends(auth_user)):
    ok = await db.bind_key_to_scene_route(
        key_id, key_info["user_id"], body.scene_route_id, body.app_name
    )
    if not ok:
        raise HTTPException(404, "Key not found or not owned by you")
    return {"ok": True}
```

- [ ] **Step 2: Register the router in `server/server.py`**

Find the imports block at the top of `server/server.py`. After:
```python
from user_router import router as user_router
```
Add:
```python
from scene_router import router as scene_router
```

Find:
```python
app.include_router(user_router, prefix="/user")
```
After it, add:
```python
app.include_router(scene_router, prefix="/user")
```

- [ ] **Step 3: Verify routes register (syntax check)**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python3 -c "
import scene_router
print('Scene router OK, routes:', [r.path for r in scene_router.router.routes])
"
```

Expected: prints route paths like `/scene-routes`, `/keys-with-scene`, etc.

- [ ] **Step 4: Commit**

```bash
git add server/scene_router.py server/server.py
git commit -m "feat(api): add scene routing REST endpoints"
```

---

### Task 3: Backend — scene-aware dispatch

**Files:**
- Modify: `server/dispatch.py`
- Modify: `server/server.py` (pass key_id)

The current dispatch picks one worker by model name. Scene-aware dispatch tries each step in the route's fallback chain, moving to the next model if the worker returns an error or is unavailable.

- [ ] **Step 1: Modify `handle_chat` signature in `server/dispatch.py`**

Find the current function signature:
```python
async def handle_chat(body: dict, consumer_user_id: int | None = None):
```
Change it to:
```python
async def handle_chat(body: dict, consumer_user_id: int | None = None, key_id: int | None = None):
```

- [ ] **Step 2: Add scene route lookup + model list construction**

After the line `model = body.get("model", "")` and before the credits check block, add:

```python
    # Build list of models to try: scene route steps first, then the requested model as fallback
    models_to_try: list[str] = []
    if key_id is not None:
        import json as _json
        scene = await db.get_scene_route_by_key(key_id)
        if scene:
            raw_steps = scene.get("steps", "[]")
            steps = _json.loads(raw_steps) if isinstance(raw_steps, str) else raw_steps
            models_to_try = [s["model"] for s in steps if s.get("model")]
    if not models_to_try:
        models_to_try = [model]
```

- [ ] **Step 3: Replace the single-model dispatch with a loop**

The current dispatch block (credits check → pool.pick → send → streaming/non-streaming) tries one model. We need it to loop through `models_to_try`.

Replace the current dispatch logic (everything from `# 消费积分检查` to the end of the function) with:

```python
    # Credits check (done once before we attempt any step)
    if consumer_user_id is not None:
        # Use first model in chain for rate lookup; fall back to any enabled rate
        check_model = models_to_try[0] if models_to_try else model
        rate = await db.get_consume_rate(check_model)
        if rate is None:
            # Try other models in the chain before rejecting
            for m in models_to_try[1:]:
                rate = await db.get_consume_rate(m)
                if rate is not None:
                    break
        if rate is None:
            raise HTTPException(
                400,
                f"No enabled model found in scene route; ensure models are configured in admin.",
            )
        user = await db.get_user_by_id(consumer_user_id)
        if not user or user["credits_balance"] <= 0:
            raise HTTPException(402, "Insufficient credits")

    last_error: str = "No worker available"
    for attempt_model in models_to_try:
        worker = pool.pick(attempt_model, model_type="chat")
        if not worker:
            last_error = f"No worker for '{attempt_model}'"
            continue

        req_id = str(uuid.uuid4())
        q: asyncio.Queue = asyncio.Queue()
        worker.pending[req_id] = {
            "queue": q,
            "model": attempt_model,
            "dispatch_time": time.time(),
            "ttft_ms": None,
        }
        worker.active_requests += 1

        # Patch the body with the actual model this step uses
        dispatch_body = dict(body)
        dispatch_body["model"] = attempt_model

        try:
            await worker.send({"type": "request", "req_id": req_id, "payload": dispatch_body})
        except Exception:
            worker.pending.pop(req_id, None)
            worker.active_requests = max(0, worker.active_requests - 1)
            last_error = f"Failed to reach worker for '{attempt_model}'"
            continue

        if streaming:
            async def sse_gen(w=worker, rid=req_id, q=q, m=attempt_model):
                try:
                    while True:
                        kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
                        if kind == "done":
                            usage = data if isinstance(data, dict) else {}
                            if consumer_user_id:
                                await db.consume_credits_for_usage(consumer_user_id, m, usage)
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

        # Non-streaming: wait for result; on worker error, try next model
        try:
            result_data = None
            while True:
                kind, data = await asyncio.wait_for(q.get(), timeout=REQUEST_TIMEOUT)
                if kind == "error":
                    worker.pending.pop(req_id, None)
                    last_error = str(data)
                    break
                if kind == "chunk":
                    result_data = json.loads(data)
                    break
                if kind == "done":
                    break
        except asyncio.TimeoutError:
            worker.pending.pop(req_id, None)
            last_error = f"Timeout on '{attempt_model}'"
            continue

        if result_data is not None:
            return result_data
        if kind == "error":
            continue  # try next model in chain

        raise HTTPException(502, "Empty response from worker")

    raise HTTPException(503, last_error)
```

- [ ] **Step 4: Pass `key_id` from `server.py` to `handle_chat`**

In `server/server.py`, find:
```python
@app.post("/v1/chat/completions")
async def chat_completions(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    resp = await handle_chat(body, consumer_user_id=consumer_user_id)
```
Change to:
```python
@app.post("/v1/chat/completions")
async def chat_completions(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    resp = await handle_chat(body, consumer_user_id=consumer_user_id, key_id=key_info.get("id"))
```

Also update the `/v1/messages` endpoint similarly:
```python
    oai_body = _anthropic_to_openai(body)
    resp = await handle_chat(oai_body, consumer_user_id=consumer_user_id, key_id=key_info.get("id"))
```

- [ ] **Step 5: Verify dispatch syntax**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python3 -c "import dispatch; print('dispatch OK')"
```

Expected: `dispatch OK`

- [ ] **Step 6: Commit**

```bash
git add server/dispatch.py server/server.py
git commit -m "feat(dispatch): scene-aware fallback chain routing per API key"
```

---

### Task 4: Backend — dashboard stats endpoint

**Files:**
- Modify: `server/user_router.py`
- Modify: `server/database.py` (add dashboard query function)

The dashboard shows per-key usage: total tokens consumed, credit spent, request count, broken down by model tier.

- [ ] **Step 1: Add `get_dashboard_stats` to `server/database.py`**

Add at the end of `server/database.py`:

```python
async def get_dashboard_stats(user_id: int, days: int = 30) -> list[dict]:
    """Per-key usage stats from transactions for the last N days."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT
                 ak.id        AS key_id,
                 ak.key       AS api_key,
                 ak.app_name,
                 ak.note,
                 sr.scene_name,
                 sr.icon,
                 COALESCE(SUM(t.tokens), 0)       AS total_tokens,
                 COALESCE(SUM(ABS(t.delta)), 0)   AS total_credits,
                 COUNT(t.id)                       AS request_count
               FROM api_keys ak
               LEFT JOIN scene_routes sr ON sr.id = ak.scene_route_id
               LEFT JOIN transactions t
                 ON t.user_id = ak.user_id
                 AND t.type = 'consume'
                 AND t.created_at >= datetime('now', ?)
               WHERE ak.user_id = ?
               GROUP BY ak.id
               ORDER BY total_tokens DESC""",
            (f"-{days} days", user_id),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]
```

- [ ] **Step 2: Add `/user/dashboard-stats` endpoint to `user_router.py`**

In `server/user_router.py`, find the imports and add to the existing ones:

```python
# add to existing imports at top of file if not already there:
# from fastapi import APIRouter, Depends, HTTPException
```

Then add this route at the end of the router definitions (before any `if __name__` block):

```python
@router.get("/dashboard-stats")
async def dashboard_stats(days: int = 30, key_info: dict = Depends(auth_user)):
    stats = await db.get_dashboard_stats(key_info["user_id"], days)
    return {"stats": stats, "days": days}
```

Note: `auth_user` is imported from `server` or defined locally in `user_router.py` — check the existing pattern and follow it.

- [ ] **Step 3: Check how auth_user is used in user_router.py**

```bash
grep -n "auth_user\|Depends" /Users/ully/githubprojects/local-llm-proxy/server/user_router.py | head -10
```

Follow the same pattern already used in that file.

- [ ] **Step 4: Verify syntax**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python3 -c "import user_router; print('user_router OK')"
```

Expected: `user_router OK`

- [ ] **Step 5: Commit**

```bash
git add server/database.py server/user_router.py
git commit -m "feat(api): add dashboard-stats endpoint for per-key usage analytics"
```

---

### Task 5: Frontend — api/client.js additions

**Files:**
- Modify: `client/src/api/client.js`

- [ ] **Step 1: Read the current end of `client/src/api/client.js` to find the pattern**

```bash
tail -30 /Users/ully/githubprojects/local-llm-proxy/client/src/api/client.js
```

- [ ] **Step 2: Append scene route + dashboard API functions**

Following the existing pattern in the file (using the existing `apiCall` or `fetch` helper), add at the end of `client/src/api/client.js`:

```javascript
// ── Scene Routes ──────────────────────────────────────────────────────────────

export const getSceneRoutes = () => apiCall('/user/scene-routes');

export const createSceneRoute = (body) =>
  apiCall('/user/scene-routes', { method: 'POST', body: JSON.stringify(body) });

export const updateSceneRoute = (id, body) =>
  apiCall(`/user/scene-routes/${id}`, { method: 'PUT', body: JSON.stringify(body) });

export const deleteSceneRoute = (id) =>
  apiCall(`/user/scene-routes/${id}`, { method: 'DELETE' });

export const getKeysWithScene = () => apiCall('/user/keys-with-scene');

export const bindKeyToScene = (keyId, body) =>
  apiCall(`/user/keys/${keyId}/bind-scene`, { method: 'PUT', body: JSON.stringify(body) });

// ── Dashboard Stats ───────────────────────────────────────────────────────────

export const getDashboardStats = (days = 30) =>
  apiCall(`/user/dashboard-stats?days=${days}`);
```

Note: replace `apiCall` with the actual helper name used in the file if different.

- [ ] **Step 3: Verify no syntax errors**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
node --input-type=module < src/api/client.js 2>&1 | head -5 || echo "module check done"
```

- [ ] **Step 4: Commit**

```bash
git add client/src/api/client.js
git commit -m "feat(client): add scene route + dashboard API functions"
```

---

### Task 6: Frontend — Gateway.jsx redesign

**Files:**
- Modify: `client/src/pages/Gateway.jsx`

This is the biggest frontend change. The Gateway page gets two new panels:
1. **场景路由** — list of scene routes with inline fallback-chain editor
2. **场景应用** — list of API keys with tool selector and scene route binding

- [ ] **Step 1: Read current Gateway.jsx to understand existing state and hooks**

```bash
cat /Users/ully/githubprojects/local-llm-proxy/client/src/pages/Gateway.jsx
```

- [ ] **Step 2: Add scene route imports at the top of Gateway.jsx**

After the existing import block, add:

```javascript
import {
  getSceneRoutes, createSceneRoute, updateSceneRoute, deleteSceneRoute,
  getKeysWithScene, bindKeyToScene,
} from '../api/client';
```

- [ ] **Step 3: Add scene route state and load function**

Inside the Gateway component, after the existing state declarations, add:

```javascript
  const [routes, setRoutes] = useState([]);
  const [expandedRoute, setExpandedRoute] = useState(null);
  const [routeEdits, setRouteEdits] = useState({});  // {id: {scene_name, icon, steps}}
  const [newRoute, setNewRoute] = useState(null);    // null | {scene_name, icon, steps}
  const [keysScene, setKeysScene] = useState([]);
  const [expandedKey, setExpandedKey] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);

  const loadSceneData = async () => {
    try {
      const [rRes, kRes] = await Promise.all([getSceneRoutes(), getKeysWithScene()]);
      setRoutes(rRes.routes || []);
      setKeysScene(kRes.keys || []);
    } catch (e) {
      console.error('loadSceneData', e);
    }
  };

  const loadAvailableModels = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/v1/models', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setAvailableModels((data.data || []).filter(m => m.model_type === 'chat'));
    } catch (e) {
      console.error('loadAvailableModels', e);
    }
  };
```

- [ ] **Step 4: Call loadSceneData in the existing useEffect**

In the existing `useEffect` that calls `loadData()`, also call `loadSceneData()` and `loadAvailableModels()`:

```javascript
  useEffect(() => {
    loadData();
    loadSceneData();
    loadAvailableModels();
    // ... existing cleanup / interval code
  }, []);
```

- [ ] **Step 5: Add helper functions for scene route CRUD**

Add inside the Gateway component:

```javascript
  const TIER_OPTIONS = [
    { label: '🟢 免费层', models: availableModels.filter(m => !m.id.includes('gpt') && !m.id.includes('claude') && !m.id.includes('openrouter')) },
    { label: '🔵 P2P 层', models: availableModels.filter(m => m.id.startsWith('p2p/')) },
    { label: '🟡 付费层', models: availableModels.filter(m => m.id.includes('gpt') || m.id.includes('claude') || m.id.includes('openrouter')) },
  ];

  const tierChip = (tier) => {
    const map = {
      free: 'inline-flex items-center gap-1 text-[10px] font-mono bg-green-950/70 border border-green-800/30 text-green-300 px-2 py-0.5 rounded',
      p2p:  'inline-flex items-center gap-1 text-[10px] font-mono bg-blue-950/70 border border-blue-800/30 text-blue-300 px-2 py-0.5 rounded',
      paid: 'inline-flex items-center gap-1 text-[10px] font-mono bg-amber-950/70 border border-amber-800/30 text-amber-300 px-2 py-0.5 rounded',
    };
    const dot = { free: 'bg-green-400', p2p: 'bg-blue-400', paid: 'bg-amber-400' };
    const t = tier || 'free';
    return (className) => (
      <span className={map[t] || map.free}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot[t] || dot.free}`} />
        {className}
      </span>
    );
  };

  const inferTier = (modelId) => {
    if (!modelId) return 'free';
    if (modelId.startsWith('p2p/')) return 'p2p';
    if (modelId.includes('gpt') || modelId.includes('claude') || modelId.includes('openrouter')) return 'paid';
    return 'free';
  };

  const saveRoute = async (route) => {
    try {
      if (route.id) {
        await updateSceneRoute(route.id, { scene_name: route.scene_name, icon: route.icon, steps: route.steps });
      } else {
        await createSceneRoute({ scene_name: route.scene_name, icon: route.icon, steps: route.steps });
      }
      setNewRoute(null);
      setExpandedRoute(null);
      await loadSceneData();
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  };

  const removeRoute = async (id) => {
    if (!confirm('删除此场景路由？')) return;
    try {
      await deleteSceneRoute(id);
      await loadSceneData();
    } catch (e) {
      alert('删除失败');
    }
  };

  const saveKeyBinding = async (keyId, sceneRouteId, appName) => {
    try {
      await bindKeyToScene(keyId, { scene_route_id: sceneRouteId, app_name: appName });
      setExpandedKey(null);
      await loadSceneData();
    } catch (e) {
      alert('绑定失败: ' + e.message);
    }
  };
```

- [ ] **Step 6: Add SceneRouteEditor sub-component (inline, above return statement)**

Add this functional component inside the Gateway function (or as a separate function in the same file):

```javascript
  const SceneRouteEditor = ({ route, onSave, onCancel }) => {
    const [name, setName] = useState(route.scene_name || '');
    const [icon, setIcon] = useState(route.icon || '🔀');
    const [steps, setSteps] = useState(route.steps || []);

    const addStep = () => setSteps([...steps, { label: '', model: '', tier: 'free' }]);
    const removeStep = (i) => setSteps(steps.filter((_, idx) => idx !== i));
    const updateStep = (i, model) => {
      const tier = inferTier(model);
      const label = model;
      setSteps(steps.map((s, idx) => idx === i ? { label, model, tier } : s));
    };

    return (
      <div className="border-t border-gray-800/60 bg-gray-800/20 px-5 py-4 space-y-3">
        <div className="flex gap-2">
          <input
            value={icon} onChange={e => setIcon(e.target.value)}
            className="w-10 bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-center"
            maxLength={2}
          />
          <input
            value={name} onChange={e => setName(e.target.value)}
            placeholder="场景名称"
            className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="text-xs text-gray-500 font-medium">降级链 <span className="text-gray-700">· 失败时按顺序尝试下一步</span></div>
        <div className="space-y-2">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <span className="text-[10px] text-gray-600 w-4 text-right shrink-0">{i + 1}</span>
              <select
                value={step.model}
                onChange={e => updateStep(i, e.target.value)}
                className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">-- 选择模型 --</option>
                <optgroup label="🟢 免费层">
                  {availableModels.filter(m => inferTier(m.id) === 'free').map(m => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </optgroup>
                <optgroup label="🔵 P2P 层">
                  {availableModels.filter(m => inferTier(m.id) === 'p2p').map(m => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </optgroup>
                <optgroup label="🟡 付费层">
                  {availableModels.filter(m => inferTier(m.id) === 'paid').map(m => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </optgroup>
              </select>
              <button
                onClick={() => removeStep(i)}
                className="text-[10px] text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              >✕</button>
            </div>
          ))}
        </div>
        <button onClick={addStep} className="text-xs text-blue-400 hover:text-blue-300">+ 添加步骤</button>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="text-xs bg-gray-700 border border-gray-600 text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-600">取消</button>
          <button onClick={() => onSave({ ...route, scene_name: name, icon, steps })} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium">保存</button>
        </div>
      </div>
    );
  };
```

- [ ] **Step 7: Add scene routes panel to the JSX return**

In the Gateway component's return, after the existing stats + endpoint card sections, add:

```jsx
  {/* 场景路由 */}
  <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
    <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
      <div>
        <h2 className="text-sm font-semibold text-gray-200">场景路由</h2>
        <p className="text-xs text-gray-500 mt-0.5">定义每个场景的降级链规则</p>
      </div>
      <button
        onClick={() => setNewRoute({ scene_name: '', icon: '🔀', steps: [] })}
        className="text-xs bg-gray-800 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors"
      >+ 新建场景</button>
    </div>
    <div className="divide-y divide-gray-800/60">
      {routes.map(route => (
        <div key={route.id}>
          <div
            className="flex items-start gap-4 px-5 py-3.5 cursor-pointer hover:bg-gray-800/20"
            onClick={() => setExpandedRoute(expandedRoute === route.id ? null : route.id)}
          >
            <span className="text-lg mt-0.5">{route.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-200">{route.scene_name}</div>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {(route.steps || []).map((step, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="text-gray-600 text-xs">→</span>}
                    <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${
                      step.tier === 'paid' ? 'bg-amber-950/70 border-amber-800/30 text-amber-300' :
                      step.tier === 'p2p'  ? 'bg-blue-950/70 border-blue-800/30 text-blue-300' :
                                             'bg-green-950/70 border-green-800/30 text-green-300'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${step.tier === 'paid' ? 'bg-amber-400' : step.tier === 'p2p' ? 'bg-blue-400' : 'bg-green-400'}`} />
                      {step.label || step.model}
                    </span>
                  </React.Fragment>
                ))}
                {route.steps?.length === 0 && <span className="text-xs text-gray-600">暂无步骤</span>}
              </div>
            </div>
            <button
              onClick={e => { e.stopPropagation(); removeRoute(route.id); }}
              className="text-xs text-gray-700 hover:text-red-400 transition-colors mt-1"
            >删除</button>
            <span className="text-gray-600 text-xs mt-1">{expandedRoute === route.id ? '▲' : '▼'}</span>
          </div>
          {expandedRoute === route.id && (
            <SceneRouteEditor
              route={route}
              onSave={saveRoute}
              onCancel={() => setExpandedRoute(null)}
            />
          )}
        </div>
      ))}
      {newRoute && (
        <SceneRouteEditor
          route={newRoute}
          onSave={saveRoute}
          onCancel={() => setNewRoute(null)}
        />
      )}
      {routes.length === 0 && !newRoute && (
        <div className="px-5 py-6 text-xs text-gray-600 text-center">还没有场景路由，点击「新建场景」开始</div>
      )}
    </div>
  </div>

  {/* 场景应用 */}
  <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
    <div className="px-5 py-4 border-b border-gray-800">
      <h2 className="text-sm font-semibold text-gray-200">场景应用</h2>
      <p className="text-xs text-gray-500 mt-0.5">将 API Key 与场景路由绑定，接入工具</p>
    </div>
    <div className="divide-y divide-gray-800/60">
      {keysScene.map(key => (
        <div key={key.key_id}>
          <div
            className="flex items-center gap-4 px-5 py-3 cursor-pointer hover:bg-gray-800/20"
            onClick={() => setExpandedKey(expandedKey === key.key_id ? null : key.key_id)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-gray-200">{key.app_name || key.note || '未命名'}</div>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-[10px] text-gray-500 font-mono">{key.api_key?.slice(0, 8)}…</code>
                {key.scene_name ? (
                  <span className="text-[10px] text-blue-400">{key.icon} {key.scene_name}</span>
                ) : (
                  <span className="text-[10px] text-gray-600">未绑定路由</span>
                )}
              </div>
            </div>
            <span className="text-gray-600 text-xs">{expandedKey === key.key_id ? '▲' : '▼'}</span>
          </div>
          {expandedKey === key.key_id && (
            <KeyBindEditor
              apiKey={key}
              routes={routes}
              onSave={saveKeyBinding}
              onCancel={() => setExpandedKey(null)}
            />
          )}
        </div>
      ))}
      {keysScene.length === 0 && (
        <div className="px-5 py-6 text-xs text-gray-600 text-center">
          先在「盘点」页创建 API Key，再回来绑定场景
        </div>
      )}
    </div>
  </div>
```

- [ ] **Step 8: Add KeyBindEditor sub-component**

Add inside the Gateway function (before the return statement):

```javascript
  const KeyBindEditor = ({ apiKey, routes, onSave, onCancel }) => {
    const [selectedRoute, setSelectedRoute] = useState(apiKey.scene_route_id || '');
    const [appName, setAppName] = useState(apiKey.app_name || apiKey.note || '');

    return (
      <div className="border-t border-gray-800/60 bg-gray-800/20 px-5 py-4 space-y-3">
        <div className="space-y-2">
          <label className="text-xs text-gray-500">应用名称</label>
          <input
            value={appName} onChange={e => setAppName(e.target.value)}
            placeholder="如：Claude Code 主机"
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-gray-500">绑定场景路由</label>
          <select
            value={selectedRoute}
            onChange={e => setSelectedRoute(e.target.value ? Number(e.target.value) : '')}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
          >
            <option value="">不绑定（使用默认路由）</option>
            {routes.map(r => (
              <option key={r.id} value={r.id}>{r.icon} {r.scene_name}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="text-xs bg-gray-700 border border-gray-600 text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-600">取消</button>
          <button
            onClick={() => onSave(apiKey.key_id, selectedRoute || null, appName)}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium"
          >保存</button>
        </div>
      </div>
    );
  };
```

- [ ] **Step 9: Verify the client builds without error**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm run build 2>&1 | tail -20
```

Expected: build succeeds (or only pre-existing warnings).

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/Gateway.jsx
git commit -m "feat(gateway): scene routes editor + scene application key binding UI"
```

---

### Task 7: Sidebar + App.jsx — add 盘点 nav item and route

**Files:**
- Modify: `client/src/components/Sidebar.jsx`
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Add 盘点 nav item in Sidebar.jsx**

Read the Sidebar.jsx nav items array. Find the entry for `网关` or `供给源`. Add a new nav item after `贡献`:

```javascript
{ to: '/dashboard', icon: '📊', label: '盘点' },
```

The exact location is after `{ to: '/contribute', icon: '💪', label: '贡献' }`.

- [ ] **Step 2: Add /dashboard route in App.jsx**

In `client/src/App.jsx`, find the import block and add:
```javascript
import Dashboard from './pages/Dashboard';
```

Find the route for `/contribute` and add after it:
```jsx
<Route path="/dashboard" element={<Dashboard />} />
```

- [ ] **Step 3: Verify build still passes**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm run build 2>&1 | tail -10
```

(Dashboard.jsx doesn't exist yet — the build will fail. This is expected. Continue to Task 8 immediately.)

- [ ] **Step 4: Commit (after Task 8 is complete and build passes)**

```bash
git add client/src/components/Sidebar.jsx client/src/App.jsx
git commit -m "feat(nav): add 盘点 dashboard route to sidebar and router"
```

---

### Task 8: Frontend — Dashboard.jsx (盘点 page)

**Files:**
- Create: `client/src/pages/Dashboard.jsx`

The Dashboard page shows:
- Per-key stats: request count, tokens used, credits spent
- List of own API keys with create/delete
- A 30-day toggle to see different periods

- [ ] **Step 1: Create `client/src/pages/Dashboard.jsx`**

```jsx
import { useState, useEffect, useCallback } from 'react';
import { getDashboardStats, listKeys, createKey, deleteKey } from '../api/client';

const PERIOD_OPTIONS = [7, 30, 90];

export default function Dashboard() {
  const [stats, setStats] = useState([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [newKeyNote, setNewKeyNote] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getDashboardStats(days);
      setStats(res.stats || []);
    } catch (e) {
      console.error('dashboard load', e);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const handleCreateKey = async () => {
    if (!newKeyNote.trim()) return;
    setCreating(true);
    try {
      await createKey(newKeyNote.trim());
      setNewKeyNote('');
      await load();
    } catch (e) {
      alert('创建失败: ' + e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteKey = async (keyId) => {
    if (!confirm('删除此 API Key？')) return;
    try {
      await deleteKey(keyId);
      await load();
    } catch (e) {
      alert('删除失败');
    }
  };

  const totalTokens = stats.reduce((a, s) => a + (s.total_tokens || 0), 0);
  const totalCredits = stats.reduce((a, s) => a + (s.total_credits || 0), 0);
  const totalRequests = stats.reduce((a, s) => a + (s.request_count || 0), 0);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">盘点</h1>
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                days === d
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
              }`}
            >{d}天</button>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">总请求</div>
          <div className="text-2xl font-bold mt-1">{totalRequests.toLocaleString()}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">总 Token</div>
          <div className="text-2xl font-bold mt-1">{(totalTokens / 1000).toFixed(1)}K</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">消耗积分</div>
          <div className="text-2xl font-bold text-amber-400 mt-1">{totalCredits.toFixed(1)}</div>
        </div>
      </div>

      {/* Per-key breakdown */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">各接入点用量</h2>
          <p className="text-xs text-gray-500 mt-0.5">近 {days} 天，按 API Key 分组</p>
        </div>
        {loading ? (
          <div className="px-5 py-8 text-xs text-gray-600 text-center">加载中…</div>
        ) : (
          <div className="divide-y divide-gray-800/60">
            {stats.map(s => (
              <div key={s.key_id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200 truncate">
                      {s.scene_name ? `${s.icon} ${s.scene_name}` : '🔑'} {s.app_name || s.note || '未命名'}
                    </span>
                  </div>
                  <code className="text-[10px] text-gray-600 font-mono">
                    {s.api_key?.slice(0, 10)}…
                  </code>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-gray-300">{s.request_count} 次</div>
                  <div className="text-[10px] text-gray-500">{(s.total_tokens / 1000).toFixed(1)}K tokens</div>
                </div>
                <div className="text-right shrink-0 w-16">
                  <div className="text-xs text-amber-400 font-mono">-{s.total_credits.toFixed(1)}</div>
                  <div className="text-[10px] text-gray-600">积分</div>
                </div>
                <button
                  onClick={() => handleDeleteKey(s.key_id)}
                  className="text-[10px] text-gray-700 hover:text-red-400 transition-colors shrink-0"
                >删除</button>
              </div>
            ))}
            {stats.length === 0 && (
              <div className="px-5 py-8 text-xs text-gray-600 text-center">
                最近 {days} 天没有消费记录
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create new key */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-gray-200 mb-3">新建 API Key</h2>
        <div className="flex gap-2">
          <input
            value={newKeyNote}
            onChange={e => setNewKeyNote(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
            placeholder="备注，如 Claude Code / Cursor"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600"
          />
          <button
            onClick={handleCreateKey}
            disabled={creating || !newKeyNote.trim()}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >{creating ? '创建中…' : '创建'}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 3: Commit all pending frontend changes together**

```bash
git add client/src/pages/Dashboard.jsx client/src/components/Sidebar.jsx client/src/App.jsx
git commit -m "feat(frontend): add Dashboard (盘点) page with per-key usage analytics"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| Scene routes table | Task 1 |
| API key scene_route_id column | Task 1 |
| Scene route CRUD REST API | Task 2 |
| Scene-aware fallback dispatch | Task 3 |
| Dashboard analytics endpoint | Task 4 |
| Client API functions | Task 5 |
| Gateway.jsx scene routes panel | Task 6 |
| Gateway.jsx scene applications panel | Task 6 |
| 📊 盘点 sidebar item | Task 7 |
| Dashboard.jsx page | Task 8 |
| Both frontend and backend | All tasks |

### Placeholder scan — none found.

### Type consistency

- `scene_route_id` is used as `int | None` in DB functions and as `number | ''` in React state — consistent (empty string converts to null in `bindKeyToScene`).
- `steps` is always parsed from JSON string before returning from API.
- `key_id` flows as `int | None` through `handle_chat`.

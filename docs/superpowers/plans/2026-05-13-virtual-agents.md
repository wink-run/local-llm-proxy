# 虚拟 Agent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员可在后台创建虚拟 Agent（配置 BaseURL + API Key + 模型 + 接口风格），服务端直接 HTTP 转发请求，无需 WebSocket，消费/贡献积分照常运作。

**Architecture:** `VirtualWorkerConnection` 实现与 `WorkerConnection` 相同接口，`send()` 改为发起 HTTP 请求。`WorkerPool` 内部区分真实/虚拟两类列表，`pick()` 真实 Worker 优先。管理员 CRUD 操作后调用 `pool.sync_virtual()` 立即生效。

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, httpx（新增依赖）, Vue 3（admin.html 现有）

---

## 文件列表

| 文件 | 操作 | 说明 |
|------|------|------|
| `server/requirements.txt` | 修改 | 新增 httpx |
| `server/database.py` | 修改 | 迁移函数 + 5 个 CRUD 函数 |
| `server/virtual_worker.py` | 新建 | VirtualWorkerConnection 类 |
| `server/worker_pool.py` | 修改 | _virtual 列表 + sync_virtual + pick 优先级 |
| `server/admin_router.py` | 修改 | CRUD 端点 + _sync_virtual_pool |
| `server/server.py` | 修改 | lifespan 启动时同步 |
| `server/static/admin.html` | 修改 | 虚拟 Agent 标签页 UI |

---

### Task 1: 依赖 + 数据库迁移 + CRUD 函数

**Files:**
- Modify: `server/requirements.txt`
- Modify: `server/database.py`

- [ ] **Step 1: 在 requirements.txt 末尾追加 httpx**

```
httpx==0.27.2
```

- [ ] **Step 2: 在 database.py 的 `init_db()` 末尾追加迁移调用**

在 `await _migrate_checkins()` 这行之后添加：

```python
    await _migrate_virtual_agents()
```

- [ ] **Step 3: 在 database.py 中 `_migrate_checkins()` 函数之后插入迁移函数**

```python
async def _migrate_virtual_agents() -> None:
    """补齐 virtual_agents 表和 users.is_virtual 列（早期数据库无此结构）"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("PRAGMA table_info(users)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "is_virtual" not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN is_virtual INTEGER DEFAULT 0")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS virtual_agents (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                base_url   TEXT NOT NULL,
                api_key    TEXT NOT NULL,
                api_style  TEXT NOT NULL DEFAULT 'openai',
                models     TEXT NOT NULL DEFAULT '[]',
                enabled    INTEGER DEFAULT 1,
                user_id    INTEGER REFERENCES users(id),
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.commit()
```

- [ ] **Step 4: 在 database.py 末尾（`get_wall_users` 之后）追加 5 个 CRUD 函数**

```python
# ── virtual_agents ────────────────────────────────────────────────────────────

async def create_virtual_agent(name: str, base_url: str, api_key: str,
                                api_style: str, models_list: list,
                                enabled: bool = True) -> dict:
    """创建虚拟 Agent，同时创建关联虚拟账户，返回新记录。"""
    import json as _json
    ref_code = "VREF-" + secrets.token_urlsafe(6).upper()
    worker_key = "vwk-" + secrets.token_urlsafe(32)
    virtual_email = f"virtual-{secrets.token_urlsafe(8)}@virtual.local"
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO users
               (email, nickname, password_hash, referral_code, worker_key, is_virtual, can_create_apikey)
               VALUES (?,?,?,?,?,1,0)""",
            (virtual_email, name, "", ref_code, worker_key),
        )
        virtual_user_id = cur.lastrowid
        models_json = _json.dumps(models_list)
        cur2 = await db.execute(
            """INSERT INTO virtual_agents (name, base_url, api_key, api_style, models, enabled, user_id)
               VALUES (?,?,?,?,?,?,?)""",
            (name, base_url, api_key, api_style, models_json, int(enabled), virtual_user_id),
        )
        await db.commit()
        return {
            "id": cur2.lastrowid, "name": name, "base_url": base_url,
            "api_style": api_style, "models": models_list,
            "enabled": int(enabled), "user_id": virtual_user_id,
        }


async def list_virtual_agents(enabled_only: bool = False) -> list:
    import json as _json
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        sql = "SELECT * FROM virtual_agents"
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY created_at DESC"
        async with db.execute(sql) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        r["models"] = _json.loads(r["models"] or "[]")
    return rows


async def get_virtual_agent(agent_id: int) -> Optional[dict]:
    import json as _json
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM virtual_agents WHERE id=?", (agent_id,)) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    row["models"] = _json.loads(row["models"] or "[]")
    return row


async def update_virtual_agent(agent_id: int, name: str, base_url: str,
                                api_key: str, api_style: str,
                                models_list: list, enabled: bool) -> None:
    """api_key 为空串时不更新密钥字段。"""
    import json as _json
    models_json = _json.dumps(models_list)
    async with aiosqlite.connect(DB_PATH) as db:
        if api_key:
            await db.execute(
                """UPDATE virtual_agents
                   SET name=?,base_url=?,api_key=?,api_style=?,models=?,enabled=?
                   WHERE id=?""",
                (name, base_url, api_key, api_style, models_json, int(enabled), agent_id),
            )
        else:
            await db.execute(
                """UPDATE virtual_agents
                   SET name=?,base_url=?,api_style=?,models=?,enabled=?
                   WHERE id=?""",
                (name, base_url, api_style, models_json, int(enabled), agent_id),
            )
        # 同步虚拟账户昵称
        await db.execute(
            "UPDATE users SET nickname=? WHERE id=(SELECT user_id FROM virtual_agents WHERE id=?)",
            (name, agent_id),
        )
        await db.commit()


async def delete_virtual_agent(agent_id: int) -> None:
    """删除虚拟 Agent 记录（保留虚拟用户账户以保留积分历史）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM virtual_agents WHERE id=?", (agent_id,))
        await db.commit()
```

- [ ] **Step 5: 验证语法**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python -c "import database; print('OK')"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add server/requirements.txt server/database.py
git commit -m "feat: add virtual_agents DB migration and CRUD functions"
```

---

### Task 2: VirtualWorkerConnection（server/virtual_worker.py）

**Files:**
- Create: `server/virtual_worker.py`

- [ ] **Step 1: 创建完整文件**

```python
"""虚拟 Worker：无需 WebSocket，直接 HTTP 转发 LLM 请求。"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import httpx


# ── 格式转换工具 ──────────────────────────────────────────────────────────────

def _to_anthropic_body(payload: dict) -> dict:
    """将 OpenAI 格式请求体转换为 Anthropic Messages 格式。"""
    messages = payload.get("messages", [])
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]
    body: dict = {
        "model": payload.get("model", ""),
        "max_tokens": payload.get("max_tokens", 8096),
        "messages": non_system,
        "stream": payload.get("stream", False),
    }
    if system_msgs:
        content = system_msgs[0].get("content", "")
        body["system"] = content if isinstance(content, str) else ""
    return body


def _openai_sse_chunk(text: str, model: str) -> str:
    """将 Anthropic delta text 包装为 OpenAI SSE chunk 行（含末尾 \\n\\n）。"""
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


def _anthropic_resp_to_openai(data: dict) -> dict:
    """将 Anthropic 非流式响应转换为 OpenAI chat completion 格式。"""
    text = "".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    )
    usage = data.get("usage", {})
    prompt_t = int(usage.get("input_tokens") or 0)
    compl_t = int(usage.get("output_tokens") or 0)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "model": data.get("model", ""),
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
        "usage": {
            "prompt_tokens": prompt_t,
            "completion_tokens": compl_t,
            "total_tokens": prompt_t + compl_t,
        },
    }


# ── VirtualWorkerConnection ───────────────────────────────────────────────────

@dataclass
class VirtualWorkerConnection:
    base_url: str
    api_key: str
    api_style: str          # 'openai' 或 'anthropic'
    models: list
    worker_id: str
    name: str
    user_id: Optional[int] = None
    connected_at: datetime = field(default_factory=datetime.now)
    active_requests: int = 0
    pending: dict = field(default_factory=dict)
    period_start: float = field(default_factory=time.time)
    period_stats: dict = field(default_factory=dict)

    async def send(self, data: dict) -> None:
        """dispatch.py 调用此方法分发请求；spawn task 避免阻塞事件循环。"""
        req_id = data.get("req_id")
        payload = data.get("payload", {})
        if not req_id:
            return
        self.active_requests += 1
        asyncio.create_task(self._dispatch(req_id, payload))

    async def _dispatch(self, req_id: str, payload: dict) -> None:
        entry = self.pending.get(req_id)
        if not entry:
            self.active_requests = max(0, self.active_requests - 1)
            return
        q = entry["queue"]
        stream = payload.get("stream", False)
        model = payload.get("model", "")
        try:
            if self.api_style == "anthropic":
                await self._dispatch_anthropic(entry, q, payload, stream, model)
            else:
                await self._dispatch_openai(entry, q, payload, stream, model)
        except Exception as e:
            await q.put(("error", str(e)))
            self.record_complete(model, 0, False, None)
        finally:
            self.pending.pop(req_id, None)
            self.active_requests = max(0, self.active_requests - 1)

    async def _dispatch_openai(self, entry: dict, q: asyncio.Queue,
                                payload: dict, stream: bool, model: str) -> None:
        url = self.base_url.rstrip("/") + "/v1/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        async with httpx.AsyncClient(timeout=120) as client:
            if stream:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        await q.put(("error", f"HTTP {resp.status_code}: {body.decode()}"))
                        self.record_complete(model, 0, False, None)
                        return
                    buf = ""
                    output_tokens = 0
                    async for text in resp.aiter_text():
                        if entry.get("ttft_ms") is None:
                            entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                        buf += text
                        lines = buf.split("\n")
                        buf = lines[-1]
                        for line in lines[:-1]:
                            s = line.strip()
                            if not s or s == "data: [DONE]":
                                continue
                            if s.startswith("data: "):
                                try:
                                    d = json.loads(s[6:])
                                    delta = d.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                    if delta:
                                        output_tokens += len(delta)
                                except Exception:
                                    pass
                                await q.put(("chunk", line + "\n"))
                    await q.put(("done", None))
                    self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))
            else:
                resp = await client.post(url, json=payload, headers=headers)
                if resp.status_code >= 400:
                    await q.put(("error", f"HTTP {resp.status_code}: {resp.text}"))
                    self.record_complete(model, 0, False, None)
                    return
                entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                data = resp.json()
                usage = data.get("usage", {})
                output_tokens = int(
                    usage.get("completion_tokens") or usage.get("output_tokens") or 0
                )
                await q.put(("chunk", resp.text))
                await q.put(("done", None))
                self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))

    async def _dispatch_anthropic(self, entry: dict, q: asyncio.Queue,
                                   payload: dict, stream: bool, model: str) -> None:
        url = self.base_url.rstrip("/") + "/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }
        body = _to_anthropic_body(payload)
        async with httpx.AsyncClient(timeout=120) as client:
            if stream:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    if resp.status_code >= 400:
                        raw = await resp.aread()
                        await q.put(("error", f"HTTP {resp.status_code}: {raw.decode()}"))
                        self.record_complete(model, 0, False, None)
                        return
                    buf = ""
                    current_event: Optional[str] = None
                    output_tokens = 0
                    async for text in resp.aiter_text():
                        if entry.get("ttft_ms") is None:
                            entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                        buf += text
                        lines = buf.split("\n")
                        buf = lines[-1]
                        for line in lines[:-1]:
                            stripped = line.rstrip()
                            if not stripped:
                                current_event = None
                                continue
                            if stripped.startswith("event: "):
                                current_event = stripped[7:].strip()
                            elif stripped.startswith("data: ") and current_event == "content_block_delta":
                                try:
                                    d = json.loads(stripped[6:])
                                    delta_text = d.get("delta", {}).get("text", "")
                                    if delta_text:
                                        output_tokens += len(delta_text)
                                        await q.put(("chunk", _openai_sse_chunk(delta_text, model)))
                                except Exception:
                                    pass
                    await q.put(("done", None))
                    self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))
            else:
                resp = await client.post(url, json=body, headers=headers)
                if resp.status_code >= 400:
                    await q.put(("error", f"HTTP {resp.status_code}: {resp.text}"))
                    self.record_complete(model, 0, False, None)
                    return
                entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                anthropic_data = resp.json()
                openai_data = _anthropic_resp_to_openai(anthropic_data)
                output_tokens = int(anthropic_data.get("usage", {}).get("output_tokens") or 0)
                await q.put(("chunk", json.dumps(openai_data)))
                await q.put(("done", None))
                self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))

    def record_complete(self, model: str, output_tokens: int,
                        success: bool, ttft_ms: Optional[float]) -> None:
        s = self.period_stats.setdefault(
            model,
            {"output_tokens": 0, "requests": 0, "success": 0, "ttft_sum": 0.0, "ttft_count": 0},
        )
        s["output_tokens"] += output_tokens
        s["requests"] += 1
        if success:
            s["success"] += 1
        if success and ttft_ms is not None and ttft_ms >= 0:
            s["ttft_sum"] += ttft_ms
            s["ttft_count"] += 1

    def take_period(self) -> dict:
        snapshot = dict(self.period_stats)
        self.period_stats = {}
        self.period_start = time.time()
        return snapshot

    def period_online_mins(self) -> float:
        return (time.time() - self.period_start) / 60

    def to_dict(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "name": self.name,
            "models": self.models,
            "connected_at": self.connected_at.isoformat(),
            "active_requests": self.active_requests,
            "user_id": self.user_id,
            "is_virtual": True,
        }
```

- [ ] **Step 2: 验证语法**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python -c "from virtual_worker import VirtualWorkerConnection; print('OK')"
```

Expected: `OK`（httpx 若未安装先 `pip install httpx==0.27.2`）

- [ ] **Step 3: Commit**

```bash
git add server/virtual_worker.py
git commit -m "feat: add VirtualWorkerConnection with OpenAI/Anthropic HTTP dispatch"
```

---

### Task 3: WorkerPool 改造（server/worker_pool.py）

**Files:**
- Modify: `server/worker_pool.py`

- [ ] **Step 1: 在文件顶部 import 之后、`WorkerConnection` 定义之前添加 VirtualWorkerConnection 的延迟导入注释**

在 `from typing import Optional` 行之后添加：

```python
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from virtual_worker import VirtualWorkerConnection
```

- [ ] **Step 2: 替换 WorkerPool 类的完整实现**

将现有 `class WorkerPool:` 整体替换为：

```python
class WorkerPool:
    def __init__(self):
        self._workers: list[WorkerConnection] = []
        self._virtual: list = []   # list[VirtualWorkerConnection]

    def add(self, worker: WorkerConnection) -> None:
        self._workers.append(worker)

    def remove(self, worker: WorkerConnection) -> None:
        try:
            self._workers.remove(worker)
        except ValueError:
            pass

    def sync_virtual(self, agents: list[dict]) -> None:
        """从数据库 agent 列表重建虚拟 Worker 列表，立即生效。"""
        from virtual_worker import VirtualWorkerConnection
        self._virtual = [
            VirtualWorkerConnection(
                base_url=a["base_url"],
                api_key=a["api_key"],
                api_style=a["api_style"],
                models=a["models"],
                worker_id=f"vw-{a['id']}",
                name=a["name"],
                user_id=a.get("user_id"),
            )
            for a in agents
            if a.get("enabled")
        ]

    def pick(self, model: str) -> Optional[WorkerConnection]:
        """真实 Worker 优先；无真实 Worker 时选虚拟 Worker。"""
        real = [w for w in self._workers if model in w.models]
        if real:
            return random.choice(real)
        virtual = [v for v in self._virtual if model in v.models]
        return random.choice(virtual) if virtual else None

    def all_models(self) -> list[str]:
        return sorted({m for w in self._workers + self._virtual for m in w.models})

    def list_workers(self) -> list[dict]:
        return [w.to_dict() for w in self._workers + self._virtual]

    def all_workers(self) -> list:
        return list(self._workers + self._virtual)
```

- [ ] **Step 3: 验证语法**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python -c "from worker_pool import pool; print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add server/worker_pool.py
git commit -m "feat: add virtual worker support to WorkerPool with real-worker priority"
```

---

### Task 4: Admin API 端点 + server.py 启动同步

**Files:**
- Modify: `server/admin_router.py`
- Modify: `server/server.py`

- [ ] **Step 1: 在 admin_router.py 的现有 import 之后添加同步辅助函数**

在 `ADMIN_KEY = ...` 行之前插入：

```python
async def _sync_virtual_pool() -> None:
    """从数据库重新加载所有启用的虚拟 Agent 到 pool。"""
    agents = await db.list_virtual_agents(enabled_only=True)
    pool.sync_virtual(agents)
```

- [ ] **Step 2: 在 admin_router.py 末尾（`set_config` 函数之后）追加虚拟 Agent CRUD 端点**

```python
# ── 虚拟 Agent ────────────────────────────────────────────────────────────────

@router.get("/virtual-agents", dependencies=[Depends(auth_admin)])
async def list_virtual_agents():
    agents = await db.list_virtual_agents()
    # api_key 脱敏
    for a in agents:
        a["api_key"] = a["api_key"][:6] + "****" if len(a.get("api_key", "")) > 6 else "****"
    return {"agents": agents}


class VirtualAgentRequest(BaseModel):
    name: str
    base_url: str
    api_key: str
    api_style: str = "openai"   # openai 或 anthropic
    models: list[str] = []
    enabled: bool = True


@router.post("/virtual-agents", dependencies=[Depends(auth_admin)])
async def create_virtual_agent(req: VirtualAgentRequest):
    if req.api_style not in ("openai", "anthropic"):
        raise HTTPException(400, "api_style 必须是 openai 或 anthropic")
    if not req.name.strip():
        raise HTTPException(400, "name 不能为空")
    if not req.base_url.strip():
        raise HTTPException(400, "base_url 不能为空")
    if not req.api_key.strip():
        raise HTTPException(400, "api_key 不能为空")
    agent = await db.create_virtual_agent(
        req.name.strip(), req.base_url.strip(), req.api_key.strip(),
        req.api_style, req.models, req.enabled,
    )
    await _sync_virtual_pool()
    return {"ok": True, "agent": agent}


class UpdateVirtualAgentRequest(BaseModel):
    name: str
    base_url: str
    api_key: str = ""   # 留空则不更新
    api_style: str = "openai"
    models: list[str] = []
    enabled: bool = True


@router.patch("/virtual-agents/{agent_id}", dependencies=[Depends(auth_admin)])
async def update_virtual_agent(agent_id: int, req: UpdateVirtualAgentRequest):
    if req.api_style not in ("openai", "anthropic"):
        raise HTTPException(400, "api_style 必须是 openai 或 anthropic")
    existing = await db.get_virtual_agent(agent_id)
    if not existing:
        raise HTTPException(404, "Virtual agent not found")
    await db.update_virtual_agent(
        agent_id, req.name.strip(), req.base_url.strip(), req.api_key.strip(),
        req.api_style, req.models, req.enabled,
    )
    await _sync_virtual_pool()
    return {"ok": True}


@router.delete("/virtual-agents/{agent_id}", dependencies=[Depends(auth_admin)])
async def delete_virtual_agent(agent_id: int):
    existing = await db.get_virtual_agent(agent_id)
    if not existing:
        raise HTTPException(404, "Virtual agent not found")
    await db.delete_virtual_agent(agent_id)
    await _sync_virtual_pool()
    return {"ok": True}
```

- [ ] **Step 3: 在 server.py 的 lifespan 函数中启动时同步虚拟 Agent**

找到：
```python
    await db.init_db()
    logger.info("Database ready")
```

改为：
```python
    await db.init_db()
    logger.info("Database ready")
    from admin_router import _sync_virtual_pool
    await _sync_virtual_pool()
    logger.info("Virtual agents synced")
```

- [ ] **Step 4: 验证语法**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python -c "import admin_router; import server; print('OK')"
```

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add server/admin_router.py server/server.py
git commit -m "feat: add virtual agent CRUD API endpoints and startup pool sync"
```

---

### Task 5: admin.html 虚拟 Agent 标签页

**Files:**
- Modify: `server/static/admin.html`

这个任务在现有 Vue 3 单文件页面上扩展，需要四处修改：标签定义、Vue data、Vue methods、Tab 内容 HTML。

- [ ] **Step 1: 在 `tabs` 数组中添加虚拟 Agent 标签**

找到 JS 中 `tabs` 数组定义（搜索 `{ key: 'workers'` 附近），在数组末尾追加（各语言版本均需添加）：

找到：
```javascript
tabs() {
```
在 tabs computed 中找到数组末尾（在 `{ key: 'config', label: this.T.config }` 之后），追加：
```javascript
{ key: 'virtual', label: this.T.virtualAgents },
```

- [ ] **Step 2: 在 T（翻译对象）中添加虚拟 Agent 相关文本**

找到 JS 中翻译对象 `zh:` 和 `en:` 的定义，分别添加以下键值（在各自对象末尾追加）：

在 `zh:` 对象末尾追加：
```javascript
virtualAgents: '虚拟 Agent',
vaName: '名称', vaBaseUrl: 'BaseURL', vaApiKey: 'API Key',
vaStyle: '接口风格', vaModels: '模型列表', vaEnabled: '启用',
vaCreate: '创建虚拟 Agent', vaEdit: '编辑', vaDelete: '删除',
vaSave: '保存', vaCancel: '取消',
vaModelsTip: '每行一个模型名',
vaSynced: '已同步至 pool，立即生效',
vaStyleOai: 'OpenAI', vaStyleAnthropic: 'Anthropic',
vaNoAgents: '暂无虚拟 Agent',
```

在 `en:` 对象末尾追加：
```javascript
virtualAgents: 'Virtual Agents',
vaName: 'Name', vaBaseUrl: 'BaseURL', vaApiKey: 'API Key',
vaStyle: 'API Style', vaModels: 'Models', vaEnabled: 'Enabled',
vaCreate: 'Create Virtual Agent', vaEdit: 'Edit', vaDelete: 'Delete',
vaSave: 'Save', vaCancel: 'Cancel',
vaModelsTip: 'One model name per line',
vaSynced: 'Synced to pool — effective immediately',
vaStyleOai: 'OpenAI', vaStyleAnthropic: 'Anthropic',
vaNoAgents: 'No virtual agents yet',
```

- [ ] **Step 3: 在 Vue `data()` 中添加虚拟 Agent 状态**

找到 `data()` 函数中现有字段（如 `workers: []` 附近），追加：

```javascript
virtualAgents: [],
vaForm: { id: null, name: '', base_url: '', api_key: '', api_style: 'openai', models: '', enabled: true },
vaShowModal: false,
vaSyncMsg: '',
```

- [ ] **Step 4: 在 `methods` 中添加虚拟 Agent 方法**

在 `methods` 对象末尾追加：

```javascript
async fetchVirtualAgents() {
  const r = await this.api('GET', '/admin/virtual-agents');
  if (r) this.virtualAgents = r.agents || [];
},
vaOpenCreate() {
  this.vaForm = { id: null, name: '', base_url: '', api_key: '', api_style: 'openai', models: '', enabled: true };
  this.vaShowModal = true;
  this.vaSyncMsg = '';
},
vaOpenEdit(a) {
  this.vaForm = { id: a.id, name: a.name, base_url: a.base_url, api_key: '', api_style: a.api_style, models: a.models.join('\n'), enabled: !!a.enabled };
  this.vaShowModal = true;
  this.vaSyncMsg = '';
},
async vaSave() {
  const models = this.vaForm.models.split('\n').map(s => s.trim()).filter(Boolean);
  const body = { name: this.vaForm.name, base_url: this.vaForm.base_url, api_key: this.vaForm.api_key, api_style: this.vaForm.api_style, models, enabled: this.vaForm.enabled };
  let ok;
  if (this.vaForm.id) {
    ok = await this.api('PATCH', `/admin/virtual-agents/${this.vaForm.id}`, body);
  } else {
    ok = await this.api('POST', '/admin/virtual-agents', body);
  }
  if (ok) { this.vaSyncMsg = this.T.vaSynced; await this.fetchVirtualAgents(); this.vaShowModal = false; }
},
async vaToggle(a) {
  await this.api('PATCH', `/admin/virtual-agents/${a.id}`, { name: a.name, base_url: a.base_url, api_key: '', api_style: a.api_style, models: a.models, enabled: !a.enabled });
  await this.fetchVirtualAgents();
},
async vaDelete(a) {
  if (!confirm(`删除虚拟 Agent「${a.name}」？`)) return;
  await this.api('DELETE', `/admin/virtual-agents/${a.id}`);
  await this.fetchVirtualAgents();
},
```

- [ ] **Step 5: 在 switchTab 方法中添加 virtual 标签的数据加载**

找到 `switchTab(key)` 方法，在现有分支之后追加：

```javascript
if (key === 'virtual') this.fetchVirtualAgents();
```

- [ ] **Step 6: 在 HTML 中添加虚拟 Agent 标签页内容**

在最后一个 `</div>` 关闭标签之前（即 `</div>` 结束 `v-else class="app"` 之前），在现有最后一个 tab-content div 之后追加：

```html
<!-- Virtual Agents Tab -->
<div v-show="activeTab === 'virtual'" class="tab-content">
  <div class="toolbar">
    <button class="btn btn-indigo" @click="vaOpenCreate">+ {{ T.vaCreate }}</button>
    <span v-if="vaSyncMsg" style="color:#86efac;font-size:13px;margin-left:12px">{{ vaSyncMsg }}</span>
    <button class="btn-sm toolbar-right" @click="fetchVirtualAgents">{{ T.refresh }}</button>
  </div>
  <table>
    <thead>
      <tr>
        <th>{{ T.vaName }}</th>
        <th>{{ T.vaBaseUrl }}</th>
        <th>{{ T.vaStyle }}</th>
        <th>{{ T.vaModels }}</th>
        <th>{{ T.vaEnabled }}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="virtualAgents.length === 0" class="empty-row"><td colspan="6">{{ T.vaNoAgents }}</td></tr>
      <tr v-for="a in virtualAgents" :key="a.id" :class="{ inactive: !a.enabled }">
        <td>{{ a.name }}</td>
        <td class="mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="a.base_url">{{ a.base_url }}</td>
        <td><span :class="a.api_style === 'anthropic' ? 'badge badge-blue' : 'badge badge-green'">{{ a.api_style === 'anthropic' ? T.vaStyleAnthropic : T.vaStyleOai }}</span></td>
        <td><span v-for="m in a.models" :key="m" class="tag">{{ m }}</span></td>
        <td>
          <span :class="a.enabled ? 'badge badge-on' : 'badge badge-off'">{{ a.enabled ? 'ON' : 'OFF' }}</span>
        </td>
        <td>
          <button class="btn-xs" @click="vaOpenEdit(a)">{{ T.vaEdit }}</button>
          <button class="btn-xs" @click="vaToggle(a)">{{ a.enabled ? 'Disable' : 'Enable' }}</button>
          <button class="btn-xs btn-danger" @click="vaDelete(a)">{{ T.vaDelete }}</button>
        </td>
      </tr>
    </tbody>
  </table>

  <!-- Create/Edit Modal -->
  <div v-if="vaShowModal" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100">
    <div style="background:#1a1d27;border:1px solid #2d3148;border-radius:12px;padding:28px;width:480px;max-width:95vw">
      <h3 style="font-size:16px;font-weight:600;color:#fff;margin-bottom:20px">{{ vaForm.id ? T.vaEdit : T.vaCreate }}</h3>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label>{{ T.vaName }}</label>
          <input v-model="vaForm.name" class="form-input form-input-lg" placeholder="My LLM Service" />
        </div>
        <div class="form-group">
          <label>{{ T.vaBaseUrl }}</label>
          <input v-model="vaForm.base_url" class="form-input form-input-lg" placeholder="https://api.openai.com" />
        </div>
        <div class="form-group">
          <label>{{ T.vaApiKey }}{{ vaForm.id ? ' (留空不修改)' : '' }}</label>
          <input v-model="vaForm.api_key" type="password" class="form-input form-input-lg" placeholder="sk-..." />
        </div>
        <div class="form-group">
          <label>{{ T.vaStyle }}</label>
          <select v-model="vaForm.api_style" class="form-input form-input-md">
            <option value="openai">{{ T.vaStyleOai }}</option>
            <option value="anthropic">{{ T.vaStyleAnthropic }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>{{ T.vaModels }} <span style="color:#64748b;font-size:11px">{{ T.vaModelsTip }}</span></label>
          <textarea v-model="vaForm.models" class="form-input" rows="4" style="width:100%;resize:vertical" placeholder="gpt-4o&#10;gpt-4-turbo"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <label style="font-size:13px;color:#94a3b8">{{ T.vaEnabled }}</label>
          <input type="checkbox" v-model="vaForm.enabled" style="width:16px;height:16px;accent-color:#6366f1" />
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px">
        <button class="btn-sm" @click="vaShowModal=false">{{ T.vaCancel }}</button>
        <button class="btn btn-indigo" @click="vaSave">{{ T.vaSave }}</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 7: 验证 HTML 格式无误**

```bash
python3 -c "
from html.parser import HTMLParser
class V(HTMLParser): pass
V().feed(open('server/static/admin.html').read())
print('HTML OK')
"
```

Expected: `HTML OK`

- [ ] **Step 8: Commit**

```bash
git add server/static/admin.html
git commit -m "feat: add virtual agents tab to admin UI with CRUD modal"
```

---

### Task 6: 安装依赖并验证服务启动

**Files:** 无代码修改

- [ ] **Step 1: 安装 httpx**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
pip install httpx==0.27.2
```

Expected: `Successfully installed httpx-0.27.2` 或 `Requirement already satisfied`

- [ ] **Step 2: 启动服务，确认无报错**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
uvicorn server:app --port 8000 --reload
```

Expected 日志中出现：
```
Database ready
Virtual agents synced
```
无 ImportError / AttributeError。

- [ ] **Step 3: 访问管理后台，确认虚拟 Agent 标签页可见**

浏览器打开 `http://localhost:8000/admin/ui`，登录后确认导航栏出现「虚拟 Agent」标签。

- [ ] **Step 4: 创建一条虚拟 Agent 并验证同步**

在「虚拟 Agent」标签页点击「创建虚拟 Agent」，填入：
- 名称：Test Agent
- BaseURL：`http://localhost:11434`
- API Key：`test`
- 接口风格：OpenAI
- 模型：`llama3`

点保存，确认出现「已同步至 pool，立即生效」提示，列表中出现新条目。

- [ ] **Step 5: 验证 Workers 标签页可见虚拟 Agent（合并在列表中）**

切到「Workers」标签，刷新，确认 Test Agent 显示在列表中（`is_virtual: true`）。

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "feat: virtual agents complete — HTTP proxy workers with admin CRUD"
```

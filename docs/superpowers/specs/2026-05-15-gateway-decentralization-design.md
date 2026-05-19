# Gateway 去中心化设计文档

> 状态：待实现
> 日期：2026-05-15

---

## 1. 目标

解决现有架构中 VPS 单点问题，实现 gateway 层的去中心化，同时保持单一代码库和单一数据库。

| 痛点 | 解法 |
|------|------|
| 单个 IP 被封 | 多 gateway 多 IP，用户任选其一 |
| gateway 单点故障 | 任意 gateway 挂掉不影响其他节点 |
| 横向扩容 | gateway 无状态，随意增加节点 |
| 积分中枢单点 | 共享 PostgreSQL，原子操作保证一致性 |
| 大屏跨节点可见性 | PostgreSQL LISTEN/NOTIFY 实时广播 |

---

## 2. 整体架构

```
外部用户
  │
  ├─ Gateway A（任意一个）
  ├─ Gateway B
  └─ Gateway C
         │
         │ 共享 PostgreSQL（原 VPS 或独立 DB 主机）
         │
  Worker（多宿主，同时连接所有 gateway）
```

### 2.1 Gateway 节点特性

- 无状态：worker pool 在内存中，不持久化
- 可独立部署：只需配置 `DATABASE_URL` 和已知 gateway 列表
- 完全相同的代码镜像，通过环境变量区分

### 2.2 Worker 多宿主

Worker 启动时从配置读取多个 gateway 地址，同时建立并发维持多条 WebSocket 连接。每条连接独立处理请求，互不干扰。某个 gateway 挂掉后，该连接自动重连，其他连接不受影响。

```
Worker → ws://gateway-a:8000/ws/worker  ┐
Worker → ws://gateway-b:8000/ws/worker  ├ 并发，各自独立
Worker → ws://gateway-c:8000/ws/worker  ┘
```

### 2.3 积分结算

每个 gateway 独立运行 settler，只结算流经本节点的流量，不重复计算。多个 settler 并发写库时，`credits_balance` 使用 PostgreSQL 原子更新（`credits_balance + delta`），避免竞态。

### 2.4 大屏跨节点广播

Worker 上线/下线时，所在 gateway 向 PostgreSQL 发送 `NOTIFY worker_events`，其他 gateway 通过 `LISTEN` 接收通知，推送给各自的 SSE 订阅者，实现全网 worker 状态实时同步。

---

## 3. 数据库迁移：SQLite → PostgreSQL

### 3.1 驱动替换

| 项目 | 变更前 | 变更后 |
|------|--------|--------|
| 驱动 | `aiosqlite` | `asyncpg` |
| 连接方式 | 文件路径 `proxy.db` | `DATABASE_URL` 环境变量 |
| 占位符 | `?` | `$1, $2, ...` |
| 自增主键 | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| 布尔值 | `INTEGER (0/1)` | `BOOLEAN` |
| 日期默认值 | `datetime('now')` | `NOW()` |

### 3.2 credits_balance 原子更新

所有涉及余额变动的操作必须使用原子 SQL，禁止先读后写：

```sql
-- 禁止
SELECT credits_balance FROM users WHERE id = $1;
UPDATE users SET credits_balance = $new WHERE id = $1;

-- 正确
UPDATE users SET
    credits_balance = credits_balance + $1,
    credits_earned  = credits_earned  + GREATEST($1, 0),
    credits_spent   = credits_spent   + GREATEST(-$1, 0)
WHERE id = $2;
```

### 3.3 连接池

`asyncpg` 使用连接池（`asyncpg.create_pool`），在 `lifespan` 中初始化，注入全局。推荐配置：`min_size=2, max_size=10`。

---

## 4. 文件改动清单

### 4.1 `server/database.py`（重写）

- 驱动替换为 `asyncpg`
- 所有 SQL 占位符从 `?` 改为 `$1, $2, ...`
- `award_credits` 改为原子 UPDATE
- `init_db()` 改为执行 PostgreSQL 建表 DDL

### 4.2 `agent/agent.py`（中等改动）

- `--server` 选项支持多个值（逗号分隔或多次传入）
- `run()` 改为并发启动多个 `connect_and_serve()` 协程
- 每个协程独立维护重连逻辑，某条连接断开不影响其他

核心结构变化：
```python
# 变更前
async def run(server_url, ...):
    await connect_and_serve(server_url, ...)

# 变更后
async def run(server_urls: list[str], ...):
    await asyncio.gather(*[
        connect_and_serve(url, ...) for url in server_urls
    ])
```

### 4.3 `server/server.py`（小改动）

Worker WebSocket 连接/断开时，增加 PostgreSQL NOTIFY：

```python
# worker 上线
await db.notify("worker_events", json.dumps({
    "event": "online",
    "worker_id": worker.worker_id,
    "models": worker.models,
    "name": worker.name,
}))

# worker 下线
await db.notify("worker_events", json.dumps({
    "event": "offline",
    "worker_id": worker.worker_id,
}))
```

启动时开启后台协程监听 `worker_events` channel，收到通知后推给 SSE 广播器。

### 4.4 `docker-compose.yml`（新增 PostgreSQL 服务）

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: proxy
      POSTGRES_USER: proxy
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  server:
    build: ./server
    environment:
      DATABASE_URL: postgresql://proxy:${POSTGRES_PASSWORD}@postgres:5432/proxy
    depends_on:
      - postgres

volumes:
  postgres_data:
```

### 4.5 `.env.example`（新增变量）

```
DATABASE_URL=postgresql://proxy:password@localhost:5432/proxy
POSTGRES_PASSWORD=change-me
```

### 4.6 不需要改动的文件

| 文件 | 原因 |
|------|------|
| `server/dispatch.py` | 只读本地 pool，逻辑不变 |
| `server/worker_pool.py` | 内存对象，与 DB 无关 |
| `server/auth.py` | JWT 无状态，只需共享 `JWT_SECRET` 环境变量 |
| `server/admin_router.py` | 业务逻辑不变，DB 调用通过 database.py 隔离 |
| `server/user_router.py` | 同上 |
| `server/settler.py` | 逻辑不变，原子 DB 操作在 database.py 层保证 |
| 所有前端静态文件 | 无变化 |

---

## 5. LISTEN/NOTIFY 实现细节

### 5.1 database.py 新增两个函数

```python
async def notify(channel: str, payload: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(f"NOTIFY {channel}, $1", payload)

async def listen(channel: str, callback) -> None:
    conn = await pool.acquire()  # 专用连接，不归还
    await conn.add_listener(channel, callback)
    # 保持连接存活，由调用方管理生命周期
```

### 5.2 server.py 启动监听

```python
async def on_worker_event(conn, pid, channel, payload):
    data = json.loads(payload)
    await dashboard_broadcast(data)  # 推给 SSE 客户端

asyncio.create_task(db.listen("worker_events", on_worker_event))
```

---

## 6. 部署方式

每个 gateway 节点部署相同镜像，环境变量只有两处差异：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | 指向同一个 PostgreSQL 实例 |
| `JWT_SECRET` | 所有节点必须相同（用于验证用户 token） |

Worker 配置示例：

```bash
llm-agent start \
  --server ws://gateway-a.example.com/ws/worker,ws://gateway-b.example.com/ws/worker \
  --models qwen3-32b
```

---

## 7. 迁移策略

1. 本地启动 PostgreSQL，运行迁移脚本将现有 `proxy.db` 数据导入
2. 单节点跑通（功能等价于现有 SQLite 版本）
3. 部署第二个 gateway 节点，验证 worker 多宿主和大屏跨节点同步
4. 逐步扩展节点数量

---

## 8. 已知限制

- PostgreSQL 实例本身仍是单点；如需 DB 高可用，后续可接入 PostgreSQL 主从或托管服务（RDS/Supabase）
- Worker 需要重新配置 `--server` 参数以连接多个 gateway，现有已部署的 agent 需要更新

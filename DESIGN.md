# Local LLM Proxy — 设计文档

## 1. 项目概述

让用户能够在非局域网内，访问局域网内才能授权访问的大模型接口。

本地 PC 主动向 VPS 建立 WebSocket 长连接，将自身内网 LLM 能力"贡献"到云端，
外部用户通过 VPS 的 OpenAI 兼容接口发起请求，由 VPS 路由至合适的本地 PC 处理后实时回传。

---

## 2. 整体架构

```
外部用户 (any OpenAI client)
    │  HTTP  Bearer USER_API_KEY
    ▼
┌─────────────────────────────────────────────┐
│              VPS (Docker Compose)            │
│                                             │
│   FastAPI + uvicorn  (0.0.0.0:8000)         │
│     ├─ /v1/*          用户 API              │
│     ├─ /admin/*       管理 API              │
│     ├─ /admin/ui      Web 控制台            │
│     └─ /ws/worker     Worker 接入           │
│                                             │
│   SQLite  proxy.db                          │
│     └─ api_keys 表                          │
└────────────────┬────────────────────────────┘
                 │ ws://  (本地主动发起，穿透 NAT)
    ┌────────────┴────────────┐
    │                         │
┌───▼──────────────┐  ┌───────▼──────────────┐
│  本地 PC A        │  │  本地 PC B            │
│  llm-agent 二进制 │  │  llm-agent 二进制     │
│                  │  │                      │
│  baseURL:        │  │  baseURL:             │
│  http://gpu1:80  │  │  http://localhost:11434│
│                  │  │                      │
│  models:         │  │  models:              │
│  - qwen3-32b     │  │  - deepseek-r1        │
│  - qwen3-7b      │  │  - qwen3-32b          │
└──────────────────┘  └──────────────────────┘
```

---

## 3. 组件详细设计

### 3.1 服务端 (VPS)

#### 3.1.1 模块划分

| 文件 | 职责 |
|------|------|
| `server.py` | FastAPI 主程序，启动入口 |
| `worker_pool.py` | Worker 连接池（纯内存），管理在线 PC 列表 |
| `database.py` | SQLite 操作（api_keys 表） |
| `admin_router.py` | 管理接口路由 |
| `static/admin.html` | Web 控制台（Vue CDN） |

#### 3.1.2 Worker 连接池（内存）

```
WorkerPool
├── workers: list[WorkerConnection]
├── add(worker)
├── remove(worker)
├── pick(model) → 随机选取支持该 model 的 Worker
└── all_models() → 聚合所有在线 Worker 的模型列表

WorkerConnection
├── ws            WebSocket 句柄
├── worker_id     8位随机ID（服务端生成）
├── name          PC名称（Agent上报）
├── models        支持的模型列表
├── connected_at  接入时间
├── active_requests  当前活跃请求数
├── pending       {req_id → asyncio.Queue}  请求队列映射
└── send(msg)     加锁的WebSocket写入
```

#### 3.1.3 WebSocket 消息协议

**握手阶段（Agent → Server）**
```json
{ "type": "register", "token": "<WORKER_TOKEN>", "name": "my-pc", "models": ["qwen3-32b", "qwen3-7b"] }
```

**握手响应（Server → Agent）**
```json
{ "type": "registered", "worker_id": "a1b2c3d4" }
```

**请求分发（Server → Agent）**
```json
{ "type": "request", "req_id": "uuid", "payload": { ...OpenAI请求体... } }
```

**流式回包（Agent → Server，流式模式）**
```json
{ "type": "chunk", "req_id": "uuid", "data": "data: {...}\n\n" }
```

**非流式回包（Agent → Server，非流式模式）**
```json
{ "type": "chunk", "req_id": "uuid", "data": "{...完整响应JSON字符串...}" }
```

**请求完成（Agent → Server）**
```json
{ "type": "done", "req_id": "uuid" }
```

**请求报错（Agent → Server）**
```json
{ "type": "error", "req_id": "uuid", "error": "错误信息" }
```

#### 3.1.4 请求路由流程

```
POST /v1/chat/completions
  │
  ├─ 验证 USER_API_KEY（查 SQLite，检查 is_active）
  │
  ├─ WorkerPool.pick(model)  →  随机选一个支持该模型的 Worker
  │   └─ 无可用 Worker → 返回 503
  │
  ├─ 生成 req_id，创建 asyncio.Queue，注册到 worker.pending
  │
  ├─ 通过 WebSocket 发送 request 消息给 Worker
  │
  └─ stream=true  → StreamingResponse，从 Queue 读 chunk 逐条转发 SSE
     stream=false → 等待第一个 chunk，解析为 JSON 返回

断线处理：
  Worker WebSocket 断开 → finally 块向所有 pending Queue 写入 error 信号
  → 各 HTTP handler 收到 error → 返回 502
```

#### 3.1.5 认证体系

| 角色 | 凭证 | 来源 | 用途 |
|------|------|------|------|
| 最终用户 | `USER_API_KEY`（`sk-xxx`） | SQLite api_keys 表 | 调用 `/v1/*` |
| 本地 Agent | `WORKER_TOKEN` | 环境变量 | 建立 WebSocket 连接 |
| 管理员 | `ADMIN_KEY` | 环境变量 | 调用 `/admin/*` 和调试接口 |

### 3.2 数据库（SQLite）

#### api_keys 表

```sql
CREATE TABLE api_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT    UNIQUE NOT NULL,       -- sk- 前缀随机串
    note       TEXT    DEFAULT '',            -- 备注（用途/归属人）
    is_active  INTEGER DEFAULT 1,             -- 1=启用 0=禁用
    created_at TEXT    DEFAULT (datetime('now'))
);
```

#### 日志

不写入 SQLite，通过 Python logging 输出至标准输出，由 Docker 的日志驱动管理。
日志格式：`[时间] [级别] [模块] 内容`

### 3.3 管理接口 (`/admin/*`)

所有接口均需 `Authorization: Bearer <ADMIN_KEY>`。

| Method | Path | 说明 |
|--------|------|------|
| GET | `/admin/ui` | 返回 Web 控制台 HTML |
| GET | `/admin/workers` | 在线 Worker 列表（实时）|
| GET | `/admin/keys` | API Key 列表 |
| POST | `/admin/keys` | 创建新 Key，body: `{"note":"..."}` |
| PATCH | `/admin/keys/{id}` | 启用/禁用，body: `{"is_active":true}` |
| DELETE | `/admin/keys/{id}` | 删除 Key |
| POST | `/admin/debug/chat` | 调试对话，转发至 Worker（用 ADMIN_KEY 鉴权）|

### 3.4 用户接口 (`/v1/*`)

兼容 OpenAI API 格式。

| Method | Path | 说明 |
|--------|------|------|
| GET | `/v1/models` | 返回所有在线 Worker 聚合的模型列表 |
| POST | `/v1/chat/completions` | 对话接口，支持 stream=true/false |

---

## 4. Web 控制台 (Admin UI)

**技术栈**：Vue 3 CDN + Axios，单文件 HTML，无构建步骤。

**首次访问**：弹出输入框要求填写 ADMIN_KEY，保存至 `localStorage`。

**三个 Tab 页：**

### Tab 1：在线 PC
- 每 5 秒轮询 `/admin/workers`
- 表格列：名称 | Worker ID | 支持模型 | 接入时间 | 当前请求数 | 状态

### Tab 2：API Key 管理
- 展示所有 Key（Key 值脱敏显示，点击可复制完整值）
- 表格列：ID | Key（部分显示） | 备注 | 状态 | 创建时间 | 操作（启用/禁用/删除）
- 顶部「新建 Key」按钮，填写备注后生成

### Tab 3：调试窗口
- 模型选择下拉框（从 `/admin/workers` 聚合）
- 多轮对话 UI（消息气泡样式）
- 输入框 + 发送按钮，Enter 发送
- 调用 `/admin/debug/chat`（stream=true），流式渲染输出
- 「清空对话」按钮

---

## 5. 本地 PC Agent

### 5.1 功能

- 建立并维持到 VPS 的 WebSocket 长连接
- 注册本机名称和支持的模型列表
- 并发处理多个请求（asyncio.create_task）
- 流式/非流式转发至内网 LLM API
- WebSocket 断线自动重连（5 秒后重试）

### 5.2 分发方式

通过 PyInstaller 打包为单一可执行二进制文件，支持三个平台：

| 平台 | 文件名 |
|------|--------|
| Windows x64 | `llm-agent-win-x64.exe` |
| macOS arm64 | `llm-agent-macos-arm64` |
| Linux x64 | `llm-agent-linux-x64` |

打包后无需 Python 环境，直接运行。

### 5.3 CLI 命令

```bash
# 注册并保存配置（首次使用）
llm-agent register \
  --server ws://your-vps.com/ws/worker \
  --token <WORKER_TOKEN> \
  --models qwen3-32b,qwen3-7b \
  --llm-url http://localhost:11434 \
  --llm-token sk-xxx \        # 可选，内网LLM的鉴权token
  --name "我的工作站"           # 可选，默认使用主机名

# 启动 Agent（使用已保存的配置）
llm-agent start

# 查看当前配置
llm-agent status

# 指定配置文件路径（多实例场景）
llm-agent start --config /path/to/config.json
```

### 5.4 配置文件

保存路径：`~/.llm-agent/config.json`

```json
{
  "server_url": "ws://your-vps.com/ws/worker",
  "worker_token": "change-me-worker",
  "name": "my-workstation",
  "models": ["qwen3-32b", "qwen3-7b"],
  "llm_base_url": "http://localhost:11434",
  "llm_token": ""
}
```

### 5.5 请求处理逻辑

```
收到 request 消息
  │
  ├─ stream=true
  │   └─ httpx 流式请求内网 LLM
  │       └─ 逐行读取 SSE → 发送 chunk 消息（过滤 [DONE]）→ 发送 done
  │
  └─ stream=false
      └─ httpx 普通请求内网 LLM
          └─ 得到完整 JSON → 发送 chunk（含完整响应） → 发送 done

异常 → 发送 error 消息
并发 → 每个请求 asyncio.create_task，共享同一 WebSocket（写入加队列串行化）
```

---

## 6. 部署方案

### 6.1 目录结构

```
local-llm-proxy/
├── server/
│   ├── server.py
│   ├── worker_pool.py
│   ├── database.py
│   ├── admin_router.py
│   ├── static/
│   │   └── admin.html
│   └── requirements.txt
├── agent/
│   ├── agent.py
│   ├── requirements.txt
│   └── build.sh           # PyInstaller 打包脚本
├── docker-compose.yml
└── .env.example
```

### 6.2 docker-compose.yml 结构

```
services:
  proxy:        # FastAPI 服务，直接暴露 8000 端口至公网

volumes:
  db_data:      # SQLite 文件持久化
  logs:         # 日志持久化
```

### 6.3 环境变量（.env）

```
WORKER_TOKEN=   # Agent 接入密钥，自定义强随机串
ADMIN_KEY=      # 管理员密钥，自定义强随机串
REQUEST_TIMEOUT=120
PORT=8000
```

### 6.4 Agent 连接地址

```
ws://your-vps.com:8000/ws/worker
```

---

## 7. 技术选型汇总

| 层次 | 技术 |
|------|------|
| 服务端框架 | FastAPI + uvicorn |
| 异步 | asyncio（原生，无额外依赖） |
| WebSocket 服务端 | FastAPI 内置 |
| WebSocket 客户端 | websockets 库 |
| HTTP 客户端（Agent）| httpx（async） |
| 数据库 | SQLite + aiosqlite |
| CLI（Agent）| click |
| Admin UI | Vue 3 CDN + Axios |
| 打包 | PyInstaller（单文件二进制） |
| 容器化 | Docker Compose |

---

## 8. 关键约束与边界

1. **无持久化 Worker 状态**：Worker 列表仅在内存中，服务重启后需 Agent 重新连接。
2. **无请求队列**：Worker 全忙时直接返回 503，不排队等待。
3. **模型路由为随机**：多个 Worker 支持同一模型时随机选取，不做负载感知。
4. **单 LLM 后端/Agent**：一个 Agent 进程对应一个内网 LLM base URL，
   多模型通过同一 URL 的不同 model 参数区分（如 Ollama 多模型场景）。
5. **无速率限制**：当前版本 API Key 不做 QPS/并发限制。

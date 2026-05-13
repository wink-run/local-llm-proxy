# 虚拟 Agent 设计文档

## 目标

管理员可在后台创建「虚拟 Agent」，配置 LLM 转发服务（BaseURL + API Key + 模型列表 + 接口风格）。虚拟 Agent 无需 WebSocket 连接，服务端直接 HTTP 转发请求。对普通用户而言与真实 Worker 完全透明，消费积分照常扣除，贡献积分归属虚拟 Agent 关联的虚拟账户。

## 架构

采用 **VirtualWorkerConnection 加入现有 pool** 方案：`VirtualWorkerConnection` 实现与 `WorkerConnection` 相同的外部接口，`send()` 改为发起 HTTP 请求。`WorkerPool.pick()` 优先选真实 Worker，没有可用 Worker 时才选虚拟 Worker。`dispatch.py` 和 settler 计费逻辑无需改动。

## 数据模型

### virtual_agents 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增主键 |
| name | TEXT NOT NULL | 展示名称 |
| base_url | TEXT NOT NULL | LLM 服务地址 |
| api_key | TEXT NOT NULL | 服务密钥 |
| api_style | TEXT NOT NULL | `openai` 或 `anthropic` |
| models | TEXT NOT NULL | JSON 数组，如 `["gpt-4o"]` |
| enabled | INTEGER DEFAULT 1 | 0=禁用，1=启用 |
| user_id | INTEGER | FK → users.id（虚拟账户） |
| created_at | TEXT | ISO8601 时间戳 |

### users 表变更

新增 `is_virtual INTEGER DEFAULT 0` 列。创建虚拟 Agent 时同步创建 `is_virtual=1` 的用户（nickname=Agent 名，无邮箱密码），用于接收贡献积分。删除虚拟 Agent 时保留用户记录（保留积分历史）。

## 组件设计

### server/virtual_worker.py（新建）

`VirtualWorkerConnection` 类：
- 字段：`models`, `worker_id`, `name`, `user_id`, `active_requests`, `pending`, `period_stats`，与 `WorkerConnection` 完全一致
- `send(data)` — spawn asyncio task，根据 `api_style` 向 `base_url` 发 HTTP 请求，将结果写入 `pending[req_id]["queue"]`
  - OpenAI 风格：POST `{base_url}/v1/chat/completions`，解析 SSE `data:` 行
  - Anthropic 风格：POST `{base_url}/v1/messages`，解析 `event:` + `data:` 对
  - 流式：每个 chunk 写 `("chunk", data)`，结束写 `("done", None)`，错误写 `("error", msg)`
  - 非流式：完整响应写 `("chunk", json_str)` 后写 `("done", None)`
- `to_dict()` — 返回与 `WorkerConnection.to_dict()` 相同结构，`is_virtual=True` 额外字段
- `record_complete()`, `take_period()`, `period_online_mins()` — 逻辑与 `WorkerConnection` 相同

### server/worker_pool.py（修改）

`WorkerPool` 内部拆分：
- `_workers: list[WorkerConnection]` — 真实 Worker
- `_virtual: list[VirtualWorkerConnection]` — 虚拟 Worker

接口变更：
- `add()` / `remove()` — 仍操作 `_workers`（WebSocket 注册/断开使用）
- `add_virtual()` / `remove_virtual()` / `sync_virtual(agents: list[dict])` — 操作 `_virtual`
- `pick(model)` — 先从 `_workers` 中随机选，选不到再从 `_virtual` 中随机选
- `all_models()` — 合并两个列表
- `list_workers()` / `all_workers()` — 合并两个列表返回

### server/database.py（修改）

新增函数：
- `_migrate_virtual_agents()` — 建表 + 给 users 加 is_virtual 列
- `create_virtual_agent(name, base_url, api_key, api_style, models_list, enabled)` — 创建虚拟用户 + 写 virtual_agents
- `list_virtual_agents(enabled_only=False)` — 查询列表，返回含 models 解析后的 list
- `update_virtual_agent(id, **fields)` — 更新字段（api_key 为空串时不更新）
- `delete_virtual_agent(id)` — 删除 virtual_agents 记录
- `get_virtual_agent(id)` — 单条查询

### server/admin_router.py（修改）

新增端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/virtual-agents` | 列表（api_key 脱敏返回） |
| POST | `/admin/virtual-agents` | 创建（同时创建虚拟用户，同步 pool） |
| PATCH | `/admin/virtual-agents/{id}` | 更新配置（同步 pool） |
| DELETE | `/admin/virtual-agents/{id}` | 删除（从 pool 移除） |

每次写操作后调用 `await _sync_virtual_pool()` 重新加载所有启用的虚拟 Agent 到 pool。

### server/server.py（修改）

lifespan 启动时：
```python
await _sync_virtual_pool()
```

### server/static/admin.html（修改）

新增「虚拟 Agent」标签页：
- 列表表格：名称、BaseURL（截断显示）、风格、模型、状态、操作（编辑/启用/删除）
- 创建/编辑弹窗表单：名称、BaseURL、API Key（编辑时留空不修改）、接口风格单选、模型列表（每行一个）、启用开关
- 保存后显示「已同步至 pool，立即生效」提示

## 路由优先级

`WorkerPool.pick(model)` 逻辑：
1. 从 `_workers`（真实）中筛选支持该 model 的 worker，有则随机选一个返回
2. 若无，从 `_virtual` 中筛选，有则随机选一个返回
3. 两者均无，返回 `None`（dispatch 抛 503）

## 积分流向

- **消费方**：与真实 Worker 完全一致，dispatch 完成后异步扣费
- **贡献方**：settler 周期结算时遍历 `pool.all_workers()`（含虚拟），虚拟 Worker 的 `period_stats` 同样参与结算，积分归属 `user_id`（虚拟账户）

## 不在本次范围内

- 虚拟账户登录或查看个人页（is_virtual 用户无法登录）
- 虚拟 Agent 的请求限流或并发上限
- 多个虚拟 Agent 之间的负载均衡权重配置

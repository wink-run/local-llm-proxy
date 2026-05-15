# Multimodal Image Generation Support — 设计文档

> 状态：**已确认，待实现**
> 日期：2026-05-15

---

## 1. 目标

在现有 text-chat proxy 基础上，以最小侵入方式新增文生图能力，暴露 OpenAI 兼容的
`POST /v1/images/generations` 接口，通过 WebSocket 将请求转发给本地 Worker 上的
图像生成模型（Flux、SD 等）。

---

## 2. 整体方案

**方案 A（选定）**：在现有 `dispatch.py` 旁边新建 `dispatch_image.py`，独立处理图像路由；
`server.py` 新增端点；Worker 注册协议向后兼容扩展；计费复用现有 token 扣费逻辑（虚拟 token）。

---

## 3. Worker 注册协议变更

### 3.1 新格式

`models` 字段升级为对象数组，支持每个模型声明 `type`：

```json
{
  "type": "register",
  "worker_key": "...",
  "name": "worker-A",
  "models": [
    {"name": "gpt-4o",    "type": "chat"},
    {"name": "flux-dev",  "type": "image"},
    "qwen3-32b"
  ]
}
```

- 字符串元素向后兼容，默认 `type = "chat"`
- `type` 枚举：`"chat"` | `"image"`

### 3.2 WorkerConnection 变更（worker_pool.py）

- `models: list[str]` → 保留（仍存模型名列表，用于展示）
- 新增 `model_types: dict[str, str]`（name → type 映射）
- `pool.pick(model, model_type="chat")` 新增 `model_type` 参数过滤

---

## 4. 服务端新端点

### 4.1 路由

```
POST /v1/images/generations   （鉴权：Bearer API Key，同 chat）
```

### 4.2 请求体（OpenAI 规范）

| 字段              | 类型   | 说明                              |
|------------------|--------|----------------------------------|
| `model`          | str    | 图像模型名，如 `flux-dev`          |
| `prompt`         | str    | 文本描述                          |
| `n`              | int    | 生成张数，默认 1                   |
| `size`           | str    | 如 `1024x1024`，透传给 Worker      |
| `response_format`| str    | `"b64_json"` 或 `"url"`，默认 `"b64_json"` |

### 4.3 响应体（OpenAI 规范）

```json
{
  "created": 1716000000,
  "data": [
    {"b64_json": "<base64>", "revised_prompt": "..."}
  ]
}
```

URL 模式时：
```json
{
  "created": 1716000000,
  "data": [
    {"url": "/static/img_cache/<req_id>.png", "revised_prompt": "..."}
  ]
}
```

---

## 5. dispatch_image.py

新文件，处理图像请求的完整生命周期：

1. 检查余额（同 chat，余额 ≤ 0 返回 402）
2. `pool.pick(model, model_type="image")` 选 Worker；无可用 Worker 返回 503
3. 通过 WebSocket 发送：
   ```json
   {"type": "image_request", "req_id": "...", "payload": <原始请求体>}
   ```
4. Worker 回复：
   ```json
   {
     "type": "image_done",
     "req_id": "...",
     "images": [{"b64": "<base64>", "revised_prompt": "..."}]
   }
   ```
5. `response_format == "url"` 时：解码 base64 写入 `static/img_cache/<req_id>.png`，
   返回路径 URL；图片文件 TTL 1 小时，应用启动时清理过期文件
6. 扣费（见第 6 节）

超时复用 `REQUEST_TIMEOUT` 环境变量（默认 120 秒）。
图像生成无流式，只有一次 request/response。

---

## 6. 计费

### 6.1 消费侧

**虚拟 token 映射**：1 张图 = `image_tokens_weight` 个 virtual output_tokens

- `image_tokens_weight` 存入 `system_config` 表，默认 `2000`
- 图像模型的 `model_configs.consume_rate` 默认设为 `1`（每 1K tokens 扣 1 积分）
- 效果：1 张图 × 2000 tokens × 1/1000 = **2 积分**
- 完全复用 `db.consume_credits_for_usage(user_id, model, {"completion_tokens": n * 2000})`

### 6.2 贡献侧

- `model_configs.contribute_rate` 对 image 模型含义变为「每张图贡献多少积分」，默认 `3`
- 结算器（`settler.py`）识别 image 类请求：Worker `done` 消息中用 `image_count` 替代
  `completion_tokens`，结算公式：`image_count × contribute_rate × multiplier`

---

## 7. 数据库变更

### 7.1 model_configs 表

```sql
ALTER TABLE model_configs ADD COLUMN model_type TEXT NOT NULL DEFAULT 'chat';
```

- 通过 `init_db` 中的迁移语句追加（`ADD COLUMN IF NOT EXISTS` 等价写法）
- Worker 自动注册时，根据上报的 `type` 字段写入 `model_type`

### 7.2 system_config 表

新增键值对：

| key                   | 默认值 | 说明                  |
|----------------------|--------|---------------------|
| `image_tokens_weight`| `2000` | 1 张图映射的虚拟 token 数 |

---

## 8. 静态文件缓存目录

- 路径：`server/static/img_cache/`
- 需加入 `.gitignore`
- 应用启动时（`lifespan`）清理超过 1 小时的 `.png` 文件
- `StaticFiles` 已挂载 `/static`，无需额外路由

---

## 9. 管理后台

`admin_router.py` 的「模型配置」CRUD 接口透传 `model_type` 字段，前端展示时可用
标签区分 Chat / Image 模型。无需新增独立管理端点。

---

## 10. 不在本期范围内

- 图像编辑（`/v1/images/edits`）
- 图像变体（`/v1/images/variations`）
- 永久图片存储 / CDN
- 图像模型的质量/风格参数扩展（透传给 Worker 即可，本期不做前端 UI）

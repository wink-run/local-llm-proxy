# Local LLM Proxy

**P2P · OpenAI 兼容 · 出站 WebSocket** —— 把闲置的 Token 额度变成可**跨模型、跨时段**通用的积分。

[English](./README.md)

<!--
 · [源码仓库](https://github.com/wink-run/local-llm-proxy)

```bash
git clone git@github.com:wink-run/local-llm-proxy.git
```
-->

## 是什么、解决什么问题

**Local LLM Proxy** 是一套「云端代理 + 本地 Agent」方案：内网或本机的大模型（Ollama、内网推理网关、你购买的上游 API 路径）通过 **Agent 主动出站连接 VPS**（无需向内网开入站端口），对外提供统一的 **OpenAI 兼容 HTTP API**。外部客户端使用 **Bearer 用户 Key**；Worker 使用用户中心签发的 **Worker Key（`wk-…`，与账户绑定、数据库存储）** 完成注册与鉴权；**上游 LLM 的 API Key 不由代理持久化。** 贡献端自愿提供算力赚取积分，消费端用积分调用 API——**贡献率、消费率、质量系数与结算逻辑**在落地页与管理后台可查。

各台机器运行轻量 `llm-agent`，经 WebSocket 注册到 VPS；VPS 将请求路由到对应 Worker，Worker 转发至本机 LLM 并回传流式结果。

**理念**（与落地页一致）

- **人人为我，我为人人**：闲置算力互助入网，积分跨模型、跨时段通用。
- **中立透明**：打破传统中转站黑箱问题；多方博弈，透明规则，代码开源。
- **低价实惠**：消费者用积分调用 API，同等模型下往往比单独购买上游 Token 更省。

**两大价值**

- **算力错配（跨模型/地域）**：贡献你有的模型额度换积分，消费你没有的模型；节点按延迟、在线时长、成功率计 **质量系数**，高质量贡献积分加成。
- **时间错配（跨时段储值）**：把当前过剩额度转成积分，留到以后用（如夜间关机后继续调用、月底套餐结余转下月）。

**典型场景**

- 内网模型要对公网可用，但不想暴露推理端口；
- 多机多模型汇聚到单一 `/v1` 入口，由 VPS **统一鉴权与路由**；
- **类 P2P 资源池**：自愿上线、贡献换积分、积分消费高级模型。

**积分体系**（摘要；实时汇率见 `/` 与 `/admin/ui`）

- **赚取（每约 5 分钟结算一次）：**  
  `积分 = (output_tokens / 1000) × 模型贡献率 × 质量系数`  
  质量系数 = 0.4×在线因子 + 0.4×延迟因子 + 0.2×稳定性因子，范围 **0.5 ~ 1.5**。
- **消耗（每次 API 调用后）：**  
  `花费 = ((prompt + completion tokens) / 1000) × 模型消费率`  
  设计上 **贡献率 > 消费率**，激励长期在线贡献。

**隐私与控制权**

- **上游 API Key 不上云**：`--llm-token` 仅存本机 `~/.llm-agent/config.json`，仅用于 Agent 直连上游；注册仅上传 **worker_key**、节点名与模型列表，不包含上游密钥。
- **用户调用 VPS 的 API Key** 由管理后台/用户中心签发并存于服务端数据库；**worker_key** 与用户账户绑定，与上游密钥是两回事。
- **随时停止共享**：停止 Agent（`Ctrl+C`）或断网即退出资源池，无需服务端「解绑」。

更完整的协议与架构说明见 [DESIGN.md](./DESIGN.md)。

---

## 部署

### 1 · VPS — Docker Compose

```bash
cp .env.example .env
# 编辑 .env，设置 ADMIN_KEY 等
docker compose up -d --build
```

默认对外端口 **8000**，数据库 SQLite 落在 Docker volume `db_data`。

| 变量 | 说明 |
|---|---|
| `ADMIN_KEY` | 管理后台与 Admin API 使用的密钥 |
| `REQUEST_TIMEOUT` | 单次转发请求等待超时（秒），默认 `120` |

生产环境建议在 Nginx 上配置 HTTPS，并把 Agent 的 WebSocket 地址改为 `wss://你的域名/ws/worker`。

### 2 · 本地 Agent（内网机器）

**方式 A：Python 源码运行**

```bash
cd agent
pip install -r requirements.txt

python agent.py register \
  --server "ws://你的VPS:8000/ws/worker" \
  --worker-key "在用户中心复制的 wk-..." \
  --models "模型A,模型B" \
  --llm-url "http://localhost:11434" \
  --name   "我的主机"

python agent.py start
```

**`--worker-key`** 在用户中心（`/app`）复制，为 Worker 接入的唯一凭据。  
内网 LLM 需要 Token 时加 `--llm-token`。配置写入 `~/.llm-agent/config.json`，后续只需 `python agent.py start`。

**方式 B：打包成单文件二进制**（在目标操作系统上执行）：

```bash
cd agent
chmod +x build.sh && ./build.sh
# 使用 ./dist/llm-agent 代替 python agent.py
```

运行中实例的落地页「下载 llm-agent」区块可下载预编译文件（来源 `server/static/downloads/`；仓库内执行 `agent/build.sh` 生成）。

Agent 对接本地 LLM 的 **`POST /v1/chat/completions`** 接口（OpenAI 兼容）。

---

## 使用方式

部署后浏览器访问 `http://VPS:8000` 打开落地页（含模型汇率、积分举例与 Agent 下载）。

### 运营大屏

访问 `http://VPS:8000/wall` 打开**运营大屏**（聚合运行态视图）。

### 管理后台

1. 打开 `http://VPS:8000/admin/ui`
2. 使用 `ADMIN_KEY` 登录
3. 创建用户 API Key，配置模型及积分汇率

### 用户门户

访问 `http://VPS:8000/app` — 注册账号、查看余额、管理 API Key、申请充值。

### OpenAI 兼容接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/v1/models` | GET | 列出在线模型 |
| `/v1/chat/completions` | POST | 对话补全（支持流式） |

所有接口需 `Authorization: Bearer <用户API Key>`。

**示例**

```bash
curl -sS "http://VPS:8000/v1/chat/completions" \
  -H "Authorization: Bearer USER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"你的模型名","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

任意支持自定义 `base_url` 的 OpenAI 兼容客户端，把 base URL 设为 `http://VPS:8000/v1` 即可。

---

## 本地开发（不使用 Docker）

```bash
cd server
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

---

## 许可证

本项目采用 **Apache License 2.0**，全文见仓库根目录 [`LICENSE`](./LICENSE)。  
引用、再分发或基于本仓库制作衍生作品时，须遵守 [`NOTICE`](./NOTICE) 中的说明：**保留 NOTICE 与 LICENSE**，并**显著标注来源**——注明 **Local LLM Proxy** 项目名称及官方源码地址：

https://github.com/wink-run/local-llm-proxy

---

## 免责声明

本项目仅供**学习与研究**使用。使用者须自行遵守所在地法律法规及上游服务条款；因部署、自愿共享 token、转发请求等行为所产生的任何后果，均由使用者**自行承担**，作者与贡献者不承担任何责任。

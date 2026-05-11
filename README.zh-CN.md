# Local LLM Proxy

[English](./README.md) · [源码仓库](https://github.com/wink-run/local-llm-proxy)

```bash
git clone git@github.com:wink-run/local-llm-proxy.git
```

## 是什么、解决什么问题

**Local LLM Proxy** 是一套「云端代理 + 本地 Agent」方案：原本只能在内网访问的大模型（如 Ollama、自建推理网关、或仅内网可达的上游 API），通过**本地 PC 主动连接 VPS**（穿透 NAT，无需把内网端口开到公网），对外提供 **OpenAI 兼容的 HTTP API**。

**核心价值**：把各台运行 Agent 的机器上自愿接入共享的 API token 及调用路径，以及仅内网可达的上游地址、本机部署模型一并汇聚到 VPS 统一入口，让外网像调用一家「OpenAI 兼容服务」一样使用——形成一种**贡献端 ↔ 消费端**、多节点接入的**类 P2P 资源池**。

典型场景：

- 模型跑在内网，外网不可直连，又不想把推理端口暴露在公网；
- 多台机器、多种模型 / 多条上游密钥，希望由 VPS **统一鉴权与路由**；
- 希望调用路径接近 **P2P 协作**——各节点自愿上线、贡献算力换取积分、消费积分调用高级模型。

**隐私与控制权**

- **上游 API Key 不上云**：`--llm-token` 只保存在本机 `~/.llm-agent/config.json`，仅用于 Agent 直连上游；注册到代理时不会上传或持久化。
- **随时停止共享**：停止 Agent（`Ctrl+C`）即退出资源池，无需额外「解绑」步骤。

更完整的协议与架构说明见 [DESIGN.md](./DESIGN.md)。

---

## 部署

### 1 · VPS — Docker Compose

```bash
cp .env.example .env
# 编辑 .env，修改 WORKER_TOKEN、ADMIN_KEY 等
docker compose up -d --build
```

默认对外端口 **8000**，数据库 SQLite 落在 Docker volume `db_data`。

| 变量 | 说明 |
|---|---|
| `WORKER_TOKEN` | 本地 Agent 注册时使用的密钥，须与 Agent 配置一致 |
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
  --token  "与服务端 WORKER_TOKEN 相同" \
  --models "模型A,模型B" \
  --llm-url "http://localhost:11434" \
  --name   "我的主机"

python agent.py start
```

内网 LLM 需要 Token 时加 `--llm-token`。配置写入 `~/.llm-agent/config.json`，后续只需 `python agent.py start`。

**方式 B：打包成单文件二进制**（在目标操作系统上执行）：

```bash
cd agent
chmod +x build.sh && ./build.sh
# 使用 ./dist/llm-agent 代替 python agent.py
```

运行中的实例落地页（`/`）可直接下载已构建的二进制文件。

Agent 对接本地 LLM 的 **`POST /v1/chat/completions`** 接口（OpenAI 兼容）。

---

## 使用方式

部署后浏览器访问 `http://VPS:8000` 打开落地页。

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

## 免责声明

本项目仅供**学习与研究**使用。使用者须自行遵守所在地法律法规及上游服务条款；因部署、自愿共享 token、转发请求等行为所产生的任何后果，均由使用者**自行承担**，作者与贡献者不承担任何责任。

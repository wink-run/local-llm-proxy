# Local LLM Proxy

**源码仓库**：[github.com/wink-run/local-llm-proxy](https://github.com/wink-run/local-llm-proxy)

```bash
git clone git@github.com:wink-run/local-llm-proxy.git
```

## 是什么、解决什么问题

**核心价值**：把各台运行 Agent 的机器上**由你自行配置、自愿接入共享的 API token 及其调用路径**，以及仅内网可达的上游地址、本机部署模型一并接入，通过 Agent **主动连出公网**，汇聚到一台 VPS 上的统一入口，让外网像调用一家「OpenAI 兼容服务」一样使用——形成一种 **贡献端 ↔ 消费端**、多节点接入的 **类 P2P 资源池**，减少对单一供应商商用入口路径的依赖，更接近 **「token 自由」**：路由与用量在你控制的 Worker 与密钥之上，而不是绑死在某一家的公开 Endpoint。

**Local LLM Proxy** 是一套「云端代理 + 本地 Agent」方案：原本只能在内网访问的大模型（如 Ollama、自建推理网关、或仅内网可达的上游 API），通过 **本地 PC 主动连接 VPS**（穿透 NAT，无需把内网端口开到公网），对外提供 **OpenAI 兼容的 HTTP API**。

典型场景：

- 自愿将**本人配置的 API token** 所指向的上游调用路径「挂」到统一入口，供团队或可信用户使用（是否共享、共享范围由你决定）；
- 模型跑在内网，外网不可直连，又不想把推理端口暴露在公网；
- 多台机器、多种模型 / 多条上游密钥，希望由 VPS **统一鉴权与路由**，按需挑选 Worker；
- 希望调用路径接近 **P2P 协作**（各节点自愿上线、自带模型与上游配置），而不是所有流量永远绕一个大厂固定域名。

**工作方式概要**：VPS 上运行 FastAPI；各内网机器运行 `llm-agent`，用 WebSocket 注册本机支持的模型；客户端访问 VPS 的 `/v1/*`，服务端把请求转发到对应 Worker，由本地转发到你配置的 LLM 地址（含可选的上游 `Bearer`），结果实时回传（含流式）。

**隐私与控制权**

- **上游 API Key 不上云**：你在 Agent 里为本地/上游 LLM 配置的密钥（如 `--llm-token`）只保存在本机配置文件，用于 Agent 直连上游；注册到代理服务端时 **不会上传、收集或持久化** 这类密钥（协议里仅包含 Worker 鉴权、节点名与模型列表）。
- **随时停止共享**：停止运行 Agent（例如 `Ctrl+C`）或关机/断网即不再对外承接请求，无需额外「解绑」步骤；需要时再执行 `start` 即可恢复。

（调用 VPS 开放接口所需的 **用户 API Key** 由管理后台在服务端生成并存入数据库，这是代理鉴权所需，与上述上游密钥是两回事。）

更完整的协议与架构说明见 [DESIGN.md](./DESIGN.md)。

---

## 安装与部署

### 1. 在 VPS 上部署服务端（Docker Compose）

项目根目录需有 `.env`（可复制 `.env.example` 后修改）：

| 变量 | 说明 |
|------|------|
| `WORKER_TOKEN` | 本地 Agent 注册时使用的密钥，须与 Agent 配置一致 |
| `ADMIN_KEY` | 管理后台与 Admin API 使用的密钥 |
| `REQUEST_TIMEOUT` | 单次转发请求等待超时（秒），默认 `120` |

启动：

```bash
cp .env.example .env
# 编辑 .env，修改 WORKER_TOKEN、ADMIN_KEY 等

docker compose up -d --build
```

默认对外端口为 **8000**（`docker-compose.yml` 中映射）。数据库 SQLite 落在 Docker volume `db_data` 中（容器内路径见 `DB_PATH`）。

生产环境建议在反向代理（如 Nginx）上配置 **HTTPS**，并把 Agent 的 WebSocket 地址改为 `wss://你的域名/ws/worker`（需代理正确转发 WebSocket）。

### 2. 本地 Agent（内网机器）

**方式 A：直接用 Python 运行**

```bash
cd agent
pip install -r requirements.txt

python agent.py register \
  --server "ws://你的VPS:8000/ws/worker" \
  --token "与服务端 WORKER_TOKEN 相同" \
  --models "模型A,模型B" \
  --llm-url "http://localhost:11434" \
  --name "我的主机"

python agent.py start
```

配置默认写入 `~/.llm-agent/config.json`。内网 LLM 若需 Token，可加 `--llm-token`。

**方式 B：打包成单文件二进制**（在目标操作系统上执行）：

```bash
cd agent
chmod +x build.sh
./build.sh
# 使用 ./dist/llm-agent 代替 python agent.py
```

Agent 会把上游请求转发到本地 LLM 的 **`POST /v1/chat/completions`**（OpenAI 兼容接口）。

---

## 使用方式

部署并启动服务后，浏览器访问 **`/`**（根路径）可打开项目介绍落地页（静态页位于 `server/static/landing.html`）。

### 管理后台与用户 API Key

1. 浏览器打开：`http://VPS地址:8000/admin/ui`
2. 使用环境变量中的 **`ADMIN_KEY`** 登录
3. 在界面中创建 API Key；调用用户接口时使用 **`Authorization: Bearer <用户API Key>`**

### OpenAI 兼容接口

- **列出模型**：`GET /v1/models`
- **对话**：`POST /v1/chat/completions`  
  请求体与 OpenAI Chat Completions 一致（需指定 `model` 为某台在线 Agent 已注册的模型名）。

示例（将 `USER_KEY` 替换为后台生成的 Key）：

```bash
curl -sS "http://VPS地址:8000/v1/chat/completions" \
  -H "Authorization: Bearer USER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"你的模型名","messages":[{"role":"user","content":"你好"}]}'
```

任意支持自定义 `base_url` 与 API Key 的 OpenAI 兼容客户端，只要把 base URL 设为 `http://VPS地址:8000/v1`（或 HTTPS 等价地址），并填入上述用户 Key 即可。

---

## 本地开发（可选）

在不使用 Docker 时，可在 `server` 目录安装依赖并启动（需自行提供 `.env` 或导出同名环境变量）：

```bash
cd server
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

---

## 免责声明

本项目仅供 **学习与研究** 使用。使用者须自行遵守所在地法律法规及上游服务条款；因部署、自愿共享 token、转发请求等行为所产生的任何后果（包括但不限于数据安全、费用、合规与纠纷），均由使用者 **自行承担**，作者与贡献者不承担任何责任。

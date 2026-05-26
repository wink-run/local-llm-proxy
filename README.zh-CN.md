# Token Bank — 本地 LLM 网关

**P2P 积分网络 · OpenAI 兼容 · 三端部署** — 把本地大模型和闲置 API 额度变成可跨模型、跨时段通用的积分。

[English](./README.md) · [架构文档](./DESIGN.md) · [下载最新版](https://github.com/wink-run/local-llm-proxy/releases/latest)

---

## 是什么

**Token Bank** 在你的本机（或服务器）运行一个轻量 HTTP 网关，对外暴露 **OpenAI 兼容的 `/v1` 接口**，对内智能路由到：

| 来源 | 说明 |
|---|---|
| **本地模型** | Ollama、LM Studio 等本机推理服务 |
| **免费层** | Groq、GitHub Models 等有限免费 API |
| **P2P 网络** | 其他用户贡献的算力，用积分消费 |
| **付费 API** | OpenAI、Anthropic 等，积分用完的兜底 |

网关自动按优先级和积分余量切换供给来源，调用方只需一个本地端点，无需关心背后用了哪条链路。

---

## 三种部署方式

### 🖥 桌面版（推荐）

从 [Releases](https://github.com/wink-run/local-llm-proxy/releases/latest) 下载对应平台安装包：

- **macOS** — `.dmg`，双击安装，系统托盘常驻，支持自动更新
- **Windows** — `.exe`，NSIS 安装包，支持自动更新

安装后打开应用，完成账号配置即可使用。

---

### 💻 命令行版（Linux / 服务器）

```bash
# 克隆仓库
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy/client

# 安装依赖（仅首次）
npm install

# 启动网关
node cli/gateway.js start
```

启动后：
- **网关** `:11430` — 接收 LLM 请求（`OPENAI_BASE_URL=http://localhost:11430/v1`）
- **Web UI** `:11431` — 浏览器打开 `http://localhost:11431` 进行配置和查看统计

常用命令：

```bash
node cli/gateway.js status    # 查看运行状态
node cli/gateway.js restart   # 热重启
node cli/gateway.js keys      # 查看本地 API Key
```

---

### 🐳 Docker 版（容器化部署）

```bash
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy

# 准备配置
mkdir -p gateway-data
cat > gateway-data/local-config.json << 'EOF'
{
  "cloud_config": {
    "url": "http://YOUR_BACKEND:8000",
    "token": "YOUR_P2P_KEY"
  },
  "scene_routes": [],
  "local_keys": []
}
EOF

# 启动（仅网关）
docker compose up gateway -d

# 或同时启动后端服务
docker compose up -d
```

| 端口 | 用途 |
|---|---|
| `11430` | OpenAI 兼容网关（`OPENAI_BASE_URL`） |
| `11431` | Web UI 与管理 API |

配置文件持久化在 `./gateway-data/`，重启不丢数据。

---

## 接入任意 OpenAI 客户端

```bash
# 环境变量
export OPENAI_BASE_URL=http://localhost:11430/v1
export OPENAI_API_KEY=your-local-key   # 在 Web UI 里创建

# curl 测试
curl http://localhost:11430/v1/chat/completions \
  -H "Authorization: Bearer your-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

支持所有兼容 OpenAI SDK 的客户端：Claude Code、Continue、Cursor、Open WebUI、LangChain……

---

## 主要功能

### 智能路由
- 按供给来源优先级自动切换（本地 → 免费层 → P2P → 付费）
- 场景路由：为不同 model key 绑定不同的供给策略
- 网关日志：记录每次调用的路由结果、延迟和状态

### P2P 积分网络
- 贡献本地算力赚取积分，积分用于消费其他模型
- 每日签到、转盘等额外积分来源
- 积分流水可查，余额实时展示

### 多设备管理
- 账号下所有设备（桌面版 + 命令行版）统一视图
- 每台设备独立展示今日调用数、错误率、活跃供应商数
- 设备在线状态实时心跳，断连自动重连

### 本地密钥管理
- 本地 API Key 存储在本机，不上传云端
- 支持将 Key 绑定到指定场景路由
- 一键扫描环境变量中已有的 LLM 配置并导入

---

## 架构概览

```
调用方 (Claude Code / Cursor / ...)
        │
        ▼ OpenAI API  :11430
┌─────────────────────────────┐
│      本地网关 (Gateway)      │
│  场景路由  ·  负载均衡        │
│  日志记录  ·  统计            │
└────────┬──────────┬──────────┘
         │          │
    本地模型      云端后端 :8000
  (Ollama 等)   ┌──────────────┐
                │  Token Bank  │
                │  积分 · 路由  │
                │  P2P 调度    │
                └──────────────┘
                    │
               P2P Worker 网络
          (其他用户贡献的算力节点)
```

---

## 服务端部署（可选）

如果你想搭建自己的私有 P2P 网络：

```bash
cp .env.example .env
# 设置 ADMIN_KEY 等变量
docker compose up proxy -d
```

| 变量 | 说明 |
|---|---|
| `ADMIN_KEY` | 管理后台密钥 |
| `REQUEST_TIMEOUT` | 单次转发超时（秒），默认 `120` |

管理后台：`http://YOUR_VPS:8000/admin/ui`  
用户门户：`http://YOUR_VPS:8000/app`  
OpenAI API：`http://YOUR_VPS:8000/v1`

---

## 贡献本地算力（Worker）

```bash
cd agent
pip install -r requirements.txt

python agent.py register \
  --server "ws://YOUR_VPS:8000/ws/worker" \
  --worker-key "在用户中心复制的 wk-..." \
  --models "llama3,qwen2" \
  --llm-url "http://localhost:11434" \
  --name "我的主机"

python agent.py start
```

**上游 API Key 不上云**：`--llm-token` 仅存本机 `~/.llm-agent/config.json`，注册时只发送 worker_key 和模型列表。

---

## 许可证

Apache License 2.0 — 详见 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)。  
再分发或制作衍生作品须保留 NOTICE，并注明项目来源：  
**Token Bank · https://github.com/wink-run/local-llm-proxy**

---

## 免责声明

本项目仅供学习与研究使用。使用者须自行遵守所在地法律法规及上游服务条款，因部署、共享算力或转发请求所产生的任何后果均由使用者自行承担。

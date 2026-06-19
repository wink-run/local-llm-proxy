# Token Bank

> **本地 LLM 网关 · Token 管家**
>
> 用的明白 · 用的节省 · 闲置的还可以赚钱

[English](./README.md) · [下载最新版](https://github.com/wink-run/local-llm-proxy/releases/latest) · [架构文档](./DESIGN.md)

---

## 为什么需要 Token Bank

你可能遇到过这些问题：

- 同时订阅了好几家 LLM，不知道每天到底用了多少、用在哪了
- Groq 免费额度、GitHub Models 每月都没用完，但 OpenAI 账单还是跑高了
- 本地跑着 Ollama，AI 工具却还在傻傻地调付费 API
- 月底 API 套餐剩余额度清零，白白浪费

**Token Bank 是一个运行在你本地的 LLM 网关，** 统一接管所有 AI 工具的请求，帮你把 Token 用得明白、用得节省——多出来的闲置额度，还能贡献给 P2P 网络赚取积分。

**v0.4 三大能力：**

| 能力 | 说明 |
|---|---|
| **常见 Agent 纳管与 Trace** | 在网关页登记 Cursor、Claude Code、Codex CLI、Cherry Studio 等应用；走网关实时代理，或会话补录，统一追溯每次调用 |
| **个人订阅管理** | APP 订阅 / API 订阅 / 按量付费分栏管理；订阅可仅统计或转 API 供给；按量配置模型与刊例价，供给源页从个人页选取可用模型 |
| **多维度统计分析** | 盘点页按 **应用 · 供给源 · 模型 · 路由层 · 费用 · 设备 · 时间范围** 切片，订阅折算与按量估算同屏展示 |

---

## 三件事

### 一、用的明白

Token Bank 记录每一次调用：走了哪条路由、用了哪个模型、花了多少 Token、延迟多少毫秒。

- **Agent 纳管盘点**：网关登记常见 Agent，按应用汇总请求、Token、费用，区分网关实时与会话补录
- **今日看板**：总调用次数、免费命中率、供给来源分布、模型排行（次数 / Token / 费用）
- **调用日志**：每条请求的路由结果、状态、耗时一目了然
- **多设备视图**：名下所有设备（桌面 + 命令行 + 服务器）各自的今日用量，登录后可云端聚合
- **费用叠加**：订阅套餐按日折算 + 按量刊例价估算，与原始 Token 统计同屏对照
- **积分流水**：每笔贡献和消费都有记录，余额实时可查

---

### 个人订阅与按量（个人页）

订阅与按量账户集中在个人页管理，与供给源页的 Key / 路由配置分工明确：

| 类型 | 用途 |
|---|---|
| **APP 订阅** | ChatGPT、Claude、Gemini 等 — 可仅用量统计，或通过 OAuth 转为 API 供给 |
| **API 订阅** | 厂商 API 套餐（如火山引擎 Coding Plan）— 独立目录，走 API Key 网关 |
| **按量付费** | OpenAI、Anthropic、自定义供给源 — 登记模型与 USD/百万 Token 刊例价；供给源页仅可选用此处已配置的模型 |

**供给源页**负责接入 Key 与路由；**个人页 → 订阅 / 按量付费**决定计费统计口径与各按量源的可用模型列表。

---

### 二、用的节省

Token Bank 在本机运行一个 **智能路由链**，请求按优先级依次尝试：

```
本地模型 (Ollama)
    ↓ 没有合适模型
免费层 (Groq / GitHub Models / ...)
    ↓ 超限或不可用
P2P 网络 (用积分消费)
    ↓ 积分不足
付费 API (OpenAI / Anthropic / ...)
```

**你的 AI 工具只需要对着一个本地地址发请求，** 路由对它们完全透明。

#### 场景路由

不同的使用场景可以绑定不同的供给链。比如：

| 场景 | 路由策略 |
|---|---|
| 日常对话 | 先走 Groq 免费层，不够再走 P2P |
| 代码补全 | 直接走本地 Ollama，零延迟零成本 |
| 长文档分析 | 走付费 API，保证质量 |

#### 免费层自动接入

一键扫描你的环境变量和工具配置，把已有的 LLM Key（Groq、GitHub Models、Anthropic 等）自动导入。多个 Key 自动轮询，充分利用每家的免费额度。

---

### 三、闲置的还可以赚钱

把你用不完的算力或 API 额度贡献给 P2P 网络，赚取积分，再去消费你没有的模型。

**可以贡献什么：**

- 本地 Ollama / 推理服务（贡献算力）
- 用不完的上游 API 路径（贡献额度）
- 内网才能访问的私有模型（通过 Agent 出站 WebSocket 接入，无需开放端口）

**赚取规则（每 5 分钟结算）：**

```
积分 = (输出 Token 数 / 1000) × 模型贡献率 × 质量系数
```

质量系数由在线时长、响应延迟、成功率决定，范围 0.5 ~ 1.5。稳定在线、响应快的节点赚得更多。

**其他积分来源：**
- 每日签到
- 每日转盘
- 邀请好友

**消费规则：**

```
花费 = (输入 + 输出 Token 数 / 1000) × 模型消费率
```

设计上贡献率 > 消费率，长期贡献者收益为正。

---

## 快速开始

### 桌面版（Mac / Windows，推荐）

从 [Releases](https://github.com/wink-run/local-llm-proxy/releases/latest) 下载安装包：

- **macOS** `.dmg` — 双击安装，托盘常驻，支持后台自动更新

  若提示 **「已损坏，无法打开」**（Gatekeeper 拦截，非文件损坏），安装后在终端执行：

  ```bash
  xattr -cr "/Applications/Token Bank.app"
  ```

  然后重新打开。或在「系统设置 → 隐私与安全性」中选择「仍要打开」。
- **Windows** `.exe` — NSIS 安装包，支持后台自动更新

安装后打开 → 进入「配置」页 → 填写账号服务地址和 P2P Key → 完成。

**接入 AI 工具：**

在 Claude Code、Cursor、Open WebUI 等工具中，把 API Base URL 改为：

```
http://localhost:11430/v1
```

API Key 在「网关」页创建本地 Key，或使用你已有的上游 Key。

---

### 命令行版（Linux / 服务器）

```bash
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy/client
npm install
node cli/gateway.js start
```

浏览器打开 `http://localhost:11431` 进行配置，使用方式与桌面版完全一致。

```bash
# 后台运行
nohup node cli/gateway.js start > gateway.log 2>&1 &

# 或用 pm2
pm2 start cli/gateway.js -- start
```

---

### Docker 版（容器化）

```bash
git clone https://github.com/wink-run/local-llm-proxy.git
cd local-llm-proxy

docker compose up gateway -d
```

配置目录 `gateway-data/` 由 Compose 自动挂载；**`local-config.json` 在首次启动时由程序创建**，路由与应用在 `:11431` Web UI 中配置。说明见 [`gateway-data/README.md`](./gateway-data/README.md)。

| 端口 | 用途 |
|---|---|
| `11430` | LLM 请求入口（`OPENAI_BASE_URL=http://host:11430/v1`） |
| `11431` | Web 管理界面 |

---

## 界面预览

| 页面 | 功能 |
|---|---|
| **盘点** | 多维统计：应用占比、供给层分布、模型排行（次数 · Token · 费用）、小时趋势、按量 + 订阅估算费用 |
| **网关** | Agent 纳管（Cursor、Claude Code、Codex…）、供给链、场景路由、状态与日志 |
| **供给源** | 免费 / P2P / 付费层；APP 订阅 OAuth、API 订阅 Key、按量 Key；模型列表与个人页按量配置联动 |
| **个人** | P2P 积分 · **订阅账户**（APP + API）· **按量付费**（供给源、模型、刊例价）· 多设备盘点 |
| **P2P 网络** | 查看全球节点分布、在线贡献者、模型供给情况 |
| **贡献** | 查看贡献节点状态、历史结算记录、质量系数趋势 |

---

## 接入任意 OpenAI 兼容客户端

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://localhost:11430

# Cursor / Copilot 等
OPENAI_BASE_URL=http://localhost:11430/v1
OPENAI_API_KEY=your-local-key

# curl 测试
curl http://localhost:11430/v1/chat/completions \
  -H "Authorization: Bearer your-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

---

## 搭建私有 P2P 后端（可选）

如果你想自建服务节点而不是使用公共网络：

```bash
cp .env.example .env
# 编辑 .env，设置 ADMIN_KEY
docker compose up proxy -d
```

| 变量 | 说明 |
|---|---|
| `ADMIN_KEY` | 管理后台密钥 |
| `REQUEST_TIMEOUT` | 单次转发超时秒数（默认 120） |

- 管理后台：`http://YOUR_VPS:8000/admin/ui`
- 用户门户：`http://YOUR_VPS:8000/app`
- Worker 接入：`ws://YOUR_VPS:8000/ws/worker`

### 贡献 Worker 节点

```bash
cd agent && pip install -r requirements.txt

python agent.py register \
  --server   "ws://YOUR_VPS:8000/ws/worker" \
  --worker-key "wk-... 在用户中心复制" \
  --models   "llama3,qwen2" \
  --llm-url  "http://localhost:11434" \
  --name     "我的主机"

python agent.py start
```

**上游 API Key 不上云**：仅存本机 `~/.llm-agent/config.json`，注册时只传 worker_key 和模型名。

---

## 许可证

Apache License 2.0 — 详见 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)。  
再分发或衍生作品须保留 NOTICE，并注明来源：  
**Token Bank · https://github.com/wink-run/local-llm-proxy**

---

## 免责声明

本项目仅供学习与研究使用。使用者须自行遵守所在地法律法规及上游服务条款。因部署、共享算力或转发请求产生的任何后果，均由使用者自行承担。

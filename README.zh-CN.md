# Token Bank

> **个人AI中枢 · Token 管家**
>
> 用的明白 · 用的节省 · 闲置的还可以赚钱
>
> 一键纳管 Claude Code / Codex 等主流 Agent · 无损换模 · 全链路 Trace · 智能路由 · 网关压缩 · 多设备聚合 · 本地源 / 社区 P2P

[English](./README.md) · [下载最新版](https://github.com/wink-run/local-llm-proxy/releases/latest) · [架构文档](./DESIGN.md)

---

## 为什么需要 Token Bank

你可能遇到过这些问题：

- 同时订阅了好几家 LLM，不知道每天到底用了多少、用在哪了
- Groq 免费额度、GitHub Models 每月都没用完，但 OpenAI 账单还是跑高了
- 本地跑着 Ollama，AI 工具却还在傻傻地调付费 API
- 月底 API 套餐剩余额度清零，白白浪费

**Token Bank 是你的个人AI中枢，** 统一接管所有 AI 工具的请求，帮你把 Token 用得明白、用得节省——多出来的闲置额度，还能贡献给社区 P2P 网络赚取积分。

**v0.4 三大能力：**

| 能力 | 说明 |
|---|---|
| **常见 Agent 纳管与 Trace** | 在网关页登记 Cursor、Claude Code、Codex CLI、Cherry Studio 等应用；走网关实时代理，或会话补录，统一追溯每次调用 |
| **个人订阅管理** | APP 订阅 / API 订阅 / 按量付费分栏管理；跨设备云端同步；订阅可仅统计或转 API 供给 |
| **多维度统计分析** | 盘点页按 **应用 · 供给源 · 模型 · 供给类型（本地源 / 社区 P2P）· 费用 · 设备 · 时间范围** 切片；多设备用量云端聚合 |
| **动态供给下发** | 登录后自动同步工具清单、场景路由与社区 P2P 在线模型；本地源目录由服务端维护并下发 |

---

## 核心能力：一键纳管 · 无损换模 · 全链路 Trace

Token Bank 不只是转发 API——它把 **Claude Code、Codex、Gemini CLI、Cursor、Copilot** 等主流 Agent 统一纳入本地网关，在**不改动 Agent 本身**的前提下，实现用量追溯、模型切换与智能路由。

### 一键纳管应用

打开 **网关** 页，已安装的工具会自动出现在列表中（也可手动添加桌面包）：

| 应用 | 接入方式 |
|---|---|
| Claude Code / Codex CLI / Gemini CLI / OpenCode 等 | CLI 透明托管：自动注入 `BASE_URL` 环境变量，无需改命令 |
| Claude Desktop / Codex Desktop / OpenClaw | 配置文件写入：一键 patch 指向本地网关 |
| Cursor 等 OpenAI 兼容客户端 | 手动改 `OPENAI_BASE_URL`，或在网关创建专用 Key |

**纳管流程：**

1. 点击 **纳管** → 开始统计该应用的 Token 用量（即使仍直连官方订阅）
2. 在路由下拉框选择 **模型或场景路由** → 自动改写配置，流量走本地网关
3. 点击 **还原** → 恢复官方配置，停止纳管统计

三种状态清晰分离：**仅统计**（官方订阅 + 会话补录）、**走网关**（路由绑定 + 实时代理）、**还原**（恢复原始配置）。

### 主流 Agent 无损切换第三方模型

Agent 继续使用原生模型名（如 `claude-sonnet-4-6`、`gpt-5`），**客户端无需任何改动**：

```
Claude Code 请求 claude-sonnet-4-6
        ↓  网关 keyScene 透明改写
实际路由 → Groq llama-3.3-70b / 本地 Ollama / DeepSeek / …
        ↓  协议适配层
Anthropic Messages ↔ OpenAI Chat ↔ Codex Responses
```

- **模型名不变**：Claude 客户端校验通过，UI 显示不变
- **协议自动转换**：Anthropic `/v1/messages`、OpenAI `/v1/chat/completions`、Codex `/v1/responses` 各自适配
- **按应用独立绑定**：Claude Code 走免费 Groq，Codex 走本地 Ollama，互不影响
- **随时切回官方**：路由选「直连官方」即还原配置，零残留

### 会话 Trace（网关实时 + 会话补录）

无论 Agent 是否走网关，用量都能被完整追溯：

| 模式 | 说明 |
|---|---|
| **网关实时代理** | 请求经 `localhost:11430` 转发，记录路由链、真实模型、Token、延迟、费用 |
| **会话补录** | 纳管但未走网关时，扫描本地会话日志（`~/.claude`、`~/.codex` 等）补录用量 |
| **自动去重** | 同一次调用若既走网关又落进会话文件，只记一次 |

Trace 数据在 **盘点** 页按 **应用 · 供给源 · 模型 · 供给类型 · 设备 · 时间** 多维切片，调用日志可查看每条请求的路由结果与耗时。

### 智能路由

供给源分为 **本地源** 与 **社区 P2P 源** 两大类，每个应用可独立绑定路由，全局供给链作为兜底：

```
按应用绑定（keyScene / 场景路由）
    ↓ 未绑定或 llm-router-* 模型
智能供给链
    本地源：Ollama → 免费 API (Groq / GitHub Models) → 订阅 / 按量 API
    ↓ 本地源不可用或需扩展算力
    社区 P2P 源（消耗积分，调用社区共享算力）
    ↓ 策略组调度
fallback · round-robin · weighted · latency · direct
```

| 供给类型 | 包含 | 说明 |
|---|---|---|
| **本地源** | Ollama、免费 API、APP/API 订阅、按量付费 | 本机网关直连转发，Key 不上云 |
| **社区 P2P 源** | 社区共享算力网络 | 消耗积分调用远程节点，模型列表动态下发 |

- **场景路由**：日常对话、代码补全、长文档分析绑定不同供给链
- **策略组**：按任务特征（工具调用、上下文长度等）动态选择 provider 顺序
- **故障转移**：本地源不可用时自动尝试社区 P2P，对 Agent 完全透明

### 网关无损压缩

转发前可选开启 **无损 JSON 压缩**，减少发给上游的输入 Token，**不改变模型看到的语义**：

- 压缩消息中 pretty-print 的 JSON（工具返回、嵌入数据等），去掉多余空白
- 非 JSON 内容原样保留，不影响回答质量
- 在 **配置** 页开启，或通过环境变量 `TOKENBANK_COMPRESS=1`
- **盘点** 页展示压缩次数、节省 Token 数与压缩比；多设备登录后云端汇总各端压缩效果

### 多设备用量聚合

桌面版、CLI 版、服务器网关各自注册为独立设备，登录账号后 **用量自动上报并云端合并**：

| 能力 | 说明 |
|---|---|
| **设备注册** | 每台机器自动分配 device_id，60s 心跳保持在线状态 |
| **盘点快照** | 按 1 / 7 / 30 天上报调用、Token、费用、本地源 / 社区 P2P 分布、Top 模型与应用 |
| **云端合并** | **个人** 页与 **盘点** 页展示各设备占比、在线状态、独立明细与汇总视图 |
| **跨端一致** | 订阅账户、按量配置、工具清单登录后同步，换设备无需重复配置 |

### 个人订阅统一管理

**个人** 页集中管理所有计费账户，与 **供给源** 页的 Key / 路由分工明确：

| 类型 | 管理方式 | 典型场景 |
|---|---|---|
| **APP 订阅** | 登记 ChatGPT / Claude / Gemini / Cursor 等套餐与月费 | 仅统计官方订阅用量，或通过 OAuth 转为 API 供给 |
| **API 订阅** | 独立目录管理厂商 API 套餐（如火山引擎 Coding Plan） | 走 API Key 网关，与 APP 订阅分开核算 |
| **按量付费** | 登记供给源、模型列表与 USD/百万 Token 刊例价 | 供给源页仅可选用此处已配置的模型；费用估算以此为准 |

- **跨设备同步**：登录后订阅与按量配置云端下发，Mac / Windows / Linux 保持一致
- **计费叠加**：订阅按日折算 + 按量刊例价估算，与原始 Token 统计同屏对照
- **供给联动**：个人页定义「用什么、花多少钱」，供给源页定义「怎么接入、怎么路由」

### 动态供给源下发

本地源目录与工具清单无需手动维护版本——**登录即同步，在线即更新**：

```
服务端维护
    ├── 本地源目录（Ollama / Groq / GitHub Models / SiliconFlow …）
    ├── 工具清单 config.apps（Agent 纳管规则、协议适配）
    └── 场景路由 config.scenes（预设路由链）
         ↓  登录 / 启动时自动拉取
本地网关
    ├── 合并写入 ~/.tokenbank/tokenbank.yaml
    ├── 社区 P2P 在线模型定时刷新（/v1/models → 路由候选）
    └── 一键扫描环境变量，导入已有免费 Key 并轮询
```

- **本地源目录下发**：Groq、Cerebras、GitHub Models、NVIDIA NIM 等预置在供给源页「本地源」，管理员可通过 YAML 热更新
- **社区 P2P 动态模型**：在线贡献者的模型列表实时拉取，无需本地手动添加
- **环境变量扫描**：一键导入本机已有的 Groq / GitHub Models / Anthropic 等 Key，多 Key 自动轮询
- **离线回退**：未联网时使用内置默认配置，联网后自动合并服务端增量

---

## 三件事

### 一、用的明白

Token Bank 记录每一次调用：走了哪条路由、用了哪个模型、花了多少 Token、延迟多少毫秒。

- **Agent 纳管盘点**：网关登记常见 Agent，按应用汇总请求、Token、费用，区分网关实时与会话补录
- **今日看板**：总调用次数、本地源命中率、供给来源分布、模型排行（次数 / Token / 费用）
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

Token Bank 在本机运行 **智能路由链**，请求按优先级依次尝试：

```
本地源
    Ollama / 免费 API (Groq / GitHub Models) / 订阅 / 按量 API
    ↓ 不可用或需扩展算力
社区 P2P 源（消耗积分，调用社区共享算力）
```

**你的 AI 工具只需要对着一个本地地址发请求，** 路由对它们完全透明。

#### 场景路由

不同的使用场景可以绑定不同的供给链。比如：

| 场景 | 路由策略 |
|---|---|
| 日常对话 | 本地源免费 API 优先，不够再走社区 P2P |
| 代码补全 | 直接走本地 Ollama，零延迟零成本 |
| 长文档分析 | 本地源按量 API，保证质量 |

#### 本地源快速接入

一键扫描环境变量和工具配置，把已有的 LLM Key（Groq、GitHub Models、Anthropic 等）导入本地源。多个 Key 自动轮询，充分利用免费额度。

---

### 三、闲置的还可以赚钱

把你用不完的算力或 API 额度贡献给 **社区 P2P 网络**，赚取积分，再去消费社区共享模型。

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
| **盘点** | 多维统计：应用占比、**本地源 / 社区 P2P** 分布、模型排行（次数 · Token · 费用）、小时趋势、**压缩节省**、按量 + 订阅估算费用 |
| **网关** | **一键纳管** Claude Code / Codex / Gemini CLI 等；按应用绑定路由；场景路由与供给链；网关状态与调用日志（Trace） |
| **供给源** | **本地源**（Ollama / 免费 API / 订阅 / 按量）与 **社区 P2P 源**；动态目录下发；环境变量一键导入 |
| **个人** | P2P 积分 · **订阅账户**（APP + API + 按量，跨设备同步）· **多设备盘点**（各端用量占比与明细）· 刊例价与费用估算 |
| **配置** | 网关端口、超时、并发 · **无损压缩开关** · 日志级别 · 云端账号地址 |
| **社区网络** | 查看全球节点分布、在线贡献者、社区 P2P 模型供给情况 |
| **贡献** | 查看贡献节点状态、历史结算记录、质量系数趋势 |

---

## 接入任意 OpenAI 兼容客户端

```bash
# Claude Code（也可在网关页一键纳管，自动注入 ANTHROPIC_BASE_URL）
export ANTHROPIC_BASE_URL=http://localhost:11430

# Codex CLI（网关页纳管后自动注入 OPENAI_BASE_URL）
export OPENAI_BASE_URL=http://localhost:11430/v1

# Cursor / Copilot 等
OPENAI_BASE_URL=http://localhost:11430/v1
OPENAI_API_KEY=your-local-key

# curl 测试
curl http://localhost:11430/v1/chat/completions \
  -H "Authorization: Bearer your-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

> 推荐在 **网关** 页一键纳管，无需手动改环境变量；选择路由后 Agent 仍显示原生模型名，网关透明转发至第三方模型。

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

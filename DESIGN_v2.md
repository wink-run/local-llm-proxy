# Local LLM Proxy v2 — 三板块设计

> 状态：**设计草案，待评审**
> 更新：2026-05-20
> 关联仓库：`local-llm-proxy/`（本仓库）、`cc-switch/`（同级目录，作为「应用配置写入」能力的上游参考与可选依赖）
> 旧版设计：`./DESIGN.md`（保留作为「贡献者-积分体系」原始稿）

---

## 0. 整体定位与边界

Local LLM Proxy v2 不再只做「贡献-消费」一个闭环，而是把 **「让任意客户端访问任意来源的模型」** 当作核心问题，拆为三个互不依赖、但可以组合使用的板块：

| 板块 | 一句话 | 用户角色 |
|---|---|---|
| **① 模型接入（Egress / Client-side）** | 我有 key/订阅，怎样最快把它写到 Claude Code、Codex、Cursor 等工具里 | 终端开发者 |
| **② Provider 接入（Ingress / Source）** | 我从哪里搞到 key/订阅/共享额度 | 终端开发者 |
| **③ 模型服务贡献（Supply / Contribute）** | 我有富余的额度/本地模型，怎么共享出去换积分 | 贡献者 |

三个板块共用一个本地后端（FastAPI + SQLite + **Electron 客户端**，沿用现有 `client/electron/` 栈不切 Tauri），但 **每块都能独立可用**：

- 只用 ①：等价于「本地版 cc-switch + 路由策略引擎」
- 只用 ②：等价于「LLM 优惠/订阅 navigator + 自动回填」
- 只用 ③：等价于旧 DESIGN.md 描述的贡献网络（积分钱包仍然在）

```
┌────────────────────── 本地客户端（Electron，现状） ────────────────────────┐
│                                                                            │
│   板块①  模型接入            板块②  Provider 接入        板块③  贡献         │
│   ─────────────────         ─────────────────         ─────────────────    │
│   · 本地网关 :11435         · 免费源目录              · 本地 LLM 注册       │
│   · 路由策略                · 订阅源目录              · 富余 key 共享        │
│     - 省钱优先              · 用户分享池              · 质量打分 + 积分     │
│     - 质量优先              · 引导式注册 / 回填        · WS 反向通道 → VPS  │
│   · 一键写入 cc/codex/      · 一键导入到板块①                              │
│     cursor 配置                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                ┌───────────────────────────────────────┐
                │  VPS（可选，仅板块③ + 用户分享池需要） │
                │  · 贡献网络调度 + 积分结算           │
                │  · 用户分享池中转（隐藏 key）         │
                └───────────────────────────────────────┘
```

> **关键设计原则**：板块 ① 永远本地优先、零网络依赖；板块 ② 的「免费/订阅」段落也是纯本地导航 + 表单回填；只有「用户分享池」和板块 ③ 才依赖 VPS。这避免了「想用一下 cc-switch 替代品却被迫注册账号」的反模式。

---

## 1. 板块① 模型接入（Client-side Gateway + 一键写入）

### 1.1 目标

让用户的 Claude Code / Codex / Cursor / Continue / Aider / Cline / Roo 等工具，**在不感知后端来源** 的情况下，按用户选择的策略调用合适的模型。

### 1.2 核心组件

```
┌──────────────────────────────────────────────────────────────┐
│  本地网关 Local Proxy（OpenAI + Anthropic + Gemini 兼容）     │
│  默认监听 http://127.0.0.1:11435                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  路由策略    │→ │  Provider    │→ │  上游适配器       │   │
│  │  Engine      │  │  Pool        │  │  (OpenAI/Anthr.   │   │
│  │              │  │  (来自板块②) │  │   /Gemini/Ollama) │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│         │                                                    │
│         └─→ 决策依据：模型映射表 + 单价表 + 健康度           │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
   ┌─────────────────── 一键写入 ────────────────────┐
   │   Claude Code   Codex   Cursor   Continue       │
   │   Aider         Cline   Roo      OpenCode       │
   └─────────────────────────────────────────────────┘
```

### 1.3 路由策略：省钱优先 vs 质量优先

每个「逻辑模型名」（例如 `claude-sonnet-4`、`gpt-5.5`）背后挂一条 **provider 候选链**。策略只决定候选链的排序与挑选。

#### 策略定义

| 策略 | 排序键 | 平价时的 tie-break | 适用场景 |
|---|---|---|---|
| **省钱优先 (cost)** | `effective_price_per_1M_tokens` 升序 | 健康度高者优先 | 跑量、批处理、个人探索 |
| **质量优先 (quality)** | `quality_score` 降序 | 价格低者优先 | 关键代码、生产联调 |
| **自定义** | 用户拖拽排序 | — | 高级用户 |

`effective_price` = `provider 公告价` × `(1 - 用户当前订阅折扣)` × `(1 - 平台返点)`，订阅 plan 用户在限额内 effective_price = 0。
`quality_score` = `0.5×SLA延迟 + 0.3×成功率 + 0.2×近 7d 投诉率`，由 VPS 聚合（可选）+ 本地实测共同算出。

#### 模型同名归并

不同 provider 会用不同 ID 暴露「同一个模型」（如 `claude-opus-4-7` / `anthropic/claude-opus-4-7` / `claude-opus-4-7-20260115`）。本地维护一份 **`model_alias` 表**：

```yaml
# data/model_aliases.yaml（内置 + 用户可覆盖）
claude-opus-4-7:
  aliases: [anthropic/claude-opus-4-7, claude-opus-4-7-20260115]
  tier: premium
  context: 1M
gpt-5.5:
  aliases: [openai/gpt-5.5, azure/gpt-5.5]
  tier: premium
  context: 400K
```

调用方只看 `claude-opus-4-7`；网关根据策略选具体 provider，再把请求里的 model 字段改写成该 provider 接受的 ID。

#### 故障转移

- 上游 5xx / 超时 / 429 → 自动切到候选链下一个 provider
- 同一会话内尽量保持 sticky（避免一段 tool call 跨 provider 出现 message_id 不一致）
- 触发降级时通过 SSE 推到客户端 UI，记日志可审计

### 1.4 一键写入：内置写入器（主）+ cc-switch 导出（可选增强）

**默认走 Path B（内置写入器）**，不要求用户安装任何外部工具。Path A（cc-switch deeplink）作为可选增强，照顾已在用 cc-switch 的用户。理由：避免把核心能力挂在外部产品的版本节奏上，同时降低首次使用门槛——大部分"想 5 分钟把 key 写进 Claude Code"的用户不会愿意先装一个桌面应用。

#### Path B：内置写入器（**默认 / 必选实现**）

参考 cc-switch 源码（`src-tauri/src/services/` 与 `src-tauri/src/database/`）已经摸清的「各工具配置文件位置 + 字段名」，在 local-llm-proxy Electron 客户端里实现一个轻量等价版（Node/Python 一次性实现，几百行）：

| 工具 | 配置文件 | 写入字段 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN` |
| Codex CLI | `~/.codex/config.toml` | `[model_providers.<name>] base_url, env_key` |
| Cursor | `~/.cursor/User/settings.json` 或应用内 API 设置 | `cursor.openaiApiKey`, `cursor.openaiBaseUrl` |
| Continue (VS Code) | `~/.continue/config.yaml` | `models[*].apiBase`, `apiKey` |
| Aider | `~/.aider.conf.yml` | `openai-api-base`, `openai-api-key` |
| Cline / Roo | VS Code 设置项 | `cline.openAiBaseUrl` 等 |
| OpenCode | `~/.opencode/config.json` | `provider.openai.baseURL` |
| Gemini CLI | `~/.gemini/settings.json` | `auth.apiKey`, `auth.baseUrl` |

**核心机制（从 cc-switch 移植而非依赖）**：

1. **atomic write**：先写 `*.tmp` 再 `rename`，防止半写状态导致配置文件损坏
2. **backfill on edit**：每次写入前先回读现有配置，**只覆盖 base_url / api_key 这几个固定字段**，用户在工具里手改的其它字段（如 `model`、`extra_args`、MCP 配置等）原样保留
3. **自动备份**：写入前把原文件存到 `~/.local-llm-proxy/backups/{tool}-{ISO8601}.{ext}`，自动轮转保留最近 10 份
4. **配置 schema 单文件**：把每个工具的「配置路径 + 字段映射 + 默认值」抽到 `client/src/data/appConfigSchemas.js`，便于后续加新工具
5. **SSOT 表**：SQLite 维护 `app_bindings`（`app_name | last_written_at | base_url | api_key_masked`），UI 直接展示每个工具当前用的是哪条网关

> 之所以从 cc-switch **移植**而不是**依赖**：cc-switch 的 deeplink schema 在 v3.10 → v3.11 已经有过调整，把核心功能挂在外部产品的版本节奏上意味着每次它发版都要回归测试。一次性投入 vs 长期维护负担，前者明显更优。

#### Path A：cc-switch deeplink（可选增强 / 后置里程碑）

用户已装 cc-switch 时，提供一个「导出为 cc-switch deeplink」按钮，把本地网关注册为 cc-switch 的 **universal provider**（结构兼容 Claude / Codex / Gemini 三端）：

`ccswitch://import?type=universal&payload=<base64-json>`

payload 示例：

```json
{
  "name": "Local LLM Proxy (Cost-First)",
  "providerType": "local-llm-proxy",
  "baseUrl": "http://127.0.0.1:11435",
  "apiKey": "lp-XXXXXXXX",
  "defaultApps": { "claude": true, "codex": true, "gemini": true },
  "defaultModels": { ... 同名归并后的列表 ... }
}
```

让 cc-switch 用户继续走他们熟悉的多设备同步、tray 快切链路；但 local-llm-proxy 本身不依赖它存在。

### 1.5 网关 API 表面

```
POST /v1/chat/completions      OpenAI 兼容
POST /v1/messages              Anthropic 兼容
POST /v1beta/models/.../...    Gemini 兼容
GET  /v1/models                返回同名归并后的逻辑模型列表
GET  /__local__/health         本地健康 + 当前策略
POST /__local__/strategy       切换策略（cost / quality / custom）
GET  /__local__/providers      当前候选链与每条的 effective_price/quality
```

`/__local__/*` 仅本机回环可访问，避免外暴。

### 1.6 UI（板块① 主页）

```
┌─────────────────────────────────────────────────────────────┐
│  模型接入                          [策略] ⚡省钱  ⭐质量  ⚙   │
├─────────────────────────────────────────────────────────────┤
│  逻辑模型               候选 Provider                价格    │
│  ─────────────────     ────────────────────         ─────   │
│  claude-opus-4-7        [Anthropic 直连]  ★★★★☆     $15/$75 │
│                         [DMXAPI 中转]     ★★★☆☆     ¥10/¥48 │
│                         [PackyCode]       ★★★★★     ¥12/¥58 │
│                                                             │
│  gpt-5.5                [OpenAI 直连]     ★★★★★     $10/$30 │
│                         [Azure]           ★★★★☆     $9 /$28 │
├─────────────────────────────────────────────────────────────┤
│  一键写入                                                    │
│  ☑ Claude Code   ☑ Codex   ☑ Cursor   ☐ Continue            │
│  [ 写入选中应用 ]  ← Path A 走 cc-switch deeplink            │
│  [ 仅生成 deeplink ]                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 板块② Provider 接入（来源三层 + 引导回填）

### 2.1 目标

让用户用最低成本把「能用的模型来源」灌进板块① 的 Provider Pool。三类来源分层呈现，每类都给出 **引导（如何注册/订阅/领取）** 和 **回填（拿到 key 后自动写到本地）**。

### 2.2 三层结构

```
┌──── Provider 接入 ────────────────────────────────────────┐
│                                                           │
│  Layer 1: 免费源 Free        - 0 成本，多数有限流          │
│  Layer 2: 订阅/付费 Paid     - 有 plan / 充值              │
│  Layer 3: 用户分享池 Shared  - 来自板块③ 贡献网络          │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 2.3 Layer 1：免费源

#### 候选清单（内置目录，可热更）

| 名称 | 限额 | 模型 | 引导链接 |
|---|---|---|---|
| Google AI Studio | 个人免费 quota | Gemini Pro / Flash | console |
| Groq | 免费 RPM | Llama 3.1/3.3、Mixtral | console |
| Cerebras | 免费 daily | Llama 3.1/3.3 | console |
| OpenRouter `:free` 后缀模型 | 免费 RPD | 多家开源 | openrouter.ai |
| Together AI Free Tier | $5 一次性 | 多家开源 | together.ai |
| Cloudflare Workers AI | 免费 RPD | Llama, Qwen | dash |
| Fireworks Free | 免费 quota | DeepSeek, Llama | fireworks.ai |
| **本地 Ollama** | 无限 | 任意自部署 | 本机 |

每个条目结构：

```yaml
id: groq
display: "Groq Cloud"
tier: free
base_url: "https://api.groq.com/openai/v1"
auth: { type: "bearer", env: "GROQ_API_KEY" }
signup_url: "https://console.groq.com/keys"
guide_md: "providers/free/groq.md"   # 内置 markdown 步骤
models: ["llama-3.3-70b-versatile", "mixtral-8x7b"]
quota_hint: "RPM 30, TPM 6k（免费档）"
```

#### 引导流程

```
[ 选择 Groq ]
   ↓
显示 guide_md（截图 + 步骤）
   ↓
按钮 [ 打开注册页 ]  → 系统浏览器打开 signup_url
   ↓
用户拿到 key，回到客户端 [ 粘贴 key ]
   ↓
点击 [ 测试连接 ]  → 调一次 /models 验活
   ↓
成功 → 写入本地 keystore（OS keychain / DPAPI）→ 同步到板块① Provider Pool
```

### 2.4 Layer 2：订阅 / 付费

#### 候选清单（自维护 + 「一次性从 cc-switch 导入」）

v2 自维护一份 `providers/paid.yaml`（不和 cc-switch 共享同一份目录，避免随对方运营节奏波动、字段 schema 漂移）。标注 `affiliate=true` 的条目在 UI 顶部加 `[优惠]` 角标，配一行说明。

同时提供 **「从 cc-switch 一次性导入合作伙伴」** 按钮，作为起步阶段加速器：

- 检测本机是否安装 cc-switch（`~/.cc-switch/cc-switch.db` 是否存在）
- 读取其 provider presets 及 `assets/partners/*` 对应条目
- 用户勾选要导入的项 → 合并到本地 `providers/paid.yaml`（冲突时让用户选保留哪份）
- 导入项打 `imported_from: cc-switch` 标签便于追溯
- **导入后两边各自维护，不做实时同步**——避免 cc-switch 加新赞助商时静默改我们的 UI

| 类型 | 代表 |
|---|---|
| 官方直连 | OpenAI, Anthropic, Google, xAI |
| 一线中转/聚合 | OpenRouter, AICodeMirror, PackyCode, DMXAPI, Crazyrouter, LemonData |
| 国内官方 | 智谱 GLM, MiniMax, 火山方舟, 阿里通义, 硅基流动, 月之暗面 Kimi |
| 包月 Plan | Cursor Pro, Claude Pro/Max, ChatGPT Plus（通过浏览器扩展或网关挂载，**法律风险用户自担**，UI 加红色提示） |

#### 引导回填同 Layer 1，但额外字段：

```yaml
plan_options:
  - name: "Monthly Pro"
    price: "$20/mo"
    quota: "无限 chat + 200 fast tokens"
plan_signup_url: "..."
billing_hint: "首充建议 ¥10，验证不被风控后再大额"
imported_from: "cc-switch"   # 来源标识，仅导入项有
```

### 2.5 Layer 3：用户分享池

这是 v2 与旧 DESIGN.md 的衔接点。

```
┌──── 板块③ 贡献网络（VPS） ────┐
│  · 工人 A：富余 GPT-5.5 quota  │ ──┐
│  · 工人 B：本地 Qwen3-72B      │   │
└──────────────────────────────┘    │
                                    │ 通过 VPS 中转
                                    ▼
┌──── 板块② Layer 3：用户分享池 ──────────────────┐
│  · 列表显示当前可用的「匿名 worker × 模型」     │
│  · 每条：5 分钟均价（积分计）、健康度、SLA     │
│  · 用户可以「订阅」某条 → 直接挂到板块① Pool   │
│                                                 │
│  价格单位：积分（不是 ¥/$）                      │
│  积分来源：板块③ 贡献 或 充值                    │
└─────────────────────────────────────────────────┘
```

引导文案明确：**「价格不稳定、可能下线、适合做模型试用 / 灾备 / 偶发跑批；不建议作为唯一来源」**。

### 2.6 Keystore 与回填策略

- **存储**：所有 API key 用 OS keychain（macOS Keychain / Windows DPAPI / libsecret），不进 SQLite 明文
- **回填**：用户在 cc-switch 或工具里手改过 key → 下次同步前先读、不静默覆盖
- **导出**：支持 `--export-encrypted` 用户主密码加密导出，跨设备迁移
- **泄漏检测**：定时 `GET /v1/models` 自检，403 / 401 触发用户提醒

---

## 3. 板块③ 模型服务贡献（Supply / 贡献网络）

### 3.1 与旧 DESIGN.md 的关系

**保留旧 DESIGN.md 第 3–14 章的全部细节**（两层模型 / 积分体系 / 质量乘数 / 用户账户 / 推荐 / 鸣谢墙 / 数据库 schema / 5 分钟结算器 / WS 反向通道）。

v2 在此基础上做三处补强：

#### 3.1.1 贡献来源扩展（含可见性分级）

旧设计默认贡献者是「本地 LLM 算力」。v2 扩展为三种贡献形式，**按风险等级分两层 UI 可见性**：

| 形式 | 例子 | 默认可见性 | 风险等级 |
|---|---|---|---|
| **本地算力** | Ollama / vLLM | **主 UI 默认开放** | 低（最坏：本机累） |
| **私有网关** | 公司内 OneAPI / NewAPI / 自建 Azure | **主 UI 默认开放** | 低-中（自行评估公司合规） |
| **富余订阅 key** | OpenAI 月底剩 $30 / Claude Pro 限额没用完 | **「高级模式」开关后才出现** | **高（违反上游 ToS，可能封号，可能违反"未授权转售"相关条款）** |

> 重要：旧版的「Upstream API keys never leave your machine」原则在三种形式下都保持不变。

**为什么把"富余订阅 key"藏到高级模式？**

- **风险不对称**：本地算力 / 私有网关被滥用最多让机器累；订阅 key 被识别后可能 **永久封号 + 平台 IP/UA 被联合风控**，伤害扩散到所有贡献者
- **平台保护**：参考早期"共享 ChatGPT Plus"类项目被批量封禁的先例，需要从产品形态上避免轻度用户无意中卷入
- **形式合规 → 实质合规**：在主 UI 平铺一个勾选框 + 弹窗免责声明，法律上是脆弱的；放进「高级模式」+ 多一步显式开关，能更明确地证明用户的知情同意
- **不挡真正需要的人**：高级用户找得到入口（Settings → Advanced → 勾选「启用高风险贡献来源」）；轻度用户不会被这个选项干扰

#### 3.1.2 与板块② Layer 3 打通

- 每个 worker 在线时自动在 VPS 侧 publish 一个「分享池条目」
- 旧版的「鸣谢墙」与新版的「分享池」共用同一份 worker 数据，只是展示视角不同：
  - 鸣谢墙 → 看人（贡献者排名）
  - 分享池 → 看货（模型可用性）
- 「富余订阅 key」类来源在分享池条目上加 **「Plan/Key 共享」** 标签，消费方可在策略里选择"避开此类来源"（默认 **避开**）

#### 3.1.3 贡献策略开关

新增 UI 让贡献者细控（订阅 key 部分仅当「高级模式」开启后才出现）：

```
本机可贡献的来源：
  ☑ Ollama (qwen3-72b)            [无限]
  ☑ 公司 OneAPI                   [仅工作时间 09-18 共享]

  ── 高级模式（已启用） ──────────── ⚠ 涉及上游 ToS 风险，详见声明
  ☐ OpenAI key (gpt-5.5)          本月剩 $42，[最多贡献 $30] [硬上限]
  ☐ Claude Pro                    Plan 类，按 RPM 共享：30 → [限速 10]

贡献门槛：
  ☑ 平均延迟 < 5s
  ☑ 当本机 CPU/GPU 占用 > 80% 时暂停
  ☐ 仅给积分 ≥ 100 的消费者
```

### 3.2 数据库新增表（在旧 schema 基础上）

```sql
-- 区分贡献形式
ALTER TABLE worker_sessions ADD COLUMN source_kind TEXT DEFAULT 'local';
-- 'local' | 'upstream_key' | 'gateway'

-- 贡献额度配额（上游 key 模式）
CREATE TABLE contribution_quotas (
    id INTEGER PRIMARY KEY,
    worker_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    quota_unit TEXT NOT NULL,        -- 'usd' | 'tokens' | 'rpm'
    quota_total REAL NOT NULL,
    quota_used  REAL DEFAULT 0,
    period      TEXT DEFAULT 'month' -- 'month' | 'day' | 'lifetime'
);
```

### 3.3 安全与合规

- **可见性分级**：富余订阅 key 类来源默认 **隐藏在「高级模式」开关后**（Settings → Advanced → 「启用高风险贡献来源」），主 UI 仅展示本地算力 / 私有网关。理由详见 §3.1.1。
- **三重 acknowledge**：开启高级模式 → 弹长文版风险声明（含上游 ToS 摘录 + 封号案例）→ 用户必须勾选「我已理解 4 条具体风险」才能继续 → ack 文本快照、时间戳、用户 ID 写入独立 `tos_acks` 表（不是 `transactions.note` 一笔带过）
- **审计可重放**：每次开启某个高风险来源、调整额度上限、关闭后再开启，都写一条 `tos_acks` 记录，便于事后纠纷重建用户操作序列
- **风控联动**：当 VPS 侧检测到某 worker 在 1 小时内被上游连续 ban（403/401 链），自动下线该来源、通知贡献者、并把该 worker 加入 24h "冷静期"，避免被联合风控
- **未来重新评估**：如果上游官方推出合规的"团队共享 / 多人 plan"额度共享机制，可把这条路径移回主 UI
- **审计日志**：每次代理请求只记 metadata（token 数 / 延迟 / 模型 / worker_id），不记内容。
- **风控**：当某 worker 在 1 小时内被上游 ban（403 chain），自动下线该来源并通知贡献者，避免 key 被关联封号。

---

## 4. 三板块之间的数据流

```
┌───────── ② Provider 接入 ─────────┐        ┌───── ③ 贡献 ─────┐
│ 免费源 / 订阅 / 用户分享池        │        │ 本地算力 / 富余 key│
│                                  │        │  / 私有网关       │
└───────────────┬──────────────────┘        └────────┬─────────┘
                │ key/endpoint                       │ ws://
                ▼                                    ▼
       ┌─────────────────────────────────────────────────┐
       │           本地 Provider Pool（持久化）           │
       │   provider_id | base_url | auth | tier | health │
       └────────────────────────┬────────────────────────┘
                                │
                                ▼
                  ┌───── ① 模型接入 ─────┐
                  │   路由策略 Engine    │
                  │   省钱 / 质量 / 自定 │
                  └──────────┬───────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
       本地网关 :11435               一键写入器
       供 CLI/IDE 调用              Claude Code / Codex / Cursor ...
                                    （经 cc-switch deeplink 或内置写入）
```

---

## 5. 实施优先级（P0 → P2）

### 5.1 核心结论摘要

| 板块 | 核心价值 | 现有能力 | 新增工作 | 优先级 |
|---|---|---|---|---|
| 一：**本地网关** | 统一入口 + 智能路由 | 无 | **全新开发** | **P0** |
| 二：免费层 | 零成本扩充供给 | Worker 接入已支持 | 补 Onboarding 引导 UI | **P0** |
| 二：订阅层 | 订阅账号变 API | 无 | 核心新功能（本地代理转换） | P1 |
| 二：分享层 | P2P 算力共享 | **已完整支持**（旧 DESIGN.md） | 仅 UI 展示优化 | P2 |
| 三：服务贡献 | 积分经济闭环 | 基本完整 | 面板展示三层接入点状态 | P2 |

> **从 P0 开始**：先做本地网关 Proxy + 免费 Provider 引导，**改动最小但用户感知最强**——用户立刻能用免费模型 + 一键写入到 Claude Code / Cursor。订阅层 / 分享层在 P0 跑通后再迭代。

### 5.2 实施里程碑（建议）

| M | 目标 | 涉及板块 | 依赖 |
|---|---|---|---|
| M0 | 抽出 Provider Pool 数据层 + Keystore + `appConfigSchemas.js` | 公共 | — |
| M1 | 板块① MVP：本地网关 + 双策略 + 模型同名归并 | ① | M0 |
| M2 | 板块① 一键写入 **Path B（内置写入器）**，覆盖 Claude Code / Codex / Cursor / Continue / Aider / Cline / OpenCode / Gemini CLI | ① | M1 |
| M3 | 板块② Layer 1 + Layer 2：内置目录 + 引导回填 + 「一次性从 cc-switch 导入」按钮 | ② | M0 |
| M4 | 板块① **Path A（cc-switch deeplink 导出）** 作为可选增强 | ① | M2 |
| M5 | 板块③ MVP：本地算力 + 私有网关两种 source_kind（主 UI） | ③ | M0 |
| M6 | 板块② Layer 3：分享池接入板块③ | ②③ | M5 |
| M7 | 板块③ 高级模式：富余订阅 key 来源 + 三重 ack + `tos_acks` 表 + 风控冷静期 | ③ | M5 |
| M8 | 质量打分 + 故障转移 + 审计日志完整版 | ①③ | M5 |
| M9 | **生态整合 Step 1**（高价值/低风险）：prompt-cache 中间件 + FreeLLMAPI 导入到板块② Layer 1 | ①② | M1, M3 |
| M10 | **生态整合 Step 2**（高价值/需谨慎）：订阅贡献者 Worker 类型（参考 CCSwitch / Sub2API 核心逻辑） | ③ | M7 |

> **关键取舍**：Path B 内置实现为主线（一次性投入几百行 Node/Python），cc-switch 仅作参考实现 + 可选导出目标。避免把核心功能挂在外部产品版本节奏上、降低首次使用门槛。富余订阅 key 类贡献延后到 M7 并锁在高级模式后。生态整合分两步走详见 §6。

---

## 6. 生态整合策略（Token Bank × 5 个外部项目）

> Token Bank = local-llm-proxy v2 的产品代号，强调「积分作为统一价值载体」的定位。
> 本节回答：相邻生态里 5 个项目（OneAPI / CCSwitch / Sub2API / FreeLLMAPI / prompt-cache）哪些值得整合、怎么整合、按什么顺序。

### 6.1 各项目特色定位

| 项目 | 核心能力 |
|------|---------|
| **OneAPI** | 多渠道聚合网关，统一 OpenAI 格式，支持负载均衡、计费、渠道管理 |
| **CCSwitch** | Claude 订阅账号轮换，把订阅席位变成 API 接入点 |
| **Sub2API** | 订阅转 API 通用框架，浏览器自动化驱动订阅服务出流量 |
| **FreeLLMAPI** | 免费模型聚合，低成本扩充可用模型池 |
| **prompt-cache** | Anthropic Prompt Caching，重复前缀缓存，降低 token 消耗 |

> 注意：CCSwitch 这里指的是「Claude 订阅账号转 API」的能力（与 v2 板块① 引用的 cc-switch 桌面配置切换器是同名不同项目），整合时作为板块③ 的一种新 worker 类型。

### 6.2 与 Token Bank 整合后的差异化价值

**1. 供给侧大幅扩展**

目前 Token Bank（板块③）的贡献者主要是本地运行的 LLM 或富余 API key。整合后：
- CCSwitch / Sub2API 贡献者可以用 **Claude 订阅账号、Gemini 订阅** 参与贡献
- FreeLLMAPI 接入免费模型作为兜底层（馈入板块② Layer 1）
- OneAPI 的渠道管理可作为内部调度层借鉴，统一出口格式

贡献门槛从「有 GPU」降低到「有订阅账号」，供给量级完全不同。

**2. 成本结构优化**

| 场景 | 当前 | 整合后 |
|------|------|-------|
| 重复系统 prompt | 全量计费 | prompt-cache 中间件降低 60–90% 成本 |
| 模型不可用时 | 失败 | 板块① 路由引擎 + OneAPI 思路自动切换备用渠道 |
| 免费模型需求 | 不支持 | FreeLLMAPI 兜底，零成本消耗 |

**3. 网络效应护城河**

整合后 Token Bank 变成一个 **异构贡献网络**：GPU 贡献者、订阅贡献者、免费渠道贡献者共存于同一积分体系。积分成为统一的价值载体，不同来源的算力可以互相兑换。这是 OneAPI / CCSwitch 单独使用时不具备的。

**4. 合规风险分层**

订阅转 API 本身有上游 ToS 封号风险。整合到 Token Bank 后可以做风险隔离：
- 高风险渠道（CCSwitch / Sub2API 类订阅贡献者）只在 **私有部署模式 / §3.3 高级模式** 下开放
- 对外 API 统一走正规 API Key 渠道
- 积分体系可以设置渠道权重，自动降低高风险渠道占比
- 复用 §3.3 已设计的 `tos_acks` 表 + 风控冷静期机制

### 6.3 核心整合建议（分两步）

最高价值的切入点不是全量整合，而是分两步：

**Step 1（高价值 / 低风险）**：接入 prompt-cache + FreeLLMAPI ↔ 对应里程碑 **M9**

- **prompt-cache 中间件**：作为板块① 本地网关 `:11435` 的可选请求中间件，按 `model` / 请求头开关，默认只对 `temperature=0` 且显式 opt-in 的请求生效，避免对 agent / 工具调用场景的语义误命中
  - 对现有 Claude 渠道立即生效，降本显著
  - 不影响请求路径上的故障转移逻辑
- **FreeLLMAPI 导入**：把 FreeLLMAPI 的免费源目录批量导入板块② Layer 1，作为内置目录的扩展
  - 一次性导入，不在请求路径上
  - 扩充免费模型池，提升网络覆盖率

**Step 2（高价值 / 需谨慎）**：设计「订阅贡献者」Worker 类型 ↔ 对应里程碑 **M10**

- 参考 CCSwitch / Sub2API 的核心逻辑，在板块③ 设计 **插件式 Worker 类型**（与现有 `source_kind` 体系融合：新增 `subscription` 类型）
- 贡献者本地运行订阅代理（浏览器自动化 / Cookie 转 API），与现有 WebSocket Worker 协议复用
- 积分率单独定价：订阅贡献风险高 → `contribute_rate` 应高于 Open 模型；同时强制走 §3.3 的高级模式开关 + 三重 ack
- 消费端默认 **避开** 此类来源，需要显式开启「允许订阅类来源」

### 6.4 不采纳的整合（与决策理由）

| 项目 | 为什么不全量整合 |
|------|------------------|
| **OneAPI 串联在请求路径上** | 板块① 已经是网关角色，再串一层 OneAPI = 双层路由 + 双层健康检查，延迟和故障率叠加。借鉴其渠道管理思路，但不串联部署。 |
| **CCSwitch（桌面应用） 放进请求链路** | CCSwitch 桌面端是**配置写入器**，不是网络代理。板块① 的「一键写入」已覆盖此场景，且方向相反（client-side 写配置 vs server-side 路由）。 |
| **Sub2API 作为独立服务部署** | 浏览器自动化方案脆弱、维护成本高。仅借鉴其「订阅转 API」核心逻辑，融入板块③ 新 worker 类型，不作为独立组件。 |

---

## 7. 与旧 DESIGN.md 的差异速查

| 维度 | 旧 DESIGN.md | DESIGN_v2.md |
|---|---|---|
| 核心问题 | 局域网模型 + 贡献积分 | 三板块：接入 / 来源 / 贡献 |
| 是否强依赖 VPS | 是 | 否（仅板块③ 与板块② Layer 3 需要） |
| 客户端形态 | Agent 二进制 + 服务端 web UI | Electron/Tauri 客户端（含 ①②） + Agent（③） |
| 接入工具 | 未涉及 | 内置或经 cc-switch 写入 7+ 工具 |
| 来源类型 | 本地 LLM | 免费 / 订阅 / 共享 / 本地 / 富余 key / 私有网关 |
| 路由策略 | 无（按模型直转） | 省钱 / 质量 / 自定义 + 故障转移 |
| 积分体系 | 详尽 | 完全保留，仅扩展 source_kind |

---

## 8. 关键技术决策（2026-05-20 定稿）

| # | 议题 | 决策 | 一句话理由 | 何时重新考虑 |
|---|---|---|---|---|
| 1 | 客户端 UI 技术栈 | **保持 Electron 现状** | 现有 `client/electron/` + Vite + React + Node sub-process 已成型；后端是 FastAPI，Tauri 的同栈红利吃不到；切栈沉没成本高于收益 | 包体破 200MB 或需要 tray 快切（Tauri 真正甜区） |
| 2 | 一键写入主路径 | **Path B 内置写入器为主**，Path A（cc-switch deeplink）作可选增强 | 降低首次门槛（无需装第三方桌面应用）；把核心能力和外部产品版本节奏解耦；cc-switch 源码只作参考、不作依赖 | cc-switch 把 schema 抽成独立 npm 包并承诺向后兼容 |
| 3 | Layer 2 合作伙伴目录 | **自维护一份 `providers/paid.yaml`**，提供「一次性从 cc-switch 导入」按钮，导入后两边各自维护、不实时同步 | 避免随对方运营节奏被动加广告位；同时复用其已筛选的优质条目作起步加速 | 与 cc-switch 达成分成共享协议 |
| 4 | 富余订阅 key 贡献可见性 | **藏到「高级模式」开关后**（默认隐藏），三重 ack + `tos_acks` 表审计 | 风险不对称（订阅 key 封号 + 联合风控影响整个网络）；高级用户找得到，轻度用户不被误伤；形式合规 → 实质合规 | 上游官方推出合规的多人 plan 额度共享机制 |

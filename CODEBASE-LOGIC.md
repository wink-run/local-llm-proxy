# Token Bank (local-llm-proxy) 项目逻辑总览

> 本文档梳理当前代码的实际逻辑（已在开源原版基础上重写大量功能，截至梳理时约 468 个 commit）。
> 近期开发主线是 **Session 子系统**（跨 agent 会话聚合 / 续聊 handoff / 知识提炼）。
> 来源：代码 + git 历史 + Claude Code 会话记录。

---

## 0. 一句话定位

**本地 LLM 网关 + Token 管理器**：夹在 AI 工具和各家 LLM 供给源之间，做三件事——
看清花费（Know）、自动省钱（Spend less）、闲置额度变积分（Earn）。

三大支柱（v0.4）：
1. **Agent 追踪与纳管** —— 把 Cursor / Claude Code / Codex / Cherry Studio 等纳入网关，实时代理或导入会话日志。
2. **个人订阅中心** —— APP 订阅（统计 / OAuth 转网关）、API 订阅、按量付费（PAYG）三类统一管理。
3. **多维分析** —— 按 应用 / 供给源 / 模型 / 层级 / 成本 / 设备 / 时间 切片。

---

## 1. 仓库结构与运行形态

```
local-llm-proxy/
├── client/                # 桌面端 + CLI + 前端（核心）
│   ├── electron/          # Electron 主进程 + 网关 + 全部核心逻辑（Node）
│   ├── src/               # 前端页面（pages: Dashboard/Gateway/Providers/Profile/...）
│   ├── cli/               # 无头网关 CLI（gateway.js / admin-api.js / agent-control.js）
│   └── shared/            # 设备身份、配置加载、遥测等跨端共享
├── server/                # P2P 后端（Python，自托管，可选）
├── agent/                 # P2P worker 节点（Python）
├── docker-compose.yml     # gateway / proxy 两套服务
├── nginx/                 # 反代 + HTTPS
└── gateway-data/          # Docker 运行时数据卷（首启生成 local-config.json）
```

**三种运行形态**：
| 形态 | 入口 | 说明 |
|---|---|---|
| 桌面 app | Electron `main.js` | Mac `.dmg` / Win `.exe`，菜单栏常驻，自动更新 |
| CLI / 服务器 | `node cli/gateway.js start` | 无头，行为与桌面一致 |
| Docker | `docker compose up gateway` | 容器化，Web UI 配置 |

**端口约定**：
| 端口 | 用途 |
|---|---|
| `11430` | LLM 请求入口（`OPENAI_BASE_URL=http://localhost:11430/v1`） |
| `11431` | Web 管理 UI |
| `8000` | P2P 后端（自托管 server） |

---

## 2. 网关核心 — `client/electron/local-gateway.js`

监听 `11430`，是所有请求的转发中枢。

- **多协议入口**：OpenAI 兼容 + Anthropic（`/v1/messages`）+ Gemini。
- **协议互转**：`anthropicToOpenai` / `openaiToAnthropic` / `oaiRequestToAnthropic` / `anthropicRespToOai`，外加 `codex-transform.js`（Codex↔OpenAI / Codex→Claude 桥）。
- **供给源选择**：`enabledProviders()` + `providerHasModel()`，按路由结果挑 provider。
- **转发**：`proxyRequest()` 流式透传 SSE；上游 4xx/5xx 错误体原样记录（便于排查 429/401）。
- **base_url 兼容**：`normBase` / `apiVer` 支持非 `/v1` 版本号（`/v2`、`/v3`、`/v4`），裸域名补 `/v1`。
- **代理链**：`provider.proxy` > 全局 `network_proxy` > 环境变量（`HTTPS_PROXY`/`HTTP_PROXY`，遵守 `NO_PROXY`）。
- **压缩统计**：`compressionStats()` + `_recordCompression()` 记录网关无损压缩前后字节。
- **路由日志**：`route_log` 持久化每次请求落到哪条链路。

---

## 3. 路由引擎 — `client/electron/request-router.js`（+ server `scene_router.py`）

由 **YAML 驱动**的条件规则引擎（`routing.rules` + `feature_extraction`）。

- **特征提取** `extractFeatures`：
  - `extractStructure` —— 模态/结构（是否多模态、消息形态）。
  - `extractSemantic` —— 语义/关键词（`code_keywords` 命中判定是否代码任务）。
  - token 量级。
- **规则匹配** `matchRule` → `resolvePolicy`：返回 policy id 或 inline `{ strategy, providers }`。
- **供给源排序** `selectProviders` / `resolveProviderOrder`：按策略 + `recordLatency` 的实测延迟排。
- **降级链**（核心理念）：

  ```
  本地 Ollama  → 免费层(Groq / GitHub Models)  → P2P 网络(花积分)  → 付费 API(OpenAI/Anthropic)
       ↓无匹配模型        ↓限流/不可用                ↓积分不足              ↓兜底
  ```
- **场景路由（scene routes）**：不同用途映射不同供给链（日常聊天 / 代码补全 / 长文分析）。
- 路由步骤会校验本地模型可用性：缺失标红并提示重设。

---

## 4. 供给源 / Provider 体系

**三层分级**：free / P2P / paid。

**认证多形态**：
| 形态 | 实现 | 说明 |
|---|---|---|
| OAuth 订阅 | `client/electron/oauth/index.js` | 一张 `PROVIDERS` 配置表（claude / codex / google / copilot），统一 PKCE / 设备码 / token 刷新 / `needsRefresh`；新增 = 加一条 |
| API Key | provider 条目 | 直填 key |
| PAYG（按量） | Profile → PAYG | 注册模型 + USD/M-token 价目；**网关只放行 profile 里配置过的模型** |

- **provider catalog 由 YAML 驱动**（`catalog`），UI 可增删改。
- **预设**：`client/src/data/llmProviderPresets.js` —— 各厂商 base url + 常用模型 ID（OpenAI/Anthropic/智谱/火山/硅基/MiniMax/Gemini…）。
- **billing_type**：`subscription` / `api-key` / `payg`，贯穿统计与账单。
- Gemini 只走 API Key（其 OpenAI 兼容端点不支持 OAuth），OAuth 能力以客户端 `OAUTH_BY_ID` 为准。

> OAuth 表的设计哲学与 CodexBar 的 `ProviderDescriptorRegistry` 同构——"加 provider = 加一条配置"，
> 是后续接入"用量额度抓取"的天然挂载点（凭证已就绪，缺的是 usage 端点 + 字段映射）。

---

## 5. 应用纳管（Agent Onboarding）—— 双轴状态机

让各 AI 工具的用量都被记录，即使它们不走网关。两条采集路径：

1. **走网关代理**：工具指向 `11430`，实时记录 route/token/cost。
2. **MITM 抓直连**：`mitm-proxy.js` + `ca-manager.js`（CA 证书）+ `shim-installer.js` 接管 `claude` / `codex` CLI
   （即 memory 里记录的 Token Bank shim：CLI 走本地 `11430`）。
3. **会话日志导入**：见 §6 的 `session-import.js`——绕过网关的流量靠扫日志补齐。

- `detect-tools.js` 检测已安装工具；`agent-linker.js` 关联应用与路由。
- **双轴状态机**：纳管 / 还原；还原保留 `route_id`，重新纳管直接复用原路由。
- **按 entrypoint 拆分** Claude Code 用量：CLI / Desktop 分离，`sdk-cli` 跳过；prompt-cache token 计入总量。
- 直连应用（如 Cursor）也纳入统计，默认纳管 + 走网关去重。

---

## 6. ⭐ Session 子系统（近期开发主线）

三层结构，纯逻辑可单测，IO 在 orchestration 段。

### 6.1 `session-browser.js` —— 读取层（参考 tokentelemetry）
从本地 agent 会话文件读「项目 / 上下文 / Trace」。
- **支持源**：
  - `~/.claude/projects/**`（claude-code）—— `listClaudeActivity` / `getClaudeTrace`
  - `~/.codex/sessions/**`（codex）—— `loadCodexThreadNames` + session_meta 解析
  - `~/.cursor/projects/**`（cursor）—— `buildCursorProjectMap` / `getCursorTrace`
  - OpenCode（sqlite）
- **解析能力**：项目名解析（编码 slug 反解、`readSessionCwd` 提 cwd、GitHub slug）、`buildTraceStats`（步数/用量/错误计数/时间跨度）、`extractContext`（剥 XML 包装取可读上下文）。
- **入口**：`listAllSessions`（跨 agent 聚合）/ `getTrace(agentId, sessionId)`（取单会话 trace）。

### 6.2 `session-import.js` —— 导入层
扫本地会话文件 → 去重 → 算 token/cost → 写 `local-stats`。
- **格式**：claude / codex / cursor / `copilot-events`（`request_id = copilot:<sess>:<model>` 跨扫描去重）/ OpenCode sqlite。
- `unchanged` / `markDone` 增量扫描（按文件 mtime+size）。
- `billing_type` 映射 + `entrypoint → data_source` 映射（最长前缀优先）。
- 直连用量自动刷新：有新增即通知前端。

### 6.3 `session-manager.js` —— 聚合 / 动作层
- **聚合** `getSessions`：`listAllSessions` + `session_meta` 叠加层（favorite / tags / note / archived）left-join，默认过滤 archived。
- **导出** `exportSession`：trace → 会话包 JSON（`tokenbank.session-pack`）/ Markdown transcript / 复制到剪贴板，落盘 `~/.tokenbank/session-packs/`。
- **跨 agent 续聊（handoff）** `continueSession`：
  1. `buildSessionDigest` 把 trace 压成摘要素材（同时保留**最早 user 消息=原始目标** 与 **最近进展**，避免只看结尾丢意图）。
  2. `summarizeViaGateway` 经本地网关 `11430` 调模型（`HANDOFF_MODELS` 多模型 failover）生成结构化交接 brief：任务 / 已完成 / 当前卡点 / 下一步计划 / 绝对不要再踩的坑 / 关键文件与决策。
  3. `composeHandoffDoc` 组装 → 写 `~/.tokenbank/handoffs/*.md`。
  4. 启动目标 agent 的桌面 app（`open -a` / Cursor 打开项目）+ 剪贴板提示粘贴。
- **知识提炼** `synthesizeKnowledge`：
  - `buildKnowledgeCorpus` 扫跨会话的 user 指令行，用 `learn-mine.js` 的 `isSignal`/`looksLikeNoise` 过滤噪声，按项目标注、强信号优先、限长。
  - 经本地模型（`KNOWLEDGE_MODELS`）合成可**长期作上下文**的知识：开发规则 / 人格 / 最佳实践 / 避坑 / 概念黑话，分**全局级 vs 项目级** → 产出 `AGENTS.md`。
  - 模型不可用时 `_fallbackMd` 兜底输出原始候选。

---

## 7. 遥测 / 账单 / 成本

- `local-stats.js`（sqlite）：每次请求记 route / model / token / latency / status / `cost_usd` / `billing_type` / `request_id`（强制非空）。
- `pricing.js`：60+ 模型的 USD 成本估算器。
- `billing-config.js` + `cloud-billing-sync.js`：订阅按天摊销 + PAYG 列表价估算；云端 user center 统一同步（cloud-first）。
- **Dashboard 多维**：app/agent 占比、provider 层级混合、模型排行（按 calls / tokens / cost）、小时趋势、PAYG + 订阅估算。

---

## 8. P2P 网络（`server/` + `agent/`，可选自托管）

- **server（Python）**：`worker_pool` / `dispatch`（+ `dispatch_image`）/ `settler`（积分结算，约每 5 分钟）/ `provider_router` / `scene_router` / `device_router` / `user_router` / `admin_router` / `claude_oauth` / `virtual_worker`。
- **积分模型**：
  - 贡献 `credits = output_tokens/1000 × contribute_rate × 质量系数(0.5–1.5)`（按在线时长/延迟/成功率）。
  - 消费 `cost = (prompt+completion)/1000 × consume_rate`；设计上 contribute_rate > consume_rate。
  - 其它来源：每日签到 / 转盘 / 邀请。
- **agent（Python worker）**：WebSocket **出站**连接（无需入站端口），注册只发 worker key + 模型列表，**上游 API key 不出本机**。
- **网关压缩**：`compressor.js` + `compression-report.js` 无损压缩节省转发 token。

---

## 9. 关键文件 / 目录

| 路径 | 用途 |
|---|---|
| `local-config.json` / `~/.tokenbank/` | 主配置（provider / 路由 / 应用），`config-loader.js` 加载 |
| `~/.tokenbank/session-packs/` | 导出的会话包（JSON / MD） |
| `~/.tokenbank/handoffs/` | 跨 agent 交接文档 |
| `~/.claude/projects/`、`~/.codex/sessions/`、`~/.cursor/projects/` | 被 session-browser 读取的 agent 会话源 |
| `local-stats` sqlite | 用量/成本统计 |
| `AGENTS.md` | 知识提炼产物 |

---

## 10. 前端页面（`client/src/pages/`）

| 页面 | 作用 |
|---|---|
| Dashboard / TokenDashboard | 多维统计：app 占比 / 层级混合 / 模型排行 / 趋势 / 成本估算 |
| Gateway | 应用纳管、供给链配置、场景路由、网关状态日志、**Session Manager tab** |
| Providers | free/P2P/paid 分层；OAuth / API Key / PAYG；模型白名单同步自 Profile |
| Profile | P2P 积分 · 订阅（APP+API）· PAYG · 多设备盘点 |
| Network | 全球节点地图、在线贡献者、可用模型 |
| Contribute | 节点状态、结算历史、质量系数趋势 |
| Config / Debug | 后端地址 / P2P key / 调试 |

---

## 11. 演进脉络（从 git 历史提炼）

1. **基础网关** —— provider + 路由 + OpenAI/Anthropic 协议转发。
2. **路由改造** —— 条件规则引擎（模态/token/关键词/分类器）+ 降级链配色。
3. **应用纳管** —— 双轴状态机、entrypoint 拆分用量、直连应用去重纳管、shim 接管 CLI。
4. **遥测/账单** —— `pricing.js` + `cost_usd` + `billing_type` + 多维 dashboard + 云端 user center 同步。
5. **供给源体系** —— APP/API 订阅拆分、PAYG 模型白名单、provider catalog YAML 化、OAuth 订阅登录。
6. **UI** —— Raycast 风格 zinc 调色、SVG 导航、排版统一（14px / PingFang SC）。
7. **部署** —— Docker（better-sqlite3 预编译）、nginx HTTPS、macOS 签名公证。
8. **（近期主线）Session 子系统** —— 聚合 / 导出 / 跨 agent handoff / 知识提炼 → AGENTS.md，外加网关无损压缩。

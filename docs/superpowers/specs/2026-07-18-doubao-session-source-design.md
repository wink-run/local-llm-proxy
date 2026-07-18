# 豆包纳管：会话分析 + 画像的只读订阅源

日期：2026-07-18
状态：设计已确认，待写实现计划

## 背景

TokenBank 现有的会话源（Claude Code / Codex / Cursor / Kimi / Trae Work）本质都是**用量表**：从本地文件抽 token 用量（input/output）供统计与账单。豆包是消费级 AI 产品，**不暴露 token 用量**，其价值在于**会话内容**——喂给画像挖掘器 `skill-demand-miner.js` 推断「用户是谁、在追求什么」。

调研已验证（本仓库另有记忆 `project-doubao-integration-findings`）：豆包桌面版会话只存云端，本地 IndexedDB 仅留在途消息状态机，无正文。唯一可行路径是**解本地登录 Cookie + 调 web 私有 API**：

- Cookie 在 `~/Library/Application Support/Doubao/Default/Cookies`，v10 加密（macOS Chromium：钥匙串 `Doubao Safe Storage` 取密码 → `PBKDF2-SHA1(pw,'saltysalt',1003,16)` → AES-128-CBC，去 PKCS7 填充后跳过 32 字节 SHA256 域前缀）。
- REST 列表接口**仅靠 Cookie 鉴权，无需 X-Bogus/msToken 签名**（签名只作用于 websocket 流式）。已实测通：
  - `POST /alice/conversation/list`（body `{index,batch_size,conversation_types:[]}`）→ `code:0`，返回会话清单，每会话带 `conversation_id`、`name`、`bot_id`、`message_index`（累计最大索引）、`update_time`。
  - `POST /alice/message/index_list`（body `{conversation_id,message_index_list:[...],is_reverse:false}`）→ `code:0`，返回消息数组，每条含 `index`、`user_type`(1=用户/2=豆包)、`content_type`(1=纯文本/9999=块)、`content`。
  - 网关 query 参数：`aid=497858&device_platform=web&language=zh&samantha_web=1&version_code=20800`；Origin/Referer 为 `https://www.doubao.com`。

## 目标与非目标

**目标**：把豆包接入为一个**只读会话源实体**，后台定时同步会话到本地，喂给画像挖掘。

**非目标（刻意不做）**：
- 不代理豆包、不注入模型（无 `gateway_proxy`）。
- 不进用量/账单统计（无 `session_usage_import`，豆包无 token 数据）。
- 不投射智能体、不派发 MCP、不派发 Skill（不进游乐场、不可 spawn）。
- 不走火山 Ark api-key 路径（只用官方订阅账号的登录态）。

## 能力边界

豆包是**一个独立 app**（不并入任何现有 app、不塞进用量扫描表）。声明为独立的 `<id>-stats` 型会话源 handler，与 `cursor-stats`/`trae-work-stats`/`copilot-stats` 同一范式。

派生后的实体 `capabilities`：
| 能力 | 值 |
|---|---|
| `session_trace` | ✅ true |
| `gateway_proxy` | ❌ false |
| `session_usage_import` | ❌ false |
| `resource_project`（投射 Skill/Agent） | ❌ false |
| MCP | ❌ 无 |

**关键：capability 关键字用 `session_trace` 而非 `session_import`。** 依 `server/app_handlers.py:112-120` 的映射：
- `session_import` ∈ caps → `session_trace=true` **且** `session_usage_import=true`（会连带打开用量导入）；
- `session_trace` ∈ caps → `session_trace=true`，`session_usage_import=false`（**豆包要的 trace-only**）。

所以 `capabilities: [session_trace]` 精确产出「只 trace、无用量、无投射、无网关」。`billing_type: subscription`。在 `app_catalog.py` 合法：`validate_entity` 只要求 `gateway_proxy` 或 `session_import`（=trace 或 usage）其一，trace-only 满足；`session_usage_import=false` 使其不进用量/账单口径。

## 数据链路

```
豆包桌面版 (已登录)
  └ ~/Library/Application Support/Doubao/Default/Cookies  (v10 加密)
        │  ① doubao-cookies.js: security 取钥匙串密钥 → Node crypto AES-128-CBC 解密
        ▼
  ② doubao-session-sync.js: 解 Cookie → 调 web API
        /alice/conversation/list   (会话清单 + 每会话 message_index)
        /alice/message/index_list  (按增量索引批量拉消息, 纯 Cookie 无签名)
        增量: sync-state.json 记每会话 last_index, 只拉新段
        │  落盘 (含 AI 回复, 单条 >300 字截断)
        ▼
  ~/.tokenbank/doubao-sessions/sessions.jsonl  (+ sync-state.json)
        │  ③ session-trace/doubao-trace.js: 读 JSONL → {steps:[{kind,text,ts}], project, title}
        ▼
  ④ registry.js 注册 profile 'doubao-trace'
        ▼
  skill-demand-miner.resolveTraceEntities()  自动纳入 (caps.session_trace=true)
        → 取 kind:user 话语 → 画像
```

## 组件设计

### ① `client/electron/doubao-cookies.js`
- `doubaoCookiesPath()` → `~/Library/Application Support/Doubao/Default/Cookies`（存在性即「豆包已安装」信号）。
- `decryptDoubaoCookies()`：拷贝 Cookies sqlite（避免锁）→ 读 `host_key like '%doubao.com'` 的 `encrypted_value` → 用 `security find-generic-password -w -s "Doubao Safe Storage"` 取密钥 → Node `crypto` 实现 `PBKDF2-SHA1(pw,'saltysalt',1003,16)` + `createDecipheriv('aes-128-cbc', key, ' '*16)`，去 PKCS7 填充、跳过 32 字节前缀。过滤含非 latin-1 字符的值（拼 Cookie 头会崩）。返回 `{name: value}` map，或在无文件/取密钥失败时返回 `null`（区分「未安装」与「取密钥被拒」两种状态）。
- 依赖：Node 内建 `crypto`、`sqlite3`（仓库现有依赖需确认；若无则用已有的 sqlite 读取工具）、`child_process.execFileSync('security', ...)`。**不依赖 Python、不依赖 pycryptodome。**

### ② `client/electron/doubao-session-sync.js`
- 常量：`EXPORT_DIR = ~/.tokenbank/doubao-sessions`、`EXPORT_FILE = sessions.jsonl`、`STATE_FILE = sync-state.json`、`TEXT_CLIP = 300`、网关 query 常量。
- `syncDoubaoSessions({force})`：
  1. `decryptDoubaoCookies()`；null → 记状态（未安装/取密钥失败）并 return `{synced:0, reason}`。
  2. 拉 `/alice/conversation/list`（分页直到 `has_more=false` 或无新增），得会话清单。
  3. 读 `sync-state.json`（`{ [conversation_id]: lastIndex }`）。
  4. 每会话：若 `message_index > lastIndex`，对 `(lastIndex, message_index]` 分批（≤20）调 `/alice/message/index_list` 拉新消息；`content_type=1` 取 `JSON.parse(content).text`，块类型取首个 text block 的 `text`；`role = user_type===1?'user':'assistant'`；`text` 截断 300 字。
  5. 追加写 `sessions.jsonl`（每行 `{conversation_id,title,index,ts,role,text}`），更新 `sync-state.json`。
  6. API 返回鉴权失败码 → 标记「需重新登录豆包」状态，停止本轮。
- 节流：内部记 `lastRunAt`，非 `force` 时最小间隔（如 10 分钟）；`force` 绕过（供手动刷新 IPC）。
- 请求实现：Node `https`/`fetch`，超时 20s，gzip 解压，统一错误捕获（网络错误不抛、记状态）。

### ③ `client/electron/session-trace/doubao-trace.js`
- 导出 `profile = 'doubao-trace'`、`agentId = 'doubao'`。
- `listSessions()` / `readTrace(sessionId)`：读 `sessions.jsonl`，按 `conversation_id` 分组，`steps` 为 `[{kind:'user'|'assistant', text, ts}]`（按 index 排序），`project` 用会话 `title`，复用 `./shared` 的 `extractContext`/`fileTimeSpan` 等。对齐现有适配器接口（参照 `trae-work-trace.js`）。

### ④ 接线
- `session-trace/registry.js`：`require('./doubao-trace')`，加进 `PROFILE_ADAPTERS` 和 `AGENT_ID_TO_PROFILE`。
- `session-telemetry-sync.js`：在 `syncTraeSessions()` 旁调 `syncDoubaoSessions()`（同一 pass，含 `force` 透传）。
- **独立 app handler**（**两份镜像同步**：`client/electron/config/app-handlers.yaml` + `server/static/defaults/app-handlers.yaml`）：新增 `doubao-stats` handler，仿 `cursor-stats`：
  ```yaml
  doubao-stats:
    label: 豆包
    label_zh: 豆包
    default_icon: "🫘"        # 实现时定 emoji
    default_name: 豆包
    capabilities: [session_trace]      # 只 trace，不含 session_import（=不导用量）、无 resource_project
    session:
      standalone: true
      route_bindable: false
      activity_agent_id: doubao
      trace_agent_id: doubao
      trace:
        profile: doubao-trace
      # 注意：不声明 source_id（无用量扫描）
  ```
  `billing_type: subscription` 由 handler-ops 或实体默认给。

### 检测（app 是否「已安装」）
其它 standalone 会话源用 `session.source_id` → session-scans 的 `root` 存在性做检测；豆包无用量扫描，故检测根来源需在实现计划中定：以 `~/Library/Application Support/Doubao/Default/Cookies` 存在性作为「豆包已安装并登录」信号。落地方式二选一（计划阶段定）：(a) 给 `doubao-stats` 加一个**仅用于检测的** session-scans 条目（`root` 指向豆包目录，无 usage `fields`，配 `capabilities: [session_trace]` 不产用量）；(b) 在 handler 里加轻量 `detect`（路径存在性），不经 scan。倾向 (a)——与既有 standalone app 检测口径一致。

## 增量与失败处理

- **增量**：`sync-state.json` 存每会话 last_index，只拉 `(last_index, current]`。首次同步全量（可对超大会话如「豆包」主会话 1709 条设单次上限，分轮补齐）。
- **未安装/未登录**：无 Cookies 文件 → 静默 no-op + 状态记录，不刷错误日志。
- **取密钥被拒**：`security` 非零退出 → 记状态，本轮跳过。
- **Cookie 失效**：API 返回鉴权失败码 → 标记「需重新登录豆包」，停止本轮，下轮重试。

## 隐私

- 只落盘用户本人账号会话；含 AI 回复但 300 字截断，长敏感解读（如医疗）被裁。
- 豆包内容只喂画像，不进任何用量/金额统计。
- 无任何对外发送；全部为对 `www.doubao.com` 已登录会话的只读拉取。

## 测试

- `doubao-cookies`：固定密钥+密文向量单测解密逻辑（不碰真钥匙串，`security` 调用可注入/mock）。
- `doubao-session-sync`：mock `conversation/list` + `index_list` 响应 → 断言落盘行内容、`sync-state` 推进、300 字截断、分批边界、无 Cookie 时 no-op、鉴权失败时标记状态。
- `doubao-trace`：JSONL 夹具 → 断言 steps 的 user/assistant 划分与排序。
- miner 集成：带 `caps.session_trace` 的豆包实体被 `resolveTraceEntities` 纳入、非 trace 能力不触发。

## 参照

- 范式源自 Trae Work「export→trace」：`trae-session-sync.js`（写 export）+ `session-trace/trae-work-trace.js`（读 export）+ `session-telemetry-sync.js`（调度）。豆包差异点：采集端从「读本地日志」换为「解 Cookie 调云端 REST」。
- 遵循 `feedback_no_worktrees`：直接改 main 侧文件；client/electron/config 与 server/static/defaults 两份镜像需同步。

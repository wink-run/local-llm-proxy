# 会话管理（Session Manager）— Phase 1 设计

日期：2026-06-20
状态：已确认，待实现计划

## 背景

每个智能体（Claude Code、Codex、Cursor、Grok…）把自己的会话以 JSONL 存在各自目录里
（`~/.claude/projects/`、`~/.codex/sessions/` 等）。`client/electron/session-browser.js`
通过 per-agent 的 `HANDLERS` 分别读取，`getTrace(agentId, sessionId)` 提供单会话 Trace。
当前 Gateway 页只能在某个 App 详情里看到它自己的会话——会话**按智能体割裂**，无法统一查看、
检索或复用。

## 目标

在 Gateway 页新增「会话管理」tab，把散落在各智能体的会话**聚合到一处**统一管理，并提供
第一个复用原语：导出为可移植会话包。

## 分期（依赖顺序）

- **Phase 1（本 spec）**：跨 agent 聚合会话列表 + 搜索/过滤 + 统一 Trace + 管理（收藏/标签/
  备注/归档）+ 导出会话包（JSON + Markdown）。
- Phase 2（不在本期）：导入会话包到本地库、提炼可复用提示词/模板、把上下文「喂给另一个
  agent」作为新会话首条 prompt（跨智能体续聊的现实形态）。
- Phase 3（不在本期）：借助已有云同步 / P2P / devices，把会话分享给其他设备或他人。

### 明确不做
- 不删除 agent 原始 JSONL 文件（管理仅叠加层，零数据丢失风险）。
- 跨智能体「原生断点续传」不可行（各 agent 会话格式与 resume 机制不同），不做。
- Phase 1 不改动 Python server，纯本地 / Electron。

## 放置与组件树

- 在 `client/src/pages/Gateway.jsx` 顶部 tab 栏（`Gateway.jsx:2793`，现为 `应用列表` /
  `场景路由`，由 `mainTab` 控制）新增第三项 `t('gateway.tab.sessions')`；`mainTab === 2`
  时渲染 `<SessionManager />`，与 `AppManager`、场景路由并列。tab 栏右侧 endpoint 保留。
- 整页面板形态（满宽），列表直接可滚动展示全部会话，无「查看全部 / 折叠」。

组件（全部在 client 侧，新增）：
- `SessionManager` — 面板容器：拉数据、搜索/过滤 state、聚合统计条（会话数 / 智能体数 / 收藏数）。
- `SessionRow` — 单行展示 + 行内动作（★收藏 / 标签 / 导出 / trace）。
- `SessionMetaPopover` — 行内编辑标签 + 备注。
- `ExportMenu` — 选 JSON 包 / 复制 Markdown / 导出 Markdown 文件。
- **复用** 既有 `SessionTraceModal`（已支持 `agent_id + session_id`，行点 trace 直接打开）。

### 面板布局
- 顶部操作栏：搜索框（匹配项目名 + 首条提问/上下文）｜agent 过滤 chips（全部 / Claude Code /
  Codex / Cursor / …）｜收藏开关｜归档显隐开关｜右侧聚合统计。
- 列表行（栅格对齐）：agent 徽章 ｜ 项目名 + 上下文摘要（含收藏★与标签）｜ calls ｜ tokens ｜
  最后时间 ｜ 行内动作（标签 / 导出 / trace ▸）。

## 数据层（Electron 聚合 + 叠加层）

不改 agent 文件。新增聚合层：

- `client/electron/session-browser.js` 新增 `listAllSessions(opts)`：遍历所有 `HANDLERS`，
  调用各自 `.list()`，给每行打上 `agent_id`，归一化字段，合并 DB 用量统计
  （`mergeActivityWithStats`），按 `lastTs` 排序。处理 Claude Desktop 与 claude-code 共用
  jsonl 的去重（沿用现有别名逻辑）。

- **叠加层**：在已有 `local-stats.db`（better-sqlite3，`client/electron/local-stats.js`）
  新建表：
  ```sql
  CREATE TABLE IF NOT EXISTS session_meta (
    agent_id   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    favorite   INTEGER DEFAULT 0,
    tags       TEXT DEFAULT '',     -- 逗号分隔或 JSON 数组
    note       TEXT DEFAULT '',
    archived   INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (agent_id, session_id)
  );
  ```
  `listAllSessions` 左连接此表带出 favorite/tags/note/archived；归档行默认从列表过滤
  （可由「显示归档」开关放出）。

- 新文件 `client/electron/session-manager.js`：承载叠加层读写 + 导出逻辑，避免继续膨胀
  已 1176 行的 `session-browser.js`（后者专注「读会话」）。

- 新 IPC，preload 暴露 `window.electronAPI.sessions.*`：
  - `listAll(opts)` → `sessions:listAll`
  - `setMeta({agent_id, session_id, favorite?, tags?, note?, archived?})` → `sessions:setMeta`
  - `export({agent_id, session_id, format})` → `sessions:export`

## 导出会话包（JSON + Markdown）

`export()` 复用 `getTrace(agentId, sessionId)` 拿 steps，序列化：

- **JSON 包**（规范格式，为 Phase 2 导入预留）：
  ```json
  {
    "version": 1,
    "kind": "tokenbank.session-pack",
    "exported_at": "<ISO8601>",
    "source": { "agent_id": "...", "project": "...", "project_path": "..." },
    "stats": { "steps": 0, "tools": 0, "tokens": { "input": 0, "output": 0, "cached": 0 } },
    "messages": [
      { "role": "user|assistant|tool", "ts": "<ISO8601>", "text": "...",
        "tool": "<name?>", "input": <any?> }
    ]
  }
  ```
- **Markdown**：人可读 transcript（`## USER` / `## AI` / 工具调用块），支持「一键复制到
  剪贴板」与「导出 .md 文件」。
- 落盘走 Electron 保存对话框，默认目录 `~/.tokenbank/session-packs/`。

## 桌面端限定

会话文件在本地，卡片仅在 Electron 桌面版生效（与现有 `sessionTrace` 一致）。Web / 云端构建
下 tab 显示「桌面版可用」空态。

## 错误处理

- agent 未安装 / 目录缺失 → handler 返回 `[]`，静默跳过。
- 坏 JSONL 行 → 现有解析器已容错跳过。
- 导出失败 / 元数据写库失败 → 非致命 toast 提示。
- `getTrace` 不可用时禁用该行导出并提示。

## 测试

- `listAllSessions`：对 mock handlers 的合并 / 排序 / 归一化、叠加层 left-join、归档过滤。
- 包序列化器：从 fixture trace 生成 JSON（校验 schema）与 Markdown（校验渲染）。
- Phase 1 不涉及 Python server。

## i18n

新增 key（`client/src/locales/pages-zh.js` / `pages-en.js`）：
- `gateway.tab.sessions`（如 `💬 会话管理` / `💬 Sessions`）
- 面板内：搜索占位、过滤 chips、收藏/归档开关、行动作、导出菜单、空态等。

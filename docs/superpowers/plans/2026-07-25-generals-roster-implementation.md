# 武将库出战 · 实现方案

> **For agentic workers:** 按 Task 顺序落地；勾选 `- [ ]`。大段 UI 可分子 PR，但 **P0 技术闭环不可拆丢**。

**Goal:** 让 Cursor / Claude Code / Codex 经现有 `tokenbank-resources` 点将（同会话披甲）；启用必投射+口令；Tray 显性化队伍与军需；场景路由保持正交并在体验上编队；为出租/命中记账留接口。

**Architecture:**  
不新建 list MCP。增强 `tb_list_resources` / `tb_get_resource(assistant)` + `TB_CLIENT_ID` 门控；UI「纳管→启用包」；Tray 增加队伍口令区；场景路由引擎不动，仅展示编队。

**Tech Stack:** Electron CJS main、React 资源/推荐页、tray-popover HTML、node:test。

**Specs:**  
- 主叙事 `docs/superpowers/specs/2026-07-25-tokenbank-generals-product-design.md`  
- 点将技术 `.../2026-07-25-general-roster-mcp-design.md`  
- 反囤积 `.../2026-07-25-anti-notes-trap-design.md`  
- 审查 `.../2026-07-25-product-audit-generals-logic.md`

## Global Constraints

- 测试：`cd client && node --test electron/__tests__/<file>.test.js`；相关改完跑 `resources-mcp` / `resource-assistant` / 新建用例。
- **禁止**新增 `tb_list_generals`；复用 `tb_list_resources`。
- **禁止**改 `request-router` / `scene_router` 选模语义；军需只展示与绑定读取。
- 点将默认 **不**走 `tb_dispatch_agent`；dispatch 文案标明编排专用。
- `clientId` 空 → 不过滤（与 prompt 保底一致）。
- 注释中文；最小改动，不顺手重构无关模块。

---

## Phase 0 — 能打（P0）

### Task 1: assistant 按 client 投射可见性（对齐 prompt）

**Files:**
- Modify: `client/electron/resource-manager.js`
- Test: `client/electron/__tests__/assistant-client-visibility.test.js`（新建）

**Interfaces:**
- `listAssistantsForClient(clientId)` → 轻量行 `{ id, name, display_name, description }`
- `resolveAssistantForClient(ref, clientId)` → `{ found, id?, name?, resource?, config?, text? }`  
  - `text` = `resolveAssistantContext(config, resourceManager)` 全文  
  - 未投射 → `{ found: false }`
- `hasAssistantProjections(clientId)` → boolean  
- 投射判定对齐 prompt：存在 `resource_projections` 且 `agent_id=clientId`（不强制 `projection_type`）

- [ ] Step 1: 写失败测试（仿 `prompt-client-visibility.test.js`）
- [ ] Step 2: 实现三方法；复用 `resource-assistant.parseAssistantConfig` + `resolveAssistantContext`
- [ ] Step 3: 测试通过并提交

---

### Task 2: 增强 `tokenbank-resources` MCP 点将行为

**Files:**
- Modify: `client/electron/resources-mcp.js`
- Modify: `client/electron/__tests__/resources-mcp.test.js`
- Modify: `client/electron/tb-capabilities.js`
- Modify: `client/electron/agent-dispatch-mcp.js`（工具 description 加「仅编排」）

**行为变更:**

| 工具 | 变更 |
|---|---|
| `tb_list_resources` | `type=assistant`（及 `all` 中的 assistant）走 `listAssistantsForClient(TB_CLIENT_ID)`；description 写明智能体=可点武将 |
| `tb_get_resource` | `type=assistant`：校验投射后返回 **出战全文**（可文首一行 `dispatch_id: assistant:…`）；**删除**「请优先 tb_dispatch_agent」hint；改为「同会话按正文执行；编排才 dispatch」 |
| `tb_capabilities` / `formatCapabilitiesOverview` | 工作流：`list(type=assistant)` → `get` → 自打；dispatch 置后 |
| skill/prompt 分支 | 保持；prompt 仍 hint 去 `tb_get_prompt` |

可选：`args.mode = 'summary'|'activate'`，默认 `activate`（若需兼容旧摘要测试）。

- [ ] Step 1: 改测试——assistant get 断言含 soul 正文、不再要求 JSON+dispatch hint 为主
- [ ] Step 2: 实现 list/get 门控与全文
- [ ] Step 3: 更新 capabilities / dispatch 文案
- [ ] Step 4: `node --test electron/__tests__/resources-mcp.test.js` 等通过并提交

---

### Task 3: 命中记账（点将最小闭环）

**Files:**
- Modify: `client/electron/resource-manager.js`（或 local-stats 侧表字段）
- Modify: `client/electron/resources-mcp.js`（get 成功时 bump）
- Modify: `client/electron/prompt-mcp.js`（get_prompt 成功时 bump，顺手对齐）
- Test: 新建或扩展单测

**字段（资源行或旁表）:**
- `use_count` INTEGER
- `last_used_at` TEXT/INTEGER  

- [ ] Step 1: 迁移/列存在则跳过
- [ ] Step 2: `recordResourceHit(resourceId)` 
- [ ] Step 3: assistant/prompt 成功取回后调用
- [ ] Step 4: 测试 + 提交

> Tray Task 6 依赖本计数；无迁移条件可用 JSON metadata 临时方案，但需单测锁形状。

---

### Task 4: UI 启用包（纳管 → 启用到主公 + 口令）

**Files:**
- Modify: `client/src/locales/pages-zh.js` / `pages-en.js`
- Modify: `client/src/components/PersonalizedRecommend.jsx`
- Modify: `client/src/pages/Resources.jsx`（及卡片操作区）
- Modify: `client/src/components/ResourceAssetCard.jsx`（若 CTA 集中于此）

**产品规则:**
- 主 CTA 文案：「启用到 {Agent}」/「Enable to {Agent}」，废止推荐主路径「纳管」终态
- 一次成功 = 入库（若未入库）∧ 至少投射 1 个默认可写客户端 ∧ 展示可复制口令  
- 口令模板（zh）：`用「{display_name}」智能体{任务提示}`  
- 0 投射不得显示「已启用/已纳管」完成态

- [ ] Step 1: i18n 键替换（title/subtitle/reco.install/adopt）
- [ ] Step 2: adopt/install 流程串默认投射 + 口令弹层/toast
- [ ] Step 3: 已纳管列表标注投射状态；未投射提供「完成启用」
- [ ] Step 4: 手测推荐卡 + 提交（UI 无单测则走 lint）

---

### Task 5: 场景路由编队展示（引擎不动）

**Files:**
- Modify: 启用成功 UI（Task 4 弹层）
- Modify: `client/electron/tray-popover.js`（读每 app 当前 route 展示名，已有 `routeLabel` 则强化可读名）
- Optional: Resources 卡片脚注「当前主公军需：…」

- [ ] Step 1: 启用成功卡增加一行军需（按目标 client 查 bound scene route 显示名）
- [ ] Step 2: 确认不写入 scene_routes、不改 failover
- [ ] Step 3: 提交

---

### Task 6: Tray 显性化队伍 + 军需

**Files:**
- Modify: `client/electron/tray-popover.js`（`buildState` + labels）
- Modify: `client/electron/tray-popover.html`（队伍区块 UI + 复制）
- Modify: `client/electron/tray-popover-preload.js`（若需新 action：`copyInvoke`）
- Test: 扩展 `tray-app-today-tokens.test.js` 或新建 `tray-generals-state.test.js`（测 buildState 纯函数部分；若未导出则抽 `buildGeneralsTraySlice`）

**State 新增:**
```js
{
  generalsTodayCount: number,
  quickInvokes: Array<{ id, displayName, clientId, invokeText, routeLabel? }>, // ≤3
  subtitle: // 含「点将 N」
}
```

**UI:**
- 「队伍」区：今日点将数 + 口令卡（点击复制 `invokeText`）
- 空态按钮：打开主面板推荐/资源（`showWindow` + navigate）
- Deck「贡献」label → 「出租算力」（i18n）
- 应用行：确保 `routeLabel` 为场景名而非裸 id

- [ ] Step 1: buildState 组装 quickInvokes（按 last_used / 投射优先）
- [ ] Step 2: HTML 区块 + copy
- [ ] Step 3: 贡献文案
- [ ] Step 4: 测试/手测托盘 + 提交

---

## Phase 1 — 不囤（P1）

### Task 7: Hit-or-Exit 与列表分层

**Files:** `Resources.jsx`、清理模块（扩展自 `resource-skill-cleanup.js` 或并行）、i18n

- [ ] 分层：在用 / 未打穿（已投射 0 命中）/ 沉睡  
- [ ] 48h：启用后无命中 → 托盘或应用内轻推口令  
- [ ] 7 日：建议取消默认投射  
- [ ] 30 日：休眠公函 CTA（重启用 / 冷藏；出租入口可先链到「稍后」）  
- [ ] 清理范围纳入 assistant（不只 skill）

### Task 8: 息票 / 出手反馈

**Files:** 主窗口轻量 toast 组件或 Trace 旁路；可选会话结束钩子

- [ ] MCP 命中后主进程事件 → 渲染层 toast（将名 · client · 次数）  
- [ ] 不挡操作；可关  

### Task 9: 场景货架主故事

**Files:** `Resources.jsx` Tab 默认、`PersonalizedRecommend.jsx`

- [ ] 默认落地「为你推荐/按事」而非「已纳管」体积墙  
- [ ] 类型筛选降级  

---

## Phase 2 — 能租（P2）

### Task 10: 武将/兵器上架出租

**Files:** server 社区目录 API（若已有 admin 下发则加用户贡献端点）、客户端上传 UI、积分结算钩子

- [ ] 用户标记闲置 assistant/skill/prompt 上架  
- [ ] 被他人启用/点将后计贡献（规则对齐算力积分或独立系数）  
- [ ] 盘点/Tray：「昨夜算力 + 武将被点」  

### Task 11:（可选）`tb_suggest_general`

**Files:** `resources-mcp.js`

- [ ] 入参 task_description；返回候选 assistant 轻量列表  
- [ ] capabilities 增加一步；引导措辞 A/B  

### Task 12: 出战预设 L2（将 × 军需指针）

- [ ] 本地存 `{ clientId, generalId, sceneRouteId }`  
- [ ] 启用时可选写入；Tray 口令卡带军需名  

---

## 验收清单（P0 合并前）

- [ ] Claude Code / Cursor / Codex：投射某智能体后，会话内 `tb_list_resources(type=assistant)` 可见，未投射不可见  
- [ ] `tb_get_resource(assistant)` 返回可执行的 soul+兵器全文，模型同会话能按之工作  
- [ ] capabilities / 工具描述不诱导直连会话优先 dispatch  
- [ ] 推荐「启用到 Agent」后必有投射 + 可复制口令  
- [ ] Tray 可见今日点将数与至少一张口令卡（有数据时）  
- [ ] 场景路由 failover 行为与改前一致（回归：选模/测速）  
- [ ] `cd client && node --test electron/__tests__/resources-mcp.test.js electron/__tests__/assistant-client-visibility.test.js`

---

## 非目标（本方案不做）

- 新建 generals MCP server 或 `tb_list_generals`  
- 网关注入/改写客户端 tools  
- 把 scene_routes 改成选将器  
- Tray 内浏览完整资源库 / 编辑 soul  
- P0 做完社区上将交易市场  

---

## 建议 PR 切片

| PR | 含 Task | 说明 |
|---|---|---|
| PR-A | 1–2 | MCP 点将闭环（可先合） |
| PR-B | 3–4 | 记账 + 启用包 UI |
| PR-C | 5–6 | 编队展示 + Tray |
| PR-D+ | 7–12 | P1/P2 |

---

## 一句话

> **P0：门控 list + 全文 get + 启用口令 + Tray 口令卡；路由只展示编队；派发退居编排——先让队伍能打，再谈不囤与能租。**

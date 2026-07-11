# Prompt 资产统一走 MCP —— 设计文档

日期:2026-07-11
分支:cursor/agent-aggregation-system-e85f

## 背景与目标

当前 prompt 资产(TB 库 `resources` 表 `type='prompt'`)有 4 条并行使用通道:

1. 网关 `@tbp:<name>` 宏展开(转发前就地替换最新 user 消息)
2. MCP 工具 `tb_get_prompt`(仅在 TB 编排派发时临时注入 `tokenbank-agent-bridge`)
3. 提示词投射为各 Agent 原生斜杠命令(`/tokenbank:name` / `/name`)
4. Debug 窗口 `@tbp:` 自动补全(UI 辅助,最终走通道 1)

**目标**:简化为**单一路径**——Agent 通过 MCP 工具自主取回 prompt 正文。用户用自然语言描述(例:「使用『代码审查』prompt 对该项目进行审查」),Agent 判断并调用 `tb_get_prompt` 取回正文后按其执行。

**核心解析器不变**:`resourceManager.resolvePrompt(ref, argString)`([resource-manager.js:235](../../../client/electron/resource-manager.js#L235))+ `applyPromptArguments`(`$ARGUMENTS` 填充 / 无占位则追加)保持为所有取用的底座。

## 已定决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | Agent 运行场景 | **双场景**:直连普通会话 + TB 编排派发都要能自动取 prompt |
| 2 | 其余三条通道 | **全删**,只留 MCP |
| 3 | 常驻可见性 | **新建轻量 prompt-only MCP**(`tokenbank-prompts`),常驻同步进 agent 配置;full bridge 仍只在编排时临时注入 |
| 4 | Assistant 内嵌 prompt 依赖 | 投射 assistant 时**内联 prompt 正文**进 soul,自包含 |
| 5 | prompt 对 agent 的可见性 | **按 agent 逐条投射控制**:用户投射哪个 prompt 到哪个 agent,才把该 prompt 经 MCP 暴露给那个 agent。同步范围完全由投射驱动 |

## 核心原则:投射即可见,按 agent 隔离

「投射」动作保留,但语义从「写斜杠命令文件」改为「标记该 prompt 经 MCP 对某 agent 可见」。落地为一句话:

> **用户把某 prompt 投射到某 agent,才会把取-prompt MCP 同步进那个 agent 的配置,且该 MCP 只暴露被投射给它的那些 prompt。**

- 投射记录复用现有 `resource_projections` 表(`resource_id / agent_id / scope / projection_type / status`),prompt 投射写 `projection_type='mcp'`,**不写任何文件**。
- MCP 按调用方(`TB_CLIENT_ID`)过滤可见集,agent 之间互不可见对方未投射的 prompt。
- 「同步 MCP 到某 client」完全由「该 client 有无已投射 prompt」自动驱动,无独立 sync 开关。

## 架构

### 组件 1:新增 prompt-only MCP —— `tokenbank-prompts`

- 新文件 `client/electron/prompt-mcp.js`,复用 [agent-dispatch-mcp.js](../../../client/electron/agent-dispatch-mcp.js) 的 stdio JSON-RPC 骨架。
- `serverInfo.name = 'tokenbank-prompts'`,`protocolVersion 2024-11-05`,`capabilities.tools`。
- 暴露两个工具:

  **`tb_get_prompt(name, args?)`**
  - `name`:提示词名称或 `#<id>`
  - `args`:可选参数,填充模板 `$ARGUMENTS`
  - 实现:`resolvePromptForClient(name, args, TB_CLIENT_ID)`——仅当该 prompt 已投射给调用方 client 才返回正文;未投射或未命中 → `isError=true`(防猜名越权取用)。`TB_CLIENT_ID` 为空时回退为不过滤(保底)。
  - 描述(触发自动调用的关键)——拟:
    > "当用户提到『使用 / 按 某某 prompt(提示词)做某事』时,先用本工具按名取回该提示词正文,再据其内容执行任务。不要凭记忆臆造提示词内容。名字不确定时先用 tb_list_prompts 查询。"

  **`tb_list_prompts()`**
  - 无参,只列出**投射给调用方 client** 的 prompt 的 `name / display_name / description`,供 Agent 在名字不确定时先发现。
  - 实现:`listPromptsForClient(TB_CLIENT_ID)`。

- 调用方过滤:`prompt-mcp.js` 读环境变量 `TB_CLIENT_ID`;两个工具都按该 client 的投射集过滤。
- 运行时:Electron-as-node,与 bridge 一致——`command = process.execPath`,`env.ELECTRON_RUN_AS_NODE = '1'`,`args = [<prompt-mcp.js 绝对路径>]`,`env.TB_CLIENT_ID = <该 client id>`。因查询只读 SQLite 库、不需要父任务上下文,可在普通会话独立工作,并复用 Electron 内置的 better-sqlite3。
- 与 `require.main === module` 一致的入口保护,便于单测 `require`。

**新增 resource-manager 查询**(供 MCP 与单测复用):
- `listPromptsForClient(clientId)` → 有 `resource_projections` 行(`type='prompt'`、`agent_id=clientId`、`projection_type='mcp'`)的 prompt 轻量列表。
- `resolvePromptForClient(ref, args, clientId)` → `resolvePrompt` + 投射校验;`clientId` 为空则不校验。

### 组件 2:同步(由投射驱动,按 client 隔离)

- 在 [mcp-manager.js `init()`](../../../client/electron/mcp-manager.js#L42) seed 一个内置的 `tokenbank-prompts` server(与 bridge 并列)。区别:**它参与常驻同步,且同步范围由投射驱动**。
- 改 [mcp-client-sync.js](../../../client/electron/mcp-client-sync.js):
  - 现状对 `__DYNAMIC_ELECTRON__` 与内置 bridge 返回 `null`([:43-48](../../../client/electron/mcp-client-sync.js#L43));bridge 仍旧跳过。
  - 同步某 client C 时:**当且仅当 C 有 ≥1 条已投射 prompt**(`resource_projections` 中 `agent_id=C`、`type='prompt'`)才为其**物化** `tokenbank-prompts` 条目:`{ command: process.execPath, args: [<prompt-mcp.js 绝对路径>], env: { ELECTRON_RUN_AS_NODE: '1', TB_CLIENT_ID: C } }`(逻辑参照 [`_buildRuntimeServerConfig`](../../../client/electron/mcp-manager.js#L709) 的 bridge 分支)。
  - C 的最后一条 prompt 投射被取消 → 从 C 的配置移除该 MCP 条目(带 `tokenbank-mcp` 标记,复用现有清理逻辑)。
- 触发时机:投射 / 取消投射 prompt 后触发对应 client 的 re-sync;App 每次启动亦 re-sync(用当时 `process.execPath` 修正路径,应对 app 升级 / 移动)。
- 同步目标客户端集沿用现有 [CLIENT_TARGETS](../../../client/electron/mcp-agent-targets.js)(Cursor / Claude Code / Codex / Hermes / OpenClaw / WorkBuddy / Gemini CLI / OpenCode);写入带 `tokenbank-mcp` 标记,复用现有 JSON/TOML/YAML 写入。
- **注意**:不再有独立的「sync 客户端开关」决定 prompt MCP 是否下发——完全由投射集决定。

### 组件 3:编排路径(过滤保持一致)

- full bridge `tokenbank-agent-bridge` 的 `tb_get_prompt` 保留,派发时仍随 profile 临时注入。
- bridge 的 `tb_get_prompt` 改走同一 `resolvePromptForClient`;派发时在 bridge env 设 `TB_CLIENT_ID = mainAgentId`,按主 Agent 的投射集过滤。`TB_CLIENT_ID` 为空则不过滤(保底)。
- 编排系统提示无需改动。

## 删除项

### A. 网关 `@tbp:` 宏展开
- 删 [local-gateway.js:3347-3353](../../../client/electron/local-gateway.js#L3347) 调用点。
- 删 `setPromptResolver` / `_promptResolver` / `TBP_MACRO_RE` / `_expandTbpText` / `_expandTbpContent` / `expandPromptMacros`([:3526-3586](../../../client/electron/local-gateway.js#L3526))及 module.exports 中对应导出。
- 删 [main.js:4520-4522](../../../client/electron/main.js#L4520) 的 resolver 注入。
- 删测试 `gateway-prompt-macros.test.js`。

### B. Debug `@tbp:` 补全
- 删 [Debug.jsx:40](../../../client/src/pages/Debug.jsx#L40) import;删菜单状态 / 检测 / 渲染(:585-620, :1459-1473, :2242)与占位文案里的 @tbp 提示(:2280-2281)。
- 删 `client/src/lib/tbp-autocomplete.mjs` 及其单测。
- 删 Debug 里为补全而做的 `listResources({type:'prompt'})` 加载(:616-620)。

### C. 提示词 → 斜杠命令投射(改为「MCP 可见性投射」,只删落盘部分)
投射动作**保留并复用**(见「核心原则」),仅移除写文件那套:
- 删 [resource-projector.js:277-380](../../../client/electron/resource-projector.js#L277) 的 `projectPromptToAgent` / `unprojectPromptFromAgent` / `buildPromptFileContent` / `isTbManagedPromptFile` / `TB_PROMPT_MARKER`(不再落盘)。
- 删 [resource-agent-targets.js](../../../client/electron/resource-agent-targets.js) 的 `AGENT_PROMPT_TARGETS` 路径约定;`listPromptProjectableAgentIds` 改为**返回 MCP 同步客户端集**([CLIENT_TARGETS](../../../client/electron/mcp-agent-targets.js) 的 8 个 id);`getPromptTarget` 删除。
- `projectResource`/`unprojectResource`([resource-projector.js:350-369](../../../client/electron/resource-projector.js#L350))的 prompt 分支:改为**只记 `resource_projections` 行(`projection_type='mcp'`)、不写文件**,并触发目标 client 的 re-sync。
- `verifyProjection`([:233-241](../../../client/electron/resource-projector.js#L233))prompt 分支简化为「DB 行存在即健康」。
- `projectToAgents`([resource-manager.js:487](../../../client/electron/resource-manager.js#L487)):`type==='prompt'` 的可投射目标集改用新的 `listPromptProjectableAgentIds`;投射成功后触发对应 client re-sync。prompt resync([:618](../../../client/electron/resource-manager.js#L618))简化(无文件可修,仅确认 DB 行)。
- Resources 页 prompt 卡片:保留「投射到 Agent」多选(目标 = 8 个 MCP 客户端),文案说明「投射后该 agent 会话可经 MCP `tb_get_prompt` 按名取用」。

## Assistant 依赖内联(决策 4)

- 改 assistant 投射路径:不再把 `config.prompts`([resource-manager.js:396](../../../client/electron/resource-manager.js#L396))里的 prompt 单独投成命令。
- 在组装 assistant 系统提示(soul)时,用 `resolvePrompt` 取回每条被引用 prompt 的正文,**内联拼接**进 soul。
- `_collectAssistantDependencies` 由「收集去单独投射」改为「收集去内联」;缺失的 prompt 仍返回 `missing` 警告。
- 结果:assistant 投射后自包含,不依赖常驻 prompt MCP。

## 数据流

**前置**:用户在 Resources 页把「代码审查」prompt 投射给目标 agent(如 Claude Code)→ 记 `resource_projections` 行 + 触发该 client re-sync,把 `tokenbank-prompts`(带 `TB_CLIENT_ID=claude-code`)写入 `~/.claude`。

**直连场景**
```
用户:「使用『代码审查』prompt 审查该项目」
  → Agent(Claude Code,常驻会话已有 tokenbank-prompts MCP,TB_CLIENT_ID=claude-code)
  → 调 tb_get_prompt("代码审查")
  → prompt-mcp.js → resolvePromptForClient("代码审查", "", "claude-code")
       → 校验已投射给 claude-code → 返回正文
  → Agent 按正文执行审查
```
未投射给该 agent 的 prompt:`tb_list_prompts` 不列出、`tb_get_prompt` 返回未找到。

**编排场景**
```
用户 → TB 聚合入口主 Agent(派发时注入 full bridge,TB_CLIENT_ID=mainAgentId)
  → 调 tb_get_prompt("代码审查")(bridge 内,按 mainAgentId 投射集过滤)→ 取回正文
  → tb_dispatch_agent 派发子任务执行
```

## 测试

- 新增:
  - `prompt-mcp.js` 的 `tb_get_prompt`(投射命中 / 未投射拒绝 / 名字未命中)、`tb_list_prompts`(仅列投射给该 client 的)。
  - `resolvePromptForClient` / `listPromptsForClient`:按 `TB_CLIENT_ID` 过滤;`clientId` 为空时不过滤(保底)。
  - `mcp-client-sync`:client 有 ≥1 投射 → 物化 `tokenbank-prompts` 条目(含 `TB_CLIENT_ID`、`process.execPath`、绝对脚本路径、`ELECTRON_RUN_AS_NODE`);最后一条投射取消 → 移除条目。
  - prompt 投射只写 `resource_projections`(`type='mcp'`)、不落盘文件。
  - assistant 投射内联 prompt 正文;缺失 prompt 返回 missing。
- 保留:`resolve-prompt.test.js`、`tb-get-prompt-tool.test.js`。
- 删除:`gateway-prompt-macros.test.js`、`prompt-projection-resync.test.js`、`tbp-autocomplete` 相关测试。

## 不动项

- `resolvePrompt` + `applyPromptArguments`(核心解析器)。
- full bridge 的 `tb_get_prompt`(编排派发用)。
- 现有 MCP 客户端同步的 JSON/TOML/YAML 写入基础设施。

## 影响面小结

- 单一心智模型:prompt 由用户投射给指定 agent 后,该 agent 会话经 MCP 自动可见并按需取回;按 agent 隔离,可控。
- 去掉网络层宏、UI 补全两套并行机制;斜杠命令投射「降级」为 MCP 可见性投射(复用 `resource_projections`,不再落盘)。
- Assistant 更自包含(内联),不引入对常驻 MCP 的隐式依赖。
- 主要风险:物化命令写死 `process.execPath`,靠启动 re-sync 兜底。

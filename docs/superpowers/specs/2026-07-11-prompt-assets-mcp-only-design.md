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

## 架构

### 组件 1:新增 prompt-only MCP —— `tokenbank-prompts`

- 新文件 `client/electron/prompt-mcp.js`,复用 [agent-dispatch-mcp.js](../../../client/electron/agent-dispatch-mcp.js) 的 stdio JSON-RPC 骨架。
- `serverInfo.name = 'tokenbank-prompts'`,`protocolVersion 2024-11-05`,`capabilities.tools`。
- 暴露两个工具:

  **`tb_get_prompt(name, args?)`**
  - `name`:提示词名称或 `#<id>`
  - `args`:可选参数,填充模板 `$ARGUMENTS`
  - 实现:直接调用 `require('./resource-manager').resolvePrompt(name, args)`;命中返回 `text`,未命中 `isError=true`。
  - 描述(触发自动调用的关键)——拟:
    > "当用户提到『使用 / 按 某某 prompt(提示词)做某事』时,先用本工具按名取回该提示词正文,再据其内容执行任务。不要凭记忆臆造提示词内容。名字不确定时先用 tb_list_prompts 查询。"

  **`tb_list_prompts()`**
  - 无参,列出库里所有 prompt 的 `name / display_name / description`,供 Agent 在名字不确定时先发现。
  - 实现:`resourceManager.listResources({ type: 'prompt' })`(或等价查询),仅返回轻量字段。

- 运行时:Electron-as-node,与 bridge 一致——`command = process.execPath`,`env.ELECTRON_RUN_AS_NODE = '1'`,`args = [<prompt-mcp.js 绝对路径>]`。因 `resolvePrompt` 只读 SQLite 库、不需要父任务上下文,可在普通会话独立工作,并复用 Electron 内置的 better-sqlite3。
- 与 `require.main === module` 一致的入口保护,便于单测 `require`。

### 组件 2:常驻同步

- 在 [mcp-manager.js `init()`](../../../client/electron/mcp-manager.js#L42) seed 一个内置、always-installed 的 `tokenbank-prompts` server(与 bridge 并列)。区别:**它参与常驻同步**。
- 改 [mcp-client-sync.js `serverToEntry`](../../../client/electron/mcp-client-sync.js#L41):
  - 现状对 `__DYNAMIC_ELECTRON__` 与内置 bridge 返回 `null`([:43-48](../../../client/electron/mcp-client-sync.js#L43))。
  - 新增特例:`server.id === 'tokenbank-prompts'` 时**物化**为具体命令 `{ command: process.execPath, args: [<prompt-mcp.js 绝对路径>], env: { ELECTRON_RUN_AS_NODE: '1' } }`(逻辑参照 [`_buildRuntimeServerConfig`](../../../client/electron/mcp-manager.js#L709) 的 bridge 分支)。
  - bridge 仍旧跳过。
- 同步目标沿用现有 [CLIENT_TARGETS](../../../client/electron/mcp-agent-targets.js)(Cursor / Claude Code / Codex / Hermes / OpenClaw / WorkBuddy / Gemini CLI / OpenCode),按用户已启用的 sync 客户端下发,写入带 `tokenbank-mcp` 标记,复用现有 JSON/TOML/YAML 写入。
- App 每次启动 re-sync 用当时 `process.execPath` 修正路径(应对 app 升级 / 移动)。

### 组件 3:编排路径(基本不动)

- full bridge `tokenbank-agent-bridge` 的 `tb_get_prompt` 保留,派发时仍随 profile 临时注入。
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

### C. 提示词 → 斜杠命令投射
- 删 [resource-projector.js:277-380](../../../client/electron/resource-projector.js#L277) 的 `projectPromptToAgent` / `unprojectPromptFromAgent` / `buildPromptFileContent` / `isTbManagedPromptFile` / `TB_PROMPT_MARKER`,及 `verifyProjection`([:233-241](../../../client/electron/resource-projector.js#L233))、`projectResource`/`unprojectResource` 中的 prompt 分支。
- 删 [resource-agent-targets.js](../../../client/electron/resource-agent-targets.js) 的 `AGENT_PROMPT_TARGETS` / `listPromptProjectableAgentIds` / `getPromptTarget` 及导出。
- `projectToAgents`([resource-manager.js:487](../../../client/electron/resource-manager.js#L487)):`type==='prompt'` 改为返回「prompt 通过 MCP 使用,无需投射」而非报错(供 UI 平滑处理);删 prompt resync([:618](../../../client/electron/resource-manager.js#L618))。
- Resources 页 prompt 卡片:去掉「投射到 Agent」入口,改提示「通过 MCP `tb_get_prompt` 按名调用」。
- 删测试 `prompt-projection-resync.test.js`。

## Assistant 依赖内联(决策 4)

- 改 assistant 投射路径:不再把 `config.prompts`([resource-manager.js:396](../../../client/electron/resource-manager.js#L396))里的 prompt 单独投成命令。
- 在组装 assistant 系统提示(soul)时,用 `resolvePrompt` 取回每条被引用 prompt 的正文,**内联拼接**进 soul。
- `_collectAssistantDependencies` 由「收集去单独投射」改为「收集去内联」;缺失的 prompt 仍返回 `missing` 警告。
- 结果:assistant 投射后自包含,不依赖常驻 prompt MCP。

## 数据流

**直连场景**
```
用户:「使用『代码审查』prompt 审查该项目」
  → Agent(Claude Code / Codex,常驻会话已有 tokenbank-prompts MCP)
  → 调 tb_get_prompt("代码审查")
  → prompt-mcp.js → resolvePrompt → 返回正文
  → Agent 按正文执行审查
```

**编排场景**
```
用户 → TB 聚合入口主 Agent(派发时注入 full bridge)
  → 调 tb_get_prompt("代码审查")(bridge 内)→ 取回正文
  → tb_dispatch_agent 派发子任务执行
```

## 测试

- 新增:
  - `prompt-mcp.js` 的 `tb_get_prompt`(命中 / 未命中)、`tb_list_prompts`(仿 `tb-get-prompt-tool.test.js`)。
  - `mcp-client-sync` 把 `tokenbank-prompts` 物化成具体命令(`process.execPath` + 绝对脚本路径 + `ELECTRON_RUN_AS_NODE`)。
  - assistant 投射内联 prompt 正文;缺失 prompt 返回 missing。
- 保留:`resolve-prompt.test.js`、`tb-get-prompt-tool.test.js`。
- 删除:`gateway-prompt-macros.test.js`、`prompt-projection-resync.test.js`、`tbp-autocomplete` 相关测试。

## 不动项

- `resolvePrompt` + `applyPromptArguments`(核心解析器)。
- full bridge 的 `tb_get_prompt`(编排派发用)。
- 现有 MCP 客户端同步的 JSON/TOML/YAML 写入基础设施。

## 影响面小结

- 单一心智模型:prompt 只需在 TB 库存在,任何常驻会话的 Agent 自动可见并按需取回。
- 去掉网络层宏、UI 补全、斜杠命令投射三套并行机制及其维护成本。
- Assistant 更自包含(内联),不引入对常驻 MCP 的隐式依赖。
- 主要风险:物化命令写死 `process.execPath`,靠启动 re-sync 兜底。

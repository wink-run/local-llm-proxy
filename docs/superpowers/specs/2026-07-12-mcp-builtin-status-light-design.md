# 内置 MCP 服务状态灯 —— 设计文档

日期:2026-07-12
分支:cursor/agent-aggregation-system-e85f

## 背景与目标

MCP 供给源页(`client/src/components/McpProvidersTab.jsx`)目前只显示 DB 里的「已启用/已停用」——用户手动开关,不反映服务真实可用性。stdio MCP 非常驻,agent 用时才拉起进程,所以「连接情况」需要主动探测:拉起进程走一次 `initialize` 握手,成功即绿灯。

**范围(已确认)**:只探测两个内置服务 `tokenbank-agent-bridge` 与 `tokenbank-prompts`;外部(npx 类)服务不显示灯,维持现状。

**时机(已确认)**:进入 MCP tab 时对已启用的内置服务自动探测一次(结果本次会话缓存);卡片上另给单个「重测」按钮。

## 组件

### 1. 探测模块 `client/electron/mcp-probe.js`(新建)

单一职责:拉起内置 MCP 子进程,完成一次 JSON-RPC 握手,回报结果。

```
probeBuiltinServer(serverId) → Promise<{
  ok: boolean,
  serverId: string,
  serverInfo?: { name, version },   // ok=true 时
  elapsedMs?: number,               // ok=true 时
  error?: string,                   // ok=false 时
}>
```

- 仅接受 `tokenbank-agent-bridge` / `tokenbank-prompts` 两个 id,其他 id 立即返回 `{ ok: false, error: '仅支持内置服务探测' }`。
- 物化命令与运行时一致:`command = process.execPath`,`args = [<对应脚本绝对路径>]`(bridge → `agent-dispatch-mcp.js`,prompts → `prompt-mcp.js`),`env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }`。
- 流程:spawn → stdin 写一行 `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` → 按行读 stdout,拿到 `id===1` 的响应即校验 `result.serverInfo.name === serverId` → 成功 `{ ok: true, serverInfo, elapsedMs }`。
- 失败路径:spawn error / 5 秒超时 / 响应解析失败 / serverInfo.name 不匹配 → `{ ok: false, error: <一句话原因> }`。
- 无论成败,结束时 `kill()` 子进程并清理定时器;并发调用同一 serverId 时直接复用进行中的 Promise(防重复拉起)。
- 支持依赖注入脚本路径映射(便于单测用假脚本)。

### 2. IPC 通道

- `ipc-handlers-mcp.js` 新增 `mcp:probeServer`,参数 `{ serverId }`,直调 `mcp-probe.probeBuiltinServer`,异常包成 `{ ok: false, error }`。
- `preload.js` 的 `mcp` 命名空间加 `probeServer: (params) => ipcRenderer.invoke('mcp:probeServer', params)`。

### 3. UI(McpProvidersTab.jsx 服务卡片)

- 组件 state:`probeResults: { [serverId]: { state: 'probing'|'ok'|'fail', error?, elapsedMs? } }`。
- 内置服务判定:`serverId === 'tokenbank-agent-bridge' || serverId === 'tokenbank-prompts'`(卡片数据已有 builtin 字段亦可,以 id 白名单为准,与探测模块一致)。
- 进入 MCP tab(服务列表首次加载完成)时:对**已启用**(`status === 'active'`)的内置服务并发调用 `probeServer`,写入 state;本次组件生命周期内不重复自动探测。
- 灯态渲染(服务名旁的小圆点):
  - 🟢 绿:`ok`,`title` 提示「连接正常 · {elapsedMs}ms」
  - 🔴 红:`fail`,`title` 提示错误原因
  - 转圈(动画点/spinner):`probing`
  - 灰点:已停用(不探测),`title`「已停用」
- 灯旁「重测」小按钮(仅内置服务、非 probing 时可点):点击重新探测该服务。
- 服务被停用→启用切换后,自动对其探测一次。
- 外部服务卡片不渲染灯与重测按钮。

### 4. i18n

新增 key(`pages-zh.js` / `pages-en.js`):
- `mcp.probeOk`: '连接正常' / 'Connected'
- `mcp.probeFail`: '连接异常' / 'Connection failed'
- `mcp.probing`: '检测中' / 'Probing'
- `mcp.reprobe`: '重测' / 'Re-test'
- `mcp.probeDisabled`: '已停用' / 'Disabled'

(若 McpProvidersTab 现文案为中文硬编码,则跟随现状硬编码中文,不强行引 i18n——以该文件现有约定为准。)

## 数据流

```
进入 MCP tab → listServers 完成
  → 对 active 的内置 server 并发 window.electronAPI.mcp.probeServer({serverId})
  → 主进程 mcp-probe spawn 脚本、initialize 握手(≤5s)
  → { ok, serverInfo, elapsedMs } / { ok:false, error }
  → 组件 state → 绿/红灯 + tooltip
点「重测」→ 同一通道单服务重跑
```

## 错误处理

- 探测失败不影响服务卡片其他功能(启停/同步等照常)。
- IPC 层异常兜底为红灯 + error 文案。
- 子进程必杀(成功/失败/超时统一 finally kill),不留僵尸。

## 测试

- `mcp-probe` 单测(node:test):
  1. 对真实 `prompt-mcp.js` 探测 → ok=true,serverInfo.name='tokenbank-prompts'(用 `process.execPath` 需 Electron;单测环境下用 `node` + 注入脚本路径即可,脚本本身是纯 node 兼容)。
  2. 不存在的脚本路径 → ok=false。
  3. 慢脚本(sleep 超过超时)→ ok=false 且 error 含超时;进程被杀。
  4. 非白名单 serverId → ok=false。
- UI 不做自动化测试(项目现状无渲染层测试),以 `npx vite build` 通过 + 手动冒烟为准。

## 不做(YAGNI)

- 不做后台定时轮询。
- 不探测外部 npx 服务。
- 不把探测结果落库(纯会话内状态)。

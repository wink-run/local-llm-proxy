# Prompt 资产统一走 MCP —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** prompt 资产只保留一条使用路径——agent 经 MCP 工具按投射集自主取回;删除网关 @tbp 宏、Debug 补全、斜杠命令落盘三条旧通道。

**Architecture:** 新增 stdio MCP `tokenbank-prompts`(仅 `tb_get_prompt`/`tb_list_prompts`,按 `TB_CLIENT_ID` 过滤);prompt「投射」降级为 `resource_projections` 里一行 `projection_type='mcp'` 标记(不落盘);mcp-client-sync 只给「有 ≥1 条已投射 prompt」的客户端物化该 MCP 条目。编排 bridge 的 `tb_get_prompt` 走同一过滤。

**Tech Stack:** Node/Electron(main process CJS)、better-sqlite3(经 local-stats)、node:test、React(渲染层)。

**Spec:** `docs/superpowers/specs/2026-07-11-prompt-assets-mcp-only-design.md`

## Global Constraints

- 测试运行方式:`cd client && node --test electron/__tests__/<file>.test.js`;全量 `cd client && npm test`。
- 所有 electron 主进程代码为 CJS(`'use strict'` + `require`),注释风格中文、与邻近代码一致。
- **Spec 偏差(已确认合理)**:prompt 可投射目标 = `listSyncEnabledClientIds()`(cursor / claude-code / codex / workbuddy 4 个可写客户端),而非 spec 所写 8 个——sync:false 的客户端无法写入 MCP 配置,投了也无效。
- 兼容:`resolvePromptForClient` 的投射校验不过滤 `projection_type`(旧 `command` 行同样授予可见性);`clientId` 为空 → 不过滤(保底)。
- `resolvePrompt` / `applyPromptArguments` 本体不动。
- 提交信息末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: resource-manager 按 client 过滤的 prompt 查询

**Files:**
- Modify: `client/electron/resource-manager.js`(在 `resolvePrompt` 方法后、`installFromCatalog` 前插入三个方法;约 :254 之后)
- Test: `client/electron/__tests__/prompt-client-visibility.test.js`(新建)

**Interfaces:**
- Consumes: 现有 `resolvePrompt(ref, argString)`、`this._getDb()`。
- Produces(后续 Task 2/4/5 依赖,签名精确如下):
  - `listPromptsForClient(clientId)` → `Array<{ id, name, display_name, description }>`;`clientId` 为空 → 返回全部 prompt 轻量行。
  - `resolvePromptForClient(ref, argString, clientId)` → 同 `resolvePrompt` 返回形状 `{ found, id?, name?, text? }`;`clientId` 非空且该 prompt 无该 client 的投射行 → `{ found: false }`。
  - `hasPromptProjections(clientId)` → `boolean`,该 client 是否有 ≥1 条 prompt 投射。

- [ ] **Step 1: 写失败测试**

新建 `client/electron/__tests__/prompt-client-visibility.test.js`:

```js
'use strict';
// 按 client 过滤的 prompt 可见性:投射给谁,谁才能列出/取回
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');

/** 用假 DB 桩掉 _getDb:按 SQL 关键字分发到预置结果 */
function withFakeDb(handlers, fn) {
  const origGetDb = resourceManager._getDb;
  const origInit = resourceManager.init;
  resourceManager.init = () => {};
  resourceManager._getDb = () => ({
    prepare: (sql) => ({
      all: (...args) => handlers.all(sql, args),
      get: (...args) => handlers.get(sql, args),
    }),
  });
  try { return fn(); } finally {
    resourceManager._getDb = origGetDb;
    resourceManager.init = origInit;
  }
}

test('listPromptsForClient: 只列投射给该 client 的 prompt', () => {
  const rows = [{ id: 'res-p-a', name: 'a', display_name: 'A', description: '' }];
  const r = withFakeDb({
    all: (sql, args) => {
      assert.ok(sql.includes('resource_projections'), 'clientId 非空应联表投射');
      assert.deepEqual(args, ['claude-code']);
      return rows;
    },
    get: () => null,
  }, () => resourceManager.listPromptsForClient('claude-code'));
  assert.deepEqual(r, rows);
});

test('listPromptsForClient: clientId 为空 → 返回全部 prompt(不联投射表)', () => {
  const r = withFakeDb({
    all: (sql) => {
      assert.ok(!sql.includes('resource_projections'), '空 clientId 不应联投射表');
      return [{ id: 'res-p-a', name: 'a', display_name: 'A', description: '' }];
    },
    get: () => null,
  }, () => resourceManager.listPromptsForClient(''));
  assert.equal(r.length, 1);
});

test('hasPromptProjections: 有行 → true,无行 → false', () => {
  const yes = withFakeDb({ all: () => [], get: () => ({ 1: 1 }) },
    () => resourceManager.hasPromptProjections('codex'));
  assert.equal(yes, true);
  const no = withFakeDb({ all: () => [], get: () => undefined },
    () => resourceManager.hasPromptProjections('codex'));
  assert.equal(no, false);
});

test('resolvePromptForClient: 已投射 → 返回正文;未投射 → found:false', () => {
  const origResolve = resourceManager.resolvePrompt;
  resourceManager.resolvePrompt = (ref, args) => ({ found: true, id: 'res-p-a', name: ref, text: `[${ref}] ${args}` });
  try {
    const hit = withFakeDb({ all: () => [], get: () => ({ 1: 1 }) },
      () => resourceManager.resolvePromptForClient('代码审查', 'auth.js', 'claude-code'));
    assert.equal(hit.found, true);
    assert.equal(hit.text, '[代码审查] auth.js');

    const miss = withFakeDb({ all: () => [], get: () => undefined },
      () => resourceManager.resolvePromptForClient('代码审查', '', 'codex'));
    assert.deepEqual(miss, { found: false });
  } finally { resourceManager.resolvePrompt = origResolve; }
});

test('resolvePromptForClient: clientId 为空 → 不校验投射,直接透传 resolvePrompt', () => {
  const origResolve = resourceManager.resolvePrompt;
  resourceManager.resolvePrompt = () => ({ found: true, id: 'x', name: 'x', text: 'T' });
  try {
    const r = withFakeDb({
      all: () => { throw new Error('不应查库'); },
      get: () => { throw new Error('不应查库'); },
    }, () => resourceManager.resolvePromptForClient('x', '', ''));
    assert.equal(r.text, 'T');
  } finally { resourceManager.resolvePrompt = origResolve; }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd client && node --test electron/__tests__/prompt-client-visibility.test.js`
Expected: FAIL(`listPromptsForClient is not a function` 等)

- [ ] **Step 3: 实现三个方法**

在 `client/electron/resource-manager.js` 的 `resolvePrompt` 方法结束(`}` 之后、`installFromCatalog` 之前)插入:

```js
  /** 投射给该 client 的 prompt 轻量列表;clientId 为空 → 全部 prompt */
  listPromptsForClient(clientId) {
    this.init();
    const db = this._getDb();
    const cid = String(clientId || '').trim();
    if (!cid) {
      return db.prepare(`
        SELECT id, name, display_name, description FROM resources
        WHERE type = 'prompt' ORDER BY updated_at DESC
      `).all();
    }
    return db.prepare(`
      SELECT DISTINCT r.id, r.name, r.display_name, r.description
      FROM resources r
      JOIN resource_projections ps ON ps.resource_id = r.id
      WHERE r.type = 'prompt' AND ps.agent_id = ?
      ORDER BY r.updated_at DESC
    `).all(cid);
  }

  /** 该 client 是否有 ≥1 条 prompt 投射(决定是否给它下发 prompt MCP) */
  hasPromptProjections(clientId) {
    this.init();
    const cid = String(clientId || '').trim();
    if (!cid) return false;
    const row = this._getDb().prepare(`
      SELECT 1 FROM resource_projections ps
      JOIN resources r ON r.id = ps.resource_id
      WHERE ps.agent_id = ? AND r.type = 'prompt' LIMIT 1
    `).get(cid);
    return !!row;
  }

  /** resolvePrompt + 投射校验:仅当该 prompt 投射给 clientId 才返回;clientId 为空不过滤 */
  resolvePromptForClient(ref, argString = '', clientId = '') {
    const r = this.resolvePrompt(ref, argString);
    if (!r.found) return r;
    const cid = String(clientId || '').trim();
    if (!cid) return r;
    const row = this._getDb().prepare(
      'SELECT 1 FROM resource_projections WHERE resource_id = ? AND agent_id = ? LIMIT 1',
    ).get(r.id, cid);
    return row ? r : { found: false };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd client && node --test electron/__tests__/prompt-client-visibility.test.js`
Expected: PASS(5 tests)

- [ ] **Step 5: 提交**

```bash
git add client/electron/resource-manager.js client/electron/__tests__/prompt-client-visibility.test.js
git commit -m "feat(resource): prompt 按 client 投射集过滤的查询三件套"
```

---

### Task 2: 新建 prompt-only MCP `tokenbank-prompts`

**Files:**
- Create: `client/electron/prompt-mcp.js`
- Test: `client/electron/__tests__/prompt-mcp.test.js`(新建)

**Interfaces:**
- Consumes: Task 1 的 `resolvePromptForClient(ref, args, clientId)`、`listPromptsForClient(clientId)`。
- Produces: stdio JSON-RPC MCP,`serverInfo.name='tokenbank-prompts'`;工具 `tb_get_prompt(name, args?)`、`tb_list_prompts()`;模块导出 `{ TOOLS, handleToolCall, handleMessage }`(供单测与 Task 4 引用脚本路径)。

- [ ] **Step 1: 写失败测试**

新建 `client/electron/__tests__/prompt-mcp.test.js`:

```js
'use strict';
// tokenbank-prompts:直连会话取回 prompt 的独立 MCP(按 TB_CLIENT_ID 过滤)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');
const mcp = require('../prompt-mcp');

test('TOOLS 暴露 tb_get_prompt 与 tb_list_prompts', () => {
  const names = mcp.TOOLS.map(t => t.name);
  assert.deepEqual(names.sort(), ['tb_get_prompt', 'tb_list_prompts']);
});

test('tb_get_prompt 命中 → 正文;未投射 → isError', async () => {
  const orig = resourceManager.resolvePromptForClient;
  resourceManager.resolvePromptForClient = (ref, args, cid) =>
    cid === 'claude-code' && ref === '代码审查'
      ? { found: true, name: ref, text: `[${ref}] ${args}` }
      : { found: false };
  process.env.TB_CLIENT_ID = 'claude-code';
  try {
    const hit = await mcp.handleToolCall('tb_get_prompt', { name: '代码审查', args: 'auth.js' });
    assert.equal(hit.isError, false);
    assert.equal(hit.content[0].text, '[代码审查] auth.js');

    process.env.TB_CLIENT_ID = 'codex';
    const miss = await mcp.handleToolCall('tb_get_prompt', { name: '代码审查' });
    assert.equal(miss.isError, true);
  } finally {
    resourceManager.resolvePromptForClient = orig;
    delete process.env.TB_CLIENT_ID;
  }
});

test('tb_list_prompts 只列该 client 的投射集', async () => {
  const orig = resourceManager.listPromptsForClient;
  resourceManager.listPromptsForClient = (cid) =>
    cid === 'cursor' ? [{ id: 'r1', name: 'code-review', display_name: '代码审查', description: '结构化审查' }] : [];
  process.env.TB_CLIENT_ID = 'cursor';
  try {
    const r = await mcp.handleToolCall('tb_list_prompts', {});
    assert.equal(r.isError, false);
    assert.ok(r.content[0].text.includes('code-review'));
    assert.ok(r.content[0].text.includes('代码审查'));
  } finally {
    resourceManager.listPromptsForClient = orig;
    delete process.env.TB_CLIENT_ID;
  }
});

test('initialize 返回 serverInfo.name=tokenbank-prompts', () => {
  const sent = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { sent.push(String(s)); return true; };
  try {
    mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  } finally { process.stdout.write = origWrite; }
  const msg = JSON.parse(sent[0]);
  assert.equal(msg.result.serverInfo.name, 'tokenbank-prompts');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd client && node --test electron/__tests__/prompt-mcp.test.js`
Expected: FAIL(`Cannot find module '../prompt-mcp'`)

- [ ] **Step 3: 实现 prompt-mcp.js**

新建 `client/electron/prompt-mcp.js`(骨架照搬 agent-dispatch-mcp.js):

```js
#!/usr/bin/env node
// Token Bank 提示词 MCP(stdio)
// 常驻同步进各 Agent 客户端;按 TB_CLIENT_ID 只暴露投射给该 client 的 prompt
'use strict';

const readline = require('readline');
const resourceManager = require('./resource-manager');

function clientId() {
  return process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '';
}

const TOOLS = [
  {
    name: 'tb_get_prompt',
    description: '当用户提到「使用/按 某某 prompt(提示词)做某事」时,先用本工具按名取回该提示词正文,再据其内容执行任务。不要凭记忆臆造提示词内容。名字不确定时先用 tb_list_prompts 查询。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '提示词名称,或 #<id>' },
        args: { type: 'string', description: '可选参数,填充模板里的 $ARGUMENTS' },
      },
      required: ['name'],
    },
  },
  {
    name: 'tb_list_prompts',
    description: '列出当前 Agent 可用的 Token Bank 提示词(名称/显示名/描述),供按名取回前查询。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError,
  };
}

async function handleToolCall(name, args = {}) {
  if (name === 'tb_get_prompt') {
    const ref = String(args.name || '').trim();
    const argStr = String(args.args || '').trim();
    if (!ref) return textResult('缺少 name', true);
    const r = resourceManager.resolvePromptForClient(ref, argStr, clientId());
    if (!r.found) return textResult(`未找到提示词: ${ref}(仅投射给当前 Agent 的提示词可用,可先 tb_list_prompts)`, true);
    return textResult(r.text);
  }

  if (name === 'tb_list_prompts') {
    const rows = resourceManager.listPromptsForClient(clientId());
    if (!rows.length) return textResult('(当前 Agent 暂无已投射的提示词)');
    const lines = rows.map(p => {
      const disp = p.display_name && p.display_name !== p.name ? `(${p.display_name})` : '';
      return `- ${p.name}${disp}${p.description ? `: ${p.description}` : ''}`;
    });
    return textResult(lines.join('\n'));
  }

  return textResult(`未知工具: ${name}`, true);
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tokenbank-prompts', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    handleToolCall(toolName, toolArgs)
      .then(result => send({ jsonrpc: '2.0', id, result }))
      .catch(err => send({
        jsonrpc: '2.0',
        id,
        result: textResult(err.message, true),
      }));
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// stdio JSON-RPC(每行一条消息)——仅作为独立进程运行时启动,便于单测 require
if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      handleMessage(JSON.parse(t));
    } catch (e) {
      // 忽略非法行
    }
  });
}

module.exports = { TOOLS, handleToolCall, handleMessage };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd client && node --test electron/__tests__/prompt-mcp.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add client/electron/prompt-mcp.js client/electron/__tests__/prompt-mcp.test.js
git commit -m "feat(mcp): 新增 tokenbank-prompts 独立 MCP(tb_get_prompt / tb_list_prompts,按 TB_CLIENT_ID 过滤)"
```

---

### Task 3: prompt 投射语义改为 MCP 标记(不落盘)

**Files:**
- Modify: `client/electron/resource-agent-targets.js`(删 `AGENT_PROMPT_TARGETS`/`getPromptTarget`;改 `listPromptProjectableAgentIds`)
- Modify: `client/electron/resource-projector.js`(prompt 投射/反投射/健康检查改标记式;删文件写入函数)
- Modify: `client/electron/resource-manager.js`(删 `_resyncPromptProjections` 及调用;改投射 hint;assistant 依赖只投 skill)
- Delete: `client/electron/__tests__/prompt-projection-resync.test.js`
- Test: `client/electron/__tests__/prompt-projection-mcp.test.js`(新建)

**Interfaces:**
- Consumes: `mcp-agent-targets.listSyncEnabledClientIds()`。
- Produces(Task 7 依赖):
  - `projectResource(promptResource, agentId, scope)` → `{ agentId, scope, targetPath: null, authorityPath: null, projectionType: 'mcp', status: 'active' }`
  - `unprojectResource(promptResource, ...)` → `{ removed: true }`(无文件操作)
  - `listPromptProjectableAgentIds()` → `['cursor','claude-code','codex','workbuddy']`(即 `listSyncEnabledClientIds()`)
  - `verifyProjection(promptResource, agentId, 'mcp', null)` → `{ healthy: true, reason: 'mcp', repairable: false }`

- [ ] **Step 1: 写失败测试**

新建 `client/electron/__tests__/prompt-projection-mcp.test.js`:

```js
'use strict';
// prompt 投射 = MCP 可见性标记:不落盘、不写命令文件
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { projectResource, unprojectResource, verifyProjection } = require('../resource-projector');
const { listPromptProjectableAgentIds } = require('../resource-agent-targets');

const prompt = { type: 'prompt', name: 'code-review', content: '审查 $ARGUMENTS' };

test('projectResource(prompt) → projectionType=mcp,不写文件', () => {
  const r = projectResource(prompt, 'cursor', 'global', {});
  assert.equal(r.projectionType, 'mcp');
  assert.equal(r.status, 'active');
  assert.equal(r.targetPath, null);
});

test('unprojectResource(prompt) → removed:true,无文件副作用', () => {
  const r = unprojectResource(prompt, 'cursor', 'mcp', null);
  assert.equal(r.removed, true);
});

test('verifyProjection(prompt, mcp) → healthy', () => {
  const r = verifyProjection(prompt, 'cursor', 'mcp', null);
  assert.equal(r.healthy, true);
});

test('prompt 可投射目标 = MCP 可写客户端集', () => {
  const { listSyncEnabledClientIds } = require('../mcp-agent-targets');
  assert.deepEqual(listPromptProjectableAgentIds(), listSyncEnabledClientIds());
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd client && node --test electron/__tests__/prompt-projection-mcp.test.js`
Expected: FAIL(现返回 `command` 类型 / 尝试写盘)

- [ ] **Step 3: 改 resource-agent-targets.js**

删除整个 `AGENT_PROMPT_TARGETS` 常量(:39-58)与 `getPromptTarget` 函数(:72-74),`listPromptProjectableAgentIds` 改为:

```js
/** prompt 可投射目标 = 可写 MCP 配置的客户端(投射即经 MCP 暴露给该 Agent) */
function listPromptProjectableAgentIds() {
  return require('./mcp-agent-targets').listSyncEnabledClientIds();
}
```

module.exports 中移除 `AGENT_PROMPT_TARGETS`、`getPromptTarget`。

- [ ] **Step 4: 改 resource-projector.js**

顶部 import(:7)去掉 `getPromptTarget`:

```js
const { getAgentTarget } = require('./resource-agent-targets');
```

删除 `TB_PROMPT_MARKER`(:280)、`buildPromptFileContent`(:282-292)、`isTbManagedPromptFile`(:295-302),`projectPromptToAgent`(:304-330)与 `unprojectPromptFromAgent`(:332-345)整体替换为:

```js
// ── 提示词 → MCP 可见性标记(不落盘;可见集由 resource_projections 决定)────────

function projectPromptToAgent(resource, agentId, scope = 'global') {
  return {
    agentId,
    scope,
    targetPath: null,
    authorityPath: null,
    projectionType: 'mcp',
    status: 'active',
  };
}

function unprojectPromptFromAgent() {
  return { removed: true };
}
```

`verifyProjection` 的 prompt 分支(:233-241)替换为:

```js
  // 提示词:投射即 DB 标记(经 MCP 暴露),行存在即健康
  if (projectionType === 'mcp' || resource?.type === 'prompt') {
    return { healthy: true, reason: 'mcp', repairable: false };
  }
```

module.exports 移除 `isTbManagedPromptFile`(保留 `projectPromptToAgent`/`unprojectPromptFromAgent` 导出,`projectResource`/`unprojectResource` 分发不变)。

- [ ] **Step 5: 改 resource-manager.js**

1. 删除 `_resyncPromptProjections` 整个方法(:622-644)及 saveResource 里的调用(:350-353),该分支改为:

```js
    } else if (saved?.type === 'prompt') {
      // 权威源=DB:MCP 调用时实时读库,编辑后无需重刷任何文件
    }
```

2. 投射 hint(:522)整行替换:

```js
    let hint = '提示词已投射:目标 Agent 会话可通过 MCP 工具 tb_get_prompt 按名取回(tb_list_prompts 可列出)。';
```

3. assistant 依赖只投 skill(prompt 正文已在运行时由 resolveAssistantContext 内联,无需投射)。`projectToAgents` 内(:501-505):

```js
    if (resource.type === 'assistant') {
      const { resources, missing } = this._collectAssistantDependencies(resource);
      // prompt 依赖在运行时内联进 system 上下文(resolveAssistantContext),仅 Skill 需要落盘投射
      resourcesToProject.push(...resources.filter(r => r.type === 'skill'));
      missingDeps = missing;
    }
```

- [ ] **Step 6: 删旧测试,跑新测试与相邻测试**

```bash
git rm client/electron/__tests__/prompt-projection-resync.test.js
cd client && node --test electron/__tests__/prompt-projection-mcp.test.js electron/__tests__/resolve-prompt.test.js
```
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add -A client/electron
git commit -m "refactor(resource): prompt 投射降级为 MCP 可见性标记,不再落盘斜杠命令文件"
```

---

### Task 4: seed `tokenbank-prompts` + 按投射门控的客户端同步

**Files:**
- Modify: `client/electron/mcp-manager.js`(seed 新 server;`_buildRuntimeServerConfig` 增加 prompts 分支与 `TB_CLIENT_ID`)
- Modify: `client/electron/mcp-client-sync.js`(`serverToEntry` 物化 + `filterServersForClient` 门控 + `syncCodexClient` 传 clientId)
- Test: `client/electron/__tests__/prompt-mcp-sync.test.js`(新建)

**Interfaces:**
- Consumes: Task 1 `hasPromptProjections(clientId)`;Task 2 的脚本路径 `client/electron/prompt-mcp.js`。
- Produces:
  - `mcp-manager` 导出 `BUILTIN_PROMPTS_ID = 'tokenbank-prompts'`。
  - `serverToEntry(serverRow, clientId)`(新增第二参数):对 prompts server 返回 `{ command: process.execPath, args: [<prompt-mcp.js 绝对路径>], env: { ELECTRON_RUN_AS_NODE: '1', TB_CLIENT_ID: clientId } }`。
  - `filterServersForClient(servers, clientId)`:prompts server 仅当 `hasPromptProjections(clientId)` 为 true 才保留。

- [ ] **Step 1: 写失败测试**

新建 `client/electron/__tests__/prompt-mcp-sync.test.js`:

```js
'use strict';
// tokenbank-prompts 的下发规则:有投射才同步,物化为 Electron-as-node + TB_CLIENT_ID
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const resourceManager = require('../resource-manager');
const sync = require('../mcp-client-sync');

const promptsRow = {
  id: 'tokenbank-prompts', name: 'tokenbank-prompts', status: 'active',
  command: '__DYNAMIC_ELECTRON__', args: '[]', env: '{"ELECTRON_RUN_AS_NODE":"1"}', builtin: 1,
};

test('serverToEntry: prompts server 物化为 execPath + 脚本 + TB_CLIENT_ID', () => {
  const entry = sync.serverToEntry(promptsRow, 'claude-code');
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args[0], path.join(__dirname, '..', 'prompt-mcp.js'));
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(entry.env.TB_CLIENT_ID, 'claude-code');
});

test('serverToEntry: bridge 与其他 __DYNAMIC_ELECTRON__ 仍返回 null', () => {
  assert.equal(sync.serverToEntry({ id: 'tokenbank-agent-bridge', status: 'active', command: '__DYNAMIC_ELECTRON__' }, 'codex'), null);
  assert.equal(sync.serverToEntry({ id: 'other', status: 'active', command: '__DYNAMIC_ELECTRON__' }, 'codex'), null);
});

test('filterServersForClient: 无投射的 client 不下发 prompts server', () => {
  const orig = resourceManager.hasPromptProjections;
  resourceManager.hasPromptProjections = (cid) => cid === 'cursor';
  try {
    const withProj = sync.filterServersForClient([promptsRow], 'cursor');
    const withoutProj = sync.filterServersForClient([promptsRow], 'codex');
    assert.equal(withProj.length, 1);
    assert.equal(withoutProj.length, 0);
  } finally { resourceManager.hasPromptProjections = orig; }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd client && node --test electron/__tests__/prompt-mcp-sync.test.js`
Expected: FAIL(`serverToEntry`/`filterServersForClient` 未导出或行为不符)

- [ ] **Step 3: 改 mcp-manager.js**

1. 常量区(:27-30)增加:

```js
const BUILTIN_PROMPTS_ID = 'tokenbank-prompts';
const PROMPTS_SCRIPT = path.join(__dirname, 'prompt-mcp.js');
```

2. `init()` 里 bridge seed 块(:47-67)之后,插入同构的 prompts seed:

```js
    const prompts = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(BUILTIN_PROMPTS_ID);
    if (!prompts) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_PROMPTS_ID,
        BUILTIN_PROMPTS_ID,
        'Token Bank Prompts',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([PROMPTS_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        JSON.stringify({
          description: '内置提示词服务:tb_get_prompt / tb_list_prompts(仅对已投射的 Agent 可见)',
          tools: ['tb_get_prompt', 'tb_list_prompts'],
        }),
        now,
        now,
      );
    }
```

3. `_buildRuntimeServerConfig`(:709)bridge 分支的 env 增加一行 `TB_CLIENT_ID: mainAgentId || '',`(与 `TB_MAIN_AGENT_ID` 并列);并在 bridge 分支后新增 prompts 分支:

```js
    if (serverRow.id === BUILTIN_PROMPTS_ID || serverRow.name === BUILTIN_PROMPTS_ID) {
      return {
        command: process.execPath,
        args: [PROMPTS_SCRIPT],
        env: {
          ...baseEnv,
          ELECTRON_RUN_AS_NODE: '1',
          TB_CLIENT_ID: mainAgentId || '',
        },
      };
    }
```

4. 文件末尾导出:`module.exports.BUILTIN_PROMPTS_ID = BUILTIN_PROMPTS_ID;`

- [ ] **Step 4: 改 mcp-client-sync.js**

1. :9 改为 `const { BUILTIN_BRIDGE_ID, BUILTIN_PROMPTS_ID } = require('./mcp-manager');`,顶部加 `const PROMPTS_SCRIPT = path.join(__dirname, 'prompt-mcp.js');`

2. `serverToEntry(serverRow)` 改签名为 `serverToEntry(serverRow, clientId)`,在 bridge 判断之后、`__DYNAMIC_ELECTRON__` 判断之前插入:

```js
  // 内置提示词 MCP:物化为 Electron-as-node,并注入调用方 client 标识
  if (serverRow.id === BUILTIN_PROMPTS_ID || serverRow.name === BUILTIN_PROMPTS_ID) {
    return {
      command: process.execPath,
      args: [PROMPTS_SCRIPT],
      env: { ELECTRON_RUN_AS_NODE: '1', TB_CLIENT_ID: clientId || '' },
    };
  }
```

3. `syncJsonClient` 内 `serverToEntry(srv)` → `serverToEntry(srv, clientId)`。

4. `syncCodexClient(filePath, servers, prevKeys)` 改签名为 `syncCodexClient(clientId, filePath, servers, prevKeys)`,内部 `serverToEntry(srv)` → `serverToEntry(srv, clientId)`;`syncAll` 里调用处同步改为 `syncCodexClient(clientId, filePath, clientServers, prevKeys)`。

5. `filterServersForClient` 增加门控(在 `if (s.id === BUILTIN_BRIDGE_ID) return false;` 之后):

```js
    if (s.id === BUILTIN_PROMPTS_ID) {
      // 只给「有 ≥1 条已投射 prompt」的 client 下发(懒 require 防循环依赖)
      try { return require('./resource-manager').hasPromptProjections(clientId); }
      catch { return false; }
    }
```

6. 确认 `module.exports` 包含 `serverToEntry` 与 `filterServersForClient`(测试需要;若未导出则补上)。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd client && node --test electron/__tests__/prompt-mcp-sync.test.js`
Expected: PASS(3 tests)

- [ ] **Step 6: 提交**

```bash
git add client/electron/mcp-manager.js client/electron/mcp-client-sync.js client/electron/__tests__/prompt-mcp-sync.test.js
git commit -m "feat(mcp): tokenbank-prompts 按投射门控下发,物化 Electron-as-node + TB_CLIENT_ID"
```

---

### Task 5: bridge 同走 client 过滤 + 目录登记

**Files:**
- Modify: `client/electron/agent-dispatch-mcp.js`(:107-114 `tb_get_prompt` 分支)
- Modify: `client/electron/__tests__/tb-get-prompt-tool.test.js`(桩改为 `resolvePromptForClient`)
- Modify: `client/electron/config/mcp-catalog.yaml`、`server/static/defaults/mcp-catalog.yaml`(bridge 条目后加 prompts 条目)
- Modify: `client/electron/mcp-catalog.js`(fallback 目录追加 prompts 项)

**Interfaces:**
- Consumes: Task 1 `resolvePromptForClient`;bridge 运行时 env(Task 4 已注入 `TB_CLIENT_ID`,历史环境仍有 `TB_MAIN_AGENT_ID`)。
- Produces: bridge 的 `tb_get_prompt` 按主 Agent 投射集过滤;目录(yaml×2 + fallback)出现 `tokenbank-prompts`。

- [ ] **Step 1: 更新测试(先行,红灯)**

`tb-get-prompt-tool.test.js` 两个用例的桩从 `resolvePrompt` 改为 `resolvePromptForClient`,并断言 clientId 透传:

```js
test('tb_get_prompt 命中 → 返回展开正文,isError=false', async () => {
  const orig = resourceManager.resolvePromptForClient;
  process.env.TB_CLIENT_ID = 'claude-code';
  resourceManager.resolvePromptForClient = (ref, args, cid) => {
    assert.equal(cid, 'claude-code');
    return { found: true, name: ref, text: `[${ref}] ${args}` };
  };
  try {
    const r = await bridge.handleToolCall('tb_get_prompt', { name: '代码审查', args: 'auth.js' });
    assert.equal(r.isError, false);
    assert.equal(r.content[0].text, '[代码审查] auth.js');
  } finally {
    resourceManager.resolvePromptForClient = orig;
    delete process.env.TB_CLIENT_ID;
  }
});

test('tb_get_prompt 未命中/未投射 → isError=true', async () => {
  const orig = resourceManager.resolvePromptForClient;
  resourceManager.resolvePromptForClient = () => ({ found: false });
  try {
    const r = await bridge.handleToolCall('tb_get_prompt', { name: '不存在' });
    assert.equal(r.isError, true);
  } finally { resourceManager.resolvePromptForClient = orig; }
});
```

Run: `cd client && node --test electron/__tests__/tb-get-prompt-tool.test.js`
Expected: FAIL(bridge 仍调 `resolvePrompt`,clientId 断言不触发/桩未命中)

- [ ] **Step 2: 改 agent-dispatch-mcp.js**

`tb_get_prompt` 分支(:107-114)改为:

```js
  if (name === 'tb_get_prompt') {
    const ref = String(args.name || args.ref || '').trim();
    const argStr = String(args.args || args.arguments || '').trim();
    if (!ref) return textResult('缺少 name', true);
    const clientId = process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '';
    const r = resourceManager.resolvePromptForClient(ref, argStr, clientId);
    if (!r.found) return textResult(`未找到提示词: ${ref}`, true);
    return textResult(r.text);
  }
```

Run: `cd client && node --test electron/__tests__/tb-get-prompt-tool.test.js`
Expected: PASS

- [ ] **Step 3: 目录登记(yaml×2 + fallback)**

两份 `mcp-catalog.yaml`(`client/electron/config/` 与 `server/static/defaults/`,内容一致)在 `tokenbank-agent-bridge` 条目(结束于 `always_installed: true`)之后插入:

```yaml
- catalog_id: tokenbank-prompts
  id: tokenbank-prompts
  name: tokenbank-prompts
  display_name: Token Bank Prompts
  description: 内置提示词服务:tb_get_prompt / tb_list_prompts(仅对已投射的 Agent 可见)
  type: stdio
  command: __DYNAMIC_ELECTRON__
  args: []
  env:
    ELECTRON_RUN_AS_NODE: '1'
  metadata:
    category: agent
    categoryGroup: tokenbank
    icon: 📝
    tools:
    - tb_get_prompt
    - tb_list_prompts
    tags:
    - 内置
    - 提示词
  config_fields: []
  always_installed: true
```

`mcp-catalog.js` 的 `fallbackCatalog()`(:91-112)数组追加第二项:

```js
  {
    catalogId: 'tokenbank-prompts',
    id: 'tokenbank-prompts',
    name: 'tokenbank-prompts',
    display_name: 'Token Bank Prompts',
    description: '内置提示词服务:tb_get_prompt / tb_list_prompts(仅对已投射的 Agent 可见)',
    type: 'stdio',
    command: '__DYNAMIC_ELECTRON__',
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    metadata: {
      category: 'agent',
      categoryGroup: 'tokenbank',
      icon: '📝',
      tools: ['tb_get_prompt', 'tb_list_prompts'],
      tags: ['内置', '提示词'],
    },
    configFields: [],
    alwaysInstalled: true,
  },
```

验证:`cd client && node -e "const c=require('./electron/mcp-catalog'); c.resetCatalogCache(); console.log(c.getCatalogItem('tokenbank-prompts').metadata.tools)"`
Expected: `[ 'tb_get_prompt', 'tb_list_prompts' ]`

- [ ] **Step 4: 提交**

```bash
git add client/electron/agent-dispatch-mcp.js client/electron/__tests__/tb-get-prompt-tool.test.js \
  client/electron/config/mcp-catalog.yaml server/static/defaults/mcp-catalog.yaml client/electron/mcp-catalog.js
git commit -m "feat(mcp): bridge tb_get_prompt 按主 Agent 投射集过滤;目录登记 tokenbank-prompts"
```

---

### Task 6: 删除网关 @tbp 宏与 Debug 补全

**Files:**
- Modify: `client/electron/local-gateway.js`(删宏展开 stage、函数与导出;行号会漂移,按符号定位)
- Modify: `client/electron/main.js`(删 `setPromptResolver` 注入,约 :4543-4549)
- Modify: `client/src/pages/Debug.jsx`(删全部 tbp 引用)
- Delete: `client/src/lib/tbp-autocomplete.mjs`、`client/electron/__tests__/tbp-autocomplete.test.js`、`client/electron/__tests__/gateway-prompt-macros.test.js`

**Interfaces:**
- Consumes: 无。
- Produces: 网关请求体不再做 @tbp 展开;`local-gateway` 不再导出 `setPromptResolver`/`expandPromptMacros`。

- [ ] **Step 1: 删 local-gateway.js 宏逻辑**

按符号定位(grep `@tbp\|_promptResolver\|expandPromptMacros\|setPromptResolver\|TBP_MACRO_RE`),删除:
1. handler 内的宏展开 stage(注释「── 提示词宏展开 stage…」起的 7 行,含 `if (_promptResolver …) { try { expandPromptMacros… } }`)。
2. `let _promptResolver = null;`、`setPromptResolver`、`TBP_MACRO_RE`、`_expandTbpText`、`_expandTbpContent`、`expandPromptMacros` 全部定义(连同其注释块)。
3. `module.exports` 两处:`setPromptResolver`(与 setStatsRecorder 同行)与 `expandPromptMacros`。

- [ ] **Step 2: 删 main.js 注入**

删除(:4543-4549 附近,grep `setPromptResolver`):

```js
  // 转发前把 @tbp:<name|#id> 宏展开为 TB 库里的提示词正文(懒 require 避免加载顺序问题)
  gateway.setPromptResolver((ref, args) => {
    try { return require('./resource-manager').resolvePrompt(ref, args); }
    catch { return { found: false }; }
  });
```

- [ ] **Step 3: 删 Debug.jsx 的 tbp 全部引用**

按 grep `tbp\|Tbp\|@tbp` 逐处删除:
1. :40 `import { detectTbpQuery, filterPromptSuggestions } from '../lib/tbp-autocomplete.mjs';`
2. :585-588 注释与三个 state(`tbpPrompts`/`tbpMenu`/`tbpIndex`)。
3. :616-620 加载 prompt 列表的 useEffect(整个 `window.electronAPI.resource.listResources({ type: 'prompt' })` effect)。
4. :1459-1480 `tbpSuggestions` 常量、`refreshTbpMenu`、`acceptTbp` 两个函数。
5. :2230-2250 建议菜单 JSX 块(`{tbpMenu.active && tbpSuggestions.length > 0 && (…)}`)。
6. textarea 上的 tbp 调用:`onChange` 里 `refreshTbpMenu(...)` 调用、`onKeyUp`/`onClick` 中的 `refreshTbpMenu` 处理、`onKeyDown` 开头的 `if (tbpMenu.active && tbpSuggestions.length) {…}` 块(保留 Cmd/Ctrl+Enter 发送逻辑)。
7. :2280-2281 占位文案去掉 `@tbp 引用提示词,`(保留 `Cmd/Ctrl+Enter 发送`)。

- [ ] **Step 4: 删文件与旧测试**

```bash
git rm client/src/lib/tbp-autocomplete.mjs \
  client/electron/__tests__/tbp-autocomplete.test.js \
  client/electron/__tests__/gateway-prompt-macros.test.js
```

- [ ] **Step 5: 验证无残留引用 + 全量测试**

```bash
cd client
grep -rn "tbp\|setPromptResolver\|expandPromptMacros" electron/ src/ --include="*.js" --include="*.jsx" --include="*.mjs" | grep -v node_modules
npm test
npx vite build 2>&1 | tail -3
```
Expected: grep 无输出(或仅无关词的误匹配);测试全绿;vite build 成功(Debug.jsx 无悬空引用)。

- [ ] **Step 6: 提交**

```bash
git add -A client
git commit -m "refactor(prompt): 删除网关 @tbp 宏展开与 Debug 补全通道,统一走 MCP"
```

---

### Task 7: 投射触发 re-sync + Resources UI 与 i18n

**Files:**
- Modify: `client/electron/resource-manager.js`(projectToAgents / unproject / deleteResource 触发对应 client re-sync;新增 `listPromptAgentTargets`)
- Modify: `client/electron/ipc-handlers-resource.js`(:92-100 `resource:listAgentTargets` 返回 `promptAgents`)
- Modify: `client/src/pages/Resources.jsx`(prompt 投射菜单用 promptAgents;提示文案)
- Modify: `client/src/locales/pages-zh.js`(:1191)、`client/src/locales/pages-en.js`(:1184)
- Test: `client/electron/__tests__/prompt-project-resync-clients.test.js`(新建)

**Interfaces:**
- Consumes: Task 3 的投射语义;`mcp-manager.syncToClients(options)`(内部即 `mcpClientSync.syncAll(list, options)`,支持 `{ clientIds: [...] }`)。
- Produces:
  - `listPromptAgentTargets()` → `Array<{ id, label }>`(4 个可写客户端)。
  - IPC `resource:listAgentTargets` 响应变为 `{ success, agents, promptAgents }`。
  - prompt 投射/取消/删除后,受影响 client 的 MCP 配置被同步刷新。

- [ ] **Step 1: 写失败测试**

新建 `client/electron/__tests__/prompt-project-resync-clients.test.js`:

```js
'use strict';
// prompt 投射/取消后应触发对应 client 的 MCP 配置 re-sync
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');

test('_resyncPromptClients 调用 mcp-manager.syncToClients 并透传 clientIds', () => {
  const mcpManager = require('../mcp-manager');
  const orig = mcpManager.syncToClients;
  const calls = [];
  mcpManager.syncToClients = (opts) => { calls.push(opts); return { success: true }; };
  try {
    resourceManager._resyncPromptClients(['cursor', 'codex']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { clientIds: ['cursor', 'codex'] });
  } finally { mcpManager.syncToClients = orig; }
});

test('_resyncPromptClients 空列表不触发同步,异常被吞掉', () => {
  const mcpManager = require('../mcp-manager');
  const orig = mcpManager.syncToClients;
  let called = 0;
  mcpManager.syncToClients = () => { called += 1; throw new Error('boom'); };
  try {
    resourceManager._resyncPromptClients([]);
    assert.equal(called, 0);
    assert.doesNotThrow(() => resourceManager._resyncPromptClients(['cursor']));
    assert.equal(called, 1);
  } finally { mcpManager.syncToClients = orig; }
});

test('listPromptAgentTargets 返回可写客户端 {id,label}', () => {
  const { listSyncEnabledClientIds, CLIENT_TARGETS } = require('../mcp-agent-targets');
  const r = resourceManager.listPromptAgentTargets();
  assert.deepEqual(r.map(x => x.id), listSyncEnabledClientIds());
  for (const x of r) assert.equal(x.label, CLIENT_TARGETS[x.id].label);
});
```

Run: `cd client && node --test electron/__tests__/prompt-project-resync-clients.test.js`
Expected: FAIL(方法不存在)

- [ ] **Step 2: 改 resource-manager.js**

1. `listAgentTargets()` 方法后新增:

```js
  /** prompt 投射目标 = 可写 MCP 配置的客户端(供 UI 展示) */
  listPromptAgentTargets() {
    const { CLIENT_TARGETS, listSyncEnabledClientIds } = require('./mcp-agent-targets');
    return listSyncEnabledClientIds().map(id => ({ id, label: CLIENT_TARGETS[id].label }));
  }

  /** prompt 投射变更后刷新对应 client 的 MCP 配置(失败仅告警,不阻断) */
  _resyncPromptClients(clientIds) {
    const ids = [...new Set(clientIds || [])].filter(Boolean);
    if (!ids.length) return;
    try {
      require('./mcp-manager').syncToClients({ clientIds: ids });
    } catch (e) {
      console.warn('[resource-manager] prompt MCP re-sync failed:', e.message);
    }
  }
```

2. `projectToAgents` 里投射循环结束后(`_syncAssistantRuntimeFromProjections` 调用附近)追加:

```js
    if (resource.type === 'prompt') {
      this._resyncPromptClients(ids);
    }
```

3. `unproject` 的 `return` 前追加:

```js
    if (resource?.type === 'prompt') {
      this._resyncPromptClients([row.agent_id]);
    }
```

4. `deleteResource` 在删除 DB 行之前捕获受影响 client,`return` 前触发:

```js
    const promptClientIds = resource.type === 'prompt'
      ? (resource.projections || []).map(p => p.agentId)
      : [];
```
(放在 unproject 循环前;`return { success: true };` 前加 `this._resyncPromptClients(promptClientIds);`)

Run: `cd client && node --test electron/__tests__/prompt-project-resync-clients.test.js`
Expected: PASS(3 tests)

- [ ] **Step 3: 改 IPC 与 Resources.jsx**

1. `ipc-handlers-resource.js` :92-100:

```js
      return {
        success: true,
        agents: resourceManager.listAgentTargets(),
        promptAgents: resourceManager.listPromptAgentTargets(),
      };
```

2. `Resources.jsx`:
   - 新增 state:`const [promptAgents, setPromptAgents] = useState([]);`(:142 `agents` 旁)
   - :186 旁:`if (agentRes.success) setPromptAgents(agentRes.promptAgents || []);`
   - `renderProjectMenu`(:1017)里目标列表按类型选择:菜单头部之后 `agents.map` 改为 `targetList.map`,函数开头加:

```jsx
    const targetList = resource?.type === 'prompt' ? promptAgents : agents;
```

   - 菜单提示分流(:1028-1030):

```jsx
          {resource?.type === 'prompt' ? (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.promptMcpHint')}</p>
          ) : resource?.type !== 'skill' && (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.nonSkillHint')}</p>
          )}
```

3. i18n 增加 key(两文件,放在 `resources.nonSkillHint` 旁):
   - `pages-zh.js`:`'resources.promptMcpHint': '投射后,该 Agent 会话可通过 MCP 工具 tb_get_prompt 按名取回此提示词',`
   - `pages-en.js`:`'resources.promptMcpHint': 'After projecting, the agent can fetch this prompt via the MCP tool tb_get_prompt',`

- [ ] **Step 4: 全量验证**

```bash
cd client
npm test
npx vite build 2>&1 | tail -3
```
Expected: 测试全绿;build 成功。

- [ ] **Step 5: 提交**

```bash
git add -A client
git commit -m "feat(resource): prompt 投射驱动 client re-sync;Resources 投射菜单接入 MCP 客户端目标"
```

---

## 完成后

- 全量回归:`cd client && npm test`。
- 端到端冒烟(手动/可选):在 Resources 页投射一条 prompt 给 claude-code → 检查 `~/.claude/mcp.json` 出现 `tokenbank-prompts`(command 为 Electron 路径,env 含 `TB_CLIENT_ID=claude-code`)→ 在 Claude Code 会话说「使用『xx』prompt …」验证自动取回;取消投射 → 条目消失。
- 历史遗留:老版本投射产生的斜杠命令文件(`~/.claude/commands/tokenbank/*.md`、`~/.codex/prompts/*.md`,首部含 `tokenbank-managed-prompt` 标记)不再被管理,本计划不做自动清理;如需干净环境可手动删除。
- 按 `superpowers:finishing-a-development-branch` 处理分支收尾。

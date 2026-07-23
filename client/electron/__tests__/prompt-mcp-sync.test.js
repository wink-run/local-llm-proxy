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

test('serverToEntry: prompts server 物化为 shell launcher（内嵌 ELECTRON_RUN_AS_NODE）', () => {
  const entry = sync.serverToEntry(promptsRow, 'claude-code');
  assert.ok(String(entry.command).endsWith('prompts-claude-code.sh'), entry.command);
  assert.deepEqual(entry.args, []);
  const sh = require('fs').readFileSync(entry.command, 'utf8');
  assert.ok(sh.includes('ELECTRON_RUN_AS_NODE=1'));
  assert.ok(sh.includes('prompt-mcp.js'));
  // 即使在系统 Node 下跑测试，launcher 也应指向 Electron 二进制而非 node
  assert.ok(/Electron(\.app|['"])|[/\\]electron['"]/i.test(sh), sh);
  assert.ok(!/[/\\]bin[/\\]node'/.test(sh), 'launcher must not use system node');
  assert.ok(sh.includes("TB_CLIENT_ID='claude-code'") || sh.includes('TB_CLIENT_ID=claude-code'));
});

test('serverToEntry: bridge 与其他 __DYNAMIC_ELECTRON__ 仍返回 null', () => {
  assert.equal(sync.serverToEntry({ id: 'tokenbank-agent-bridge', status: 'active', command: '__DYNAMIC_ELECTRON__' }, 'codex'), null);
  assert.equal(sync.serverToEntry({ id: 'other', status: 'active', command: '__DYNAMIC_ELECTRON__' }, 'codex'), null);
});

test('serverToEntry: models server 物化为 shell launcher', () => {
  const entry = sync.serverToEntry({
    id: 'tokenbank-models', name: 'tokenbank-models', status: 'active',
    command: '__DYNAMIC_ELECTRON__', args: '[]', env: '{"ELECTRON_RUN_AS_NODE":"1"}', builtin: 1,
  }, 'cursor');
  assert.ok(String(entry.command).endsWith('models-cursor.sh'), entry.command);
  const sh = require('fs').readFileSync(entry.command, 'utf8');
  assert.ok(sh.includes('models-mcp.js'));
  assert.ok(sh.includes('ELECTRON_RUN_AS_NODE=1'));
});

test('serverToEntry: resources server 物化为 shell launcher', () => {
  const entry = sync.serverToEntry({
    id: 'tokenbank-resources', name: 'tokenbank-resources', status: 'active',
    command: '__DYNAMIC_ELECTRON__', args: '[]', env: '{"ELECTRON_RUN_AS_NODE":"1"}', builtin: 1,
  }, 'codex');
  assert.ok(String(entry.command).endsWith('resources-codex.sh'), entry.command);
  const sh = require('fs').readFileSync(entry.command, 'utf8');
  assert.ok(sh.includes('resources-mcp.js'));
});

test('serverToEntry: URL/SSE MCP 可写出 url 条目', () => {
  const entry = sync.serverToEntry({
    id: 'mcp-import-connector-proxy',
    name: 'connector-proxy',
    status: 'active',
    type: 'sse',
    command: '',
    url: 'http://127.0.0.1:50097/mcp',
    metadata: {},
  }, 'cursor');
  assert.ok(entry);
  assert.equal(entry.url, 'http://127.0.0.1:50097/mcp');
  assert.equal(entry.type, 'sse');
  assert.equal(entry.command, undefined);
});

test('filterServersForClient: 无投射的 client 不下发 prompts server', () => {
  const orig = resourceManager.hasPromptProjections;
  resourceManager.hasPromptProjections = (cid) => cid === 'cursor';
  try {
    // 未显式配置 sync_clients → 懒下发，仅有投射的 client
    const withProj = sync.filterServersForClient([promptsRow], 'cursor');
    const withoutProj = sync.filterServersForClient([promptsRow], 'codex');
    assert.equal(withProj.length, 1);
    assert.equal(withoutProj.length, 0);
  } finally { resourceManager.hasPromptProjections = orig; }
});

test('filterServersForClient: 显式 sync_clients 时即使无投射也下发 prompts', () => {
  const orig = resourceManager.hasPromptProjections;
  resourceManager.hasPromptProjections = () => false;
  try {
    const row = {
      ...promptsRow,
      sync_clients: ['workbuddy'],
      metadata: { sync_clients: ['workbuddy'] },
    };
    assert.equal(sync.filterServersForClient([row], 'workbuddy').length, 1);
    assert.equal(sync.filterServersForClient([row], 'cursor').length, 0);
  } finally { resourceManager.hasPromptProjections = orig; }
});

test('filterServersForClient: 取消 sync_clients 勾选后不下发 prompts（即使有投射）', () => {
  const orig = resourceManager.hasPromptProjections;
  resourceManager.hasPromptProjections = () => true;
  try {
    const row = {
      ...promptsRow,
      sync_clients: ['cursor', 'codex'],
      metadata: { sync_clients: ['cursor', 'codex'] },
    };
    assert.equal(sync.filterServersForClient([row], 'cursor').length, 1);
    assert.equal(sync.filterServersForClient([row], 'workbuddy').length, 0);
  } finally { resourceManager.hasPromptProjections = orig; }
});

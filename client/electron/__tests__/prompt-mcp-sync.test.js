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

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

test('listPromptAgentTargets 返回已安装或已勾选同步 prompts MCP 的 Agent', () => {
  const mcpManager = require('../mcp-manager');
  const { CLIENT_TARGETS } = require('../mcp-agent-targets');
  const orig = mcpManager.listServers;
  mcpManager.listServers = () => ([{
    id: 'tokenbank-prompts',
    // 格式化后的 sync_clients 可能是默认全量，必须以 metadata 为准
    sync_clients: ['cursor', 'claude-code', 'codex', 'workbuddy'],
    metadata: { sync_clients: ['cursor', 'workbuddy'] },
    clientTargets: [
      { id: 'cursor', installed: true },
      { id: 'claude-code', installed: true },
      { id: 'workbuddy', installed: false },
      { id: 'codex', installed: false },
    ],
  }]);
  try {
    const r = resourceManager.listPromptAgentTargets();
    // cursor/claude-code：已安装；workbuddy：metadata 显式勾选
    assert.deepEqual(r.map(x => x.id).sort(), ['claude-code', 'cursor', 'workbuddy']);
    for (const x of r) assert.equal(x.label, CLIENT_TARGETS[x.id].label);
  } finally {
    mcpManager.listServers = orig;
  }
});

test('listPromptAgentTargets 无显式安装时不把默认 sync_clients 全量当成可投射', () => {
  const mcpManager = require('../mcp-manager');
  const orig = mcpManager.listServers;
  mcpManager.listServers = () => ([{
    id: 'tokenbank-prompts',
    sync_clients: ['cursor', 'claude-code', 'codex', 'workbuddy'],
    metadata: {},
    clientTargets: [
      { id: 'cursor', installed: true },
      { id: 'workbuddy', installed: false },
    ],
  }]);
  try {
    const r = resourceManager.listPromptAgentTargets();
    assert.deepEqual(r.map(x => x.id), ['cursor']);
  } finally {
    mcpManager.listServers = orig;
  }
});

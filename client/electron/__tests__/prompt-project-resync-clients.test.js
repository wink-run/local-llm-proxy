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

test('listPromptAgentTargets 与 Skill 一致：已纳管(hosted) 且已安装 Agent', () => {
  const gw = require('../mcp-gateway-targets');
  const targets = require('../resource-agent-targets');
  const orig = gw.listHostedAgentIds;
  const origInstalled = targets.isAgentInstalled;
  // 与 Gateway 列表一致：须同时 hosted 且本机检测到
  gw.listHostedAgentIds = () => new Set(['claude-code', 'cursor', 'openclaw']);
  targets.isAgentInstalled = (id) => ['claude-code', 'cursor', 'openclaw'].includes(id);
  try {
    const r = resourceManager.listPromptAgentTargets();
    assert.deepEqual(r.map(x => x.id).sort(), ['claude-code', 'cursor', 'openclaw']);
    assert.ok(r.every(x => x.label));
  } finally {
    gw.listHostedAgentIds = orig;
    targets.isAgentInstalled = origInstalled;
  }
});

test('listPromptAgentTargets：hosted 但未安装(OpenCode 残留)不出现', () => {
  const gw = require('../mcp-gateway-targets');
  const targets = require('../resource-agent-targets');
  const orig = gw.listHostedAgentIds;
  const origInstalled = targets.isAgentInstalled;
  // opencode 有 hosted 残留记录，但本机未真正安装 → 与 Gateway 一致地排除
  gw.listHostedAgentIds = () => new Set(['cursor', 'opencode']);
  targets.isAgentInstalled = (id) => id === 'cursor';
  try {
    const r = resourceManager.listPromptAgentTargets();
    assert.deepEqual(r.map(x => x.id).sort(), ['cursor']);
  } finally {
    gw.listHostedAgentIds = orig;
    targets.isAgentInstalled = origInstalled;
  }
});

test('listPromptAgentTargets 未纳管则不出现', () => {
  const targets = require('../resource-agent-targets');
  const gw = require('../mcp-gateway-targets');
  const origInstalled = targets.isAgentInstalled;
  const origHosted = gw.listHostedAgentIds;
  // 无纳管、也无强信号安装 → 空
  gw.listHostedAgentIds = () => new Set();
  targets.isAgentInstalled = () => false;
  try {
    const r = resourceManager.listPromptAgentTargets();
    assert.deepEqual(r, []);
  } finally {
    targets.isAgentInstalled = origInstalled;
    gw.listHostedAgentIds = origHosted;
  }
});

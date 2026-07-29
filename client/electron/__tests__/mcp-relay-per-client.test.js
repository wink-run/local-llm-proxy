'use strict';
// 内置中转（stdio MCP）按应用 cid 交付：resolveGatewaySpawnConfig 为内置 prompts/resources
// 注入 TB_CLIENT_ID=cid，从而每个应用只看到「投射到它」的 prompt/resource 集。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const localStats = require('../local-stats');
const mcpManager = require('../mcp-manager');
const gw = require('../mcp-gateway-targets');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-relay-'));
  localStats.close();
  assert.ok(localStats.init(dir, { force: true }));
  try { return fn(); } finally {
    localStats.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('resolveGatewaySpawnConfig：内置 prompts 按 cid 注入 TB_CLIENT_ID', () => {
  withDb(() => {
    const row = { id: 'tokenbank-prompts', name: 'tokenbank-prompts', command: '__DYNAMIC_ELECTRON__' };
    const cfg = mcpManager.resolveGatewaySpawnConfig(row, 'trae-work');
    assert.ok(String(cfg.command).endsWith('.sh'), cfg.command);
    const sh = fs.readFileSync(cfg.command, 'utf8');
    assert.ok(sh.includes('prompt-mcp.js'));
    assert.ok(sh.includes("TB_CLIENT_ID='trae-work'") || sh.includes('TB_CLIENT_ID=trae-work'), sh);
  });
});

test('resolveGatewaySpawnConfig：不同 cid 得到不同 launcher（可见集隔离）', () => {
  withDb(() => {
    const row = { id: 'tokenbank-resources', name: 'tokenbank-resources', command: '__DYNAMIC_ELECTRON__' };
    const a = mcpManager.resolveGatewaySpawnConfig(row, 'app-x1').command;
    const b = mcpManager.resolveGatewaySpawnConfig(row, 'app-x2').command;
    assert.notEqual(a, b);
    assert.ok(fs.readFileSync(a, 'utf8').includes("TB_CLIENT_ID='app-x1'") || fs.readFileSync(a, 'utf8').includes('TB_CLIENT_ID=app-x1'));
    assert.ok(fs.readFileSync(b, 'utf8').includes("TB_CLIENT_ID='app-x2'") || fs.readFileSync(b, 'utf8').includes('TB_CLIENT_ID=app-x2'));
  });
});

test('resolveGatewaySpawnConfig：空 cid → 通用（TB_CLIENT_ID 为空）', () => {
  withDb(() => {
    const row = { id: 'tokenbank-prompts', name: 'tokenbank-prompts', command: '__DYNAMIC_ELECTRON__' };
    const cfg = mcpManager.resolveGatewaySpawnConfig(row);
    const sh = fs.readFileSync(cfg.command, 'utf8');
    assert.ok(sh.includes("TB_CLIENT_ID=''") || /TB_CLIENT_ID=\s*$/m.test(sh) || sh.includes('prompts-default'));
  });
});

test('isAllowedGatewayClientId：非法 id 仍拒绝（白名单未放开一切）', () => {
  assert.equal(gw.isAllowedGatewayClientId('这不是合法id!!'), false);
  assert.equal(gw.isAllowedGatewayClientId('app-abc123'), true); // API 应用形态放行
});

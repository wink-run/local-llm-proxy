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

/** Unix 经 /bin/sh 包装后，真正的 .sh 在 args[0]；Windows .cmd 在 args 里 */
function launcherFile(cfg) {
  const args = Array.isArray(cfg.args) ? cfg.args : [];
  const fromArgs = args
    .map((a) => String(a).replace(/^"|"$/g, ''))
    .find((a) => /\.(sh|cmd)$/i.test(a));
  if (fromArgs) return fromArgs;
  return String(cfg.command || '');
}

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-relay-'));
  localStats.close();
  mcpManager._seeded = false;
  assert.ok(localStats.init(dir, { force: true }));
  try { return fn(); } finally {
    localStats.close();
    mcpManager._seeded = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('resolveGatewaySpawnConfig：内置 prompts 按 cid 注入 TB_CLIENT_ID', () => {
  withDb(() => {
    const row = { id: 'tokenbank-prompts', name: 'tokenbank-prompts', command: '__DYNAMIC_ELECTRON__' };
    const cfg = mcpManager.resolveGatewaySpawnConfig(row, 'trae-work');
    const file = launcherFile(cfg);
    assert.ok(/\.(sh|cmd)$/i.test(file), file);
    const sh = fs.readFileSync(file, 'utf8');
    assert.ok(sh.includes('prompt-mcp.js'));
    assert.ok(sh.includes("TB_CLIENT_ID='trae-work'") || sh.includes('TB_CLIENT_ID=trae-work'), sh);
  });
});

test('resolveGatewaySpawnConfig：不同 cid 得到不同 launcher（可见集隔离）', () => {
  withDb(() => {
    const row = { id: 'tokenbank-resources', name: 'tokenbank-resources', command: '__DYNAMIC_ELECTRON__' };
    const a = launcherFile(mcpManager.resolveGatewaySpawnConfig(row, 'app-x1'));
    const b = launcherFile(mcpManager.resolveGatewaySpawnConfig(row, 'app-x2'));
    assert.notEqual(a, b);
    assert.ok(fs.readFileSync(a, 'utf8').includes("TB_CLIENT_ID='app-x1'") || fs.readFileSync(a, 'utf8').includes('TB_CLIENT_ID=app-x1'));
    assert.ok(fs.readFileSync(b, 'utf8').includes("TB_CLIENT_ID='app-x2'") || fs.readFileSync(b, 'utf8').includes('TB_CLIENT_ID=app-x2'));
  });
});

test('resolveGatewaySpawnConfig：空 cid → 通用（TB_CLIENT_ID 为空）', () => {
  withDb(() => {
    const row = { id: 'tokenbank-prompts', name: 'tokenbank-prompts', command: '__DYNAMIC_ELECTRON__' };
    const cfg = mcpManager.resolveGatewaySpawnConfig(row);
    const sh = fs.readFileSync(launcherFile(cfg), 'utf8');
    assert.ok(sh.includes("TB_CLIENT_ID=''") || /TB_CLIENT_ID=\s*$/m.test(sh) || sh.includes('prompts-default'));
  });
});

test('isAllowedGatewayClientId：非法 id 拒绝；已删除的 app-* 不再放行', () => {
  assert.equal(gw.isAllowedGatewayClientId('这不是合法id!!'), false);
  gw.setAppsGetter(() => []);
  assert.equal(gw.isAllowedGatewayClientId('app-abc123'), false);
  gw.setAppsGetter(() => [{ id: 'app-abc123', link_method: 'manual', name: 'demo', draft: false }]);
  assert.equal(gw.isAllowedGatewayClientId('app-abc123'), true);
  gw.setAppsGetter(null);
});

test('unbindClient 清掉已删应用的中转与投射', () => {
  withDb(() => {
    const origSync = mcpManager.syncToClients;
    mcpManager.syncToClients = () => ({ success: true, results: [] });
    try {
      mcpManager.init();
      const db = localStats.getDb();
      const now = Date.now();
      for (const id of ['tokenbank-models', 'tokenbank-prompts', 'tokenbank-resources']) {
        const row = db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get(id);
        const meta = JSON.parse(row.metadata || '{}');
        meta.gateway_clients = ['api', 'app-deadbeef'];
        meta.gateway_routed = true;
        meta.sync_clients = ['cursor', 'app-deadbeef'];
        db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(meta), now, id);
      }
      const r = mcpManager.unbindClient('app-deadbeef');
      assert.ok(r.updated >= 1);
      for (const id of ['tokenbank-models', 'tokenbank-prompts', 'tokenbank-resources']) {
        const s = mcpManager.getServer(id);
        assert.ok(!(s.gateway_clients || []).includes('app-deadbeef'), id);
        assert.ok(!(s.sync_clients || []).includes('app-deadbeef'), id);
        assert.ok((s.gateway_clients || []).includes('api'), id);
      }
    } finally {
      mcpManager.syncToClients = origSync;
    }
  });
});

test('pruneStaleDeletedAppBindings 清掉列表里已不存在的 app-*', () => {
  withDb(() => {
    const origSync = mcpManager.syncToClients;
    mcpManager.syncToClients = () => ({ success: true, results: [] });
    gw.setAppsGetter(() => []);
    try {
      mcpManager.init();
      const db = localStats.getDb();
      const now = Date.now();
      const row = db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get('tokenbank-models');
      const meta = JSON.parse(row.metadata || '{}');
      meta.gateway_clients = ['api', 'app-gone'];
      meta.gateway_routed = true;
      db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(meta), now, 'tokenbank-models');
      const r = mcpManager.pruneStaleDeletedAppBindings();
      assert.ok(r.stale.includes('app-gone'));
      const s = mcpManager.getServer('tokenbank-models');
      assert.ok(!(s.gateway_clients || []).includes('app-gone'));
      assert.ok((s.gateway_clients || []).includes('api'));
    } finally {
      mcpManager.syncToClients = origSync;
      gw.setAppsGetter(null);
    }
  });
});

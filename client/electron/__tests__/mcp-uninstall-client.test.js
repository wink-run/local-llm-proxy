'use strict';
// 卸载客户端自配 MCP 须同时从 Agent 配置文件删除，否则扫描即纳管会把同一条再导入
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const localStats = require('../local-stats');
const mcpManager = require('../mcp-manager');
const mcpClientSync = require('../mcp-client-sync');

function withTempEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-uninst-home-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-uninst-db-'));
  const origHome = os.homedir;
  os.homedir = () => home;
  localStats.close();
  mcpManager._seeded = false;
  mcpManager._lastDiscoverAt = 0;
  mcpClientSync.invalidateScanCache();
  const origSync = mcpManager.syncToClients;
  mcpManager.syncToClients = () => ({ success: true, results: [] });
  assert.ok(localStats.init(dbDir, { force: true }));
  try {
    return fn({ home });
  } finally {
    mcpManager.syncToClients = origSync;
    os.homedir = origHome;
    localStats.close();
    mcpManager._seeded = false;
    mcpManager._lastDiscoverAt = 0;
    mcpClientSync.invalidateScanCache();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('卸载客户端自配 MCP：从 Agent 配置删除且不会被扫描重新纳管', () => {
  withTempEnv(({ home }) => {
    const mcpPath = path.join(home, '.workbuddy', 'mcp.json');
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        'tokenbank-relay': {
          url: 'http://127.0.0.1:11431/mcp/workbuddy',
        },
        'keep-me': {
          command: 'npx',
          args: ['-y', 'other-mcp'],
        },
      },
    }, null, 2));

    mcpManager.init();
    const imported = mcpManager.importFromAgent({
      clientId: 'workbuddy',
      clientKey: 'tokenbank-relay',
      originAgents: ['workbuddy'],
    });
    assert.equal(imported.success, true);
    assert.ok(imported.server?.id);

    const res = mcpManager.uninstallServer(imported.server.id);
    assert.equal(res.success, true);
    assert.equal(mcpManager.getServer(imported.server.id), null);

    const doc = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    assert.ok(!doc.mcpServers['tokenbank-relay'], 'Agent 配置应删掉该 MCP');
    assert.ok(doc.mcpServers['keep-me'], '其它自配条目应保留');

    mcpManager._lastDiscoverAt = 0;
    mcpClientSync.invalidateScanCache();
    const names = mcpManager.listServers().map((s) => s.name);
    assert.ok(!names.includes('tokenbank-relay'), '卸载后扫描不应再纳管');
  });
});

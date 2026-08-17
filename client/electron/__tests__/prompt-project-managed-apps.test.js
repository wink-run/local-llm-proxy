'use strict';
// prompt / 智能体的投射目标 = 全部已纳管应用（含 Trae / API 应用，经 MCP 或内置中转交付）；
// skill 仍限 skill-hostable agent。投射时 id 归一到交付 cid（codex-desktop→codex）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rm = require('../resource-manager');
const gw = require('../mcp-gateway-targets');
const mcpTargets = require('../mcp-agent-targets');
const targets = require('../resource-agent-targets');
const mcpManager = require('../mcp-manager');
const localStats = require('../local-stats');

function agentIdsFor(resourceId) {
  const db = localStats.getDb();
  return db.prepare(
    'SELECT agent_id FROM resource_projections WHERE resource_id = ? ORDER BY agent_id',
  ).all(resourceId).map(r => r.agent_id);
}

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-proj-managed-'));
  localStats.close();
  mcpManager._seeded = false;
  assert.ok(localStats.init(dir, { force: true }), '测试 DB 应初始化成功');
  try { return fn(); } finally {
    localStats.close();
    mcpManager._seeded = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('prompt 可投射到任意已纳管应用（Trae/API），并归一到交付 cid', () => {
  withTempDb(() => {
    const origManaged = gw.listManagedAppTargetIds;
    const origResolve = mcpTargets.resolveMcpSyncClientId;
    const origSync = mcpManager.syncToClients;
    // 纳管集：codex(stdio) / trae-work(中转) / app-x1(API·中转)
    gw.listManagedAppTargetIds = () => new Set(['codex', 'trae-work', 'app-x1']);
    gw.setAppsGetter(() => [
      { id: 'app-x1', link_method: 'manual', hosted: true, name: 'x1', draft: false },
    ]);
    // codex-desktop 归一为 codex；trae-work / app-x1 走中转（自身）；未知 → null
    mcpTargets.resolveMcpSyncClientId = (id) => {
      if (id === 'codex-desktop') return 'codex';
      return ['codex', 'trae-work', 'app-x1'].includes(id) ? id : null;
    };
    mcpManager.syncToClients = () => ({ success: true, results: [] });

    const PID = 'res-prompt-zz-managed';
    try {
      const db = localStats.getDb();
      db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(PID);
      db.prepare('DELETE FROM resources WHERE id = ?').run(PID);
      rm.saveResource({
        type: 'prompt', name: 'zz-managed', display_name: 'ZZ', description: 't',
        content: '正文 $ARGUMENTS',
      });

      const res = rm.projectToAgents(PID, ['codex-desktop', 'trae-work', 'app-x1'], 'global', {});
      assert.equal(res.success, true);
      // codex-desktop 归一为 codex，三个目标全部落库
      assert.deepEqual(agentIdsFor(PID), ['app-x1', 'codex', 'trae-work']);
    } finally {
      gw.listManagedAppTargetIds = origManaged;
      mcpTargets.resolveMcpSyncClientId = origResolve;
      mcpManager.syncToClients = origSync;
      gw.setAppsGetter(null);
    }
  });
});

test('skill 仍限 skill-hostable：投到非承载目标(Trae)被拒', () => {
  withTempDb(() => {
    const origManagedAgents = targets.listManagedResourceAgentIds;
    // skill 只认可承载 skill 的 agent；trae-work 不在其中
    targets.listManagedResourceAgentIds = () => ['cursor'];

    const SID = 'res-skill-zz-hostonly';
    try {
      const db = localStats.getDb();
      db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(SID);
      db.prepare('DELETE FROM resources WHERE id = ?').run(SID);
      rm.saveResource({
        type: 'skill', name: 'zz-hostonly', display_name: 'ZZ', description: 't',
        content: '# zz-hostonly',
      });

      // 只投给 trae-work（非 skill-hostable）→ 过滤后无有效目标 → 抛错
      assert.throws(
        () => rm.projectToAgents(SID, ['trae-work'], 'global', {}),
        /至少选择一个已纳管的应用/,
      );
      // trae-work 绝不会成为 skill 的投射目标（saveResource 的 .agents 默认投射不含它）
      assert.ok(!agentIdsFor(SID).includes('trae-work'));
    } finally {
      targets.listManagedResourceAgentIds = origManagedAgents;
    }
  });
});

test('unprojectAllForClient 撤掉已删 app-* 上的资源投射', () => {
  withTempDb(() => {
    const db = localStats.getDb();
    const saved = rm.saveResource({
      type: 'prompt', name: 'gone-app', display_name: 'Gone', description: 't',
      content: 'hi',
    });
    const PID = saved.resource.id;
    db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(PID);
    const now = Date.now();
    db.prepare(`
      INSERT INTO resource_projections (id, resource_id, agent_id, scope, projection_type, target_path, created_at)
      VALUES (?, ?, ?, 'global', 'mcp', '', ?)
    `).run('proj-gone', PID, 'app-deleted1', now);
    assert.deepEqual(agentIdsFor(PID), ['app-deleted1']);
    const r = rm.unprojectAllForClient('app-deleted1');
    assert.equal(r.count, 1);
    assert.deepEqual(agentIdsFor(PID), []);
  });
});

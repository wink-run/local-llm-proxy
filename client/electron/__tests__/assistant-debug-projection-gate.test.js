'use strict';
// 智能体在 Debug 的可见性由「运行时投射」门控：投射即出现，取消投射即消失。
// CI 无 Codex Desktop/CLI，须 stub 安装探测与可投射目录，避免误依赖本机环境。
const { test } = require('node:test');
const assert = require('node:assert/strict');

const rm = require('../resource-manager');
const ae = require('../agent-executor');
const targets = require('../resource-agent-targets');
const cl = require('../config-loader');

const NAME = 'zzz-debug-gate';
const ID = `res-assistant-${NAME}`;
const RUNTIME = 'codex';

function cleanup() {
  const localStats = require('../local-stats');
  const { STATS_DIR } = require('../../shared/telemetry');
  const db = localStats.requireDb(STATS_DIR);
  try { db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(ID); } catch {}
  try { db.prepare('DELETE FROM resources WHERE id = ?').run(ID); } catch {}
  try { ae.invalidateAgentListCache?.(); } catch {}
}

test('智能体 Debug 可见性由运行时投射门控', async () => {
  cleanup();

  const origInstalled = targets.isAgentInstalled;
  const origExpanded = cl.appEntitiesExpanded;
  // 模拟：本机已装 codex，且勾选「可投射智能体」
  targets.isAgentInstalled = (id) => id === RUNTIME;
  cl.appEntitiesExpanded = () => [{
    id: RUNTIME,
    resource_project: true,
    capabilities: { resource_project: true },
  }];

  try {
    rm.saveResource({
      type: 'assistant', name: NAME, display_name: 'ZZ Gate', description: 't',
      content: JSON.stringify({ soul: 'x' }),
    });

    const shows = async () => {
      const list = await ae.listAvailableAgents({ force: true });
      return list.some(a => a.resourceId === ID);
    };

    // 纳管但未投射 → 不在 Debug
    assert.equal(await shows(), false, '未投射不应出现在 Debug');

    // 投射到 codex → 出现（codex 有 npx 回退，listAvailableAgents 能认出运行时）
    rm.projectToAgents(ID, [RUNTIME], 'global', {});
    assert.equal(await shows(), true, '投射后应出现在 Debug');

    // 取消投射 → 消失
    rm.unproject({ resourceId: ID, agentId: RUNTIME });
    assert.equal(await shows(), false, '取消投射后应从 Debug 消失');
  } finally {
    targets.isAgentInstalled = origInstalled;
    cl.appEntitiesExpanded = origExpanded;
    cleanup();
  }
});

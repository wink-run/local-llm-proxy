'use strict';
// 无磁盘来源的 skill 纳管时应物化到 agents-hub，使「已纳管」tab(读磁盘扫描)可见、可卸载。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rm = require('../resource-manager');

const NAME = 'tb-materialize-test-skill';
const HUB_DIR = path.join(os.homedir(), '.agents', 'skills', NAME);

function cleanup(id) {
  try { fs.rmSync(HUB_DIR, { recursive: true, force: true }); } catch {}
  if (id) {
    try {
      const localStats = require('../local-stats');
      const { STATS_DIR } = require('../../shared/telemetry');
      const db = localStats.requireDb(STATS_DIR);
      db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(id);
      db.prepare('DELETE FROM resources WHERE id = ?').run(id);
    } catch {}
  }
}

test('DB-only skill 纳管后物化到 agents-hub，磁盘扫描可见且可卸载', () => {
  cleanup(`res-skill-${NAME}`);
  let id;
  try {
    const saved = rm.saveResource({
      type: 'skill',
      name: NAME,
      display_name: 'Materialize Test',
      description: 't',
      content: `---\nname: ${NAME}\ndescription: t\n---\n# Body\nhello`,
    });
    id = saved.resource.id;

    // 1. 落盘 + authorityPath
    const res = rm.getResource(id);
    assert.equal(res.metadata.authorityPath, path.resolve(HUB_DIR), 'authorityPath 指向 hub');
    assert.ok(fs.existsSync(path.join(HUB_DIR, 'SKILL.md')), 'SKILL.md 已写盘');

    // 2. 出现在磁盘扫描（「已纳管」tab 渲染 skill 的数据源）
    const inScan = (rm.listDiscoveredSkills({ includeManaged: true }).items || [])
      .some(i => i.name === NAME);
    assert.ok(inScan, 'skill 应出现在磁盘扫描结果');

    // 3. 可卸载（删除权威目录 + DB 行）
    const del = rm.deleteResource(id);
    assert.ok(del.deletedFiles && del.deletedFiles.deleted, '卸载应删除权威目录');
    assert.ok(!fs.existsSync(HUB_DIR), '权威目录已删除');
    id = null;
  } finally {
    cleanup(id);
  }
});

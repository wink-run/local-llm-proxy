'use strict';
// 扫描即纳管：syncDiscoveredSkills 把本机扫描到的 skill 静默纳管，
// 并保持「本机 == 已纳管」。内容变更时自动更新。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const localStats = require('../local-stats');
const resourceManager = require('../resource-manager');
const scanner = require('../resource-skill-scanner');

function writeSkill(dir, name, body) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} desc\n---\n\n${body}\n`,
    'utf8',
  );
}

test('syncDiscoveredSkills 扫描即纳管，且幂等 + 内容变更自动更新', () => {
  const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sync-db-'));
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sync-skills-'));
  // 强制绑定到临时库，避免被其它用例的 init/close 单例状态污染
  localStats.close();
  const opened = localStats.init(statsDir, { force: true });
  assert.ok(opened, '临时 local-stats DB 应初始化成功');

  // 屏蔽本机默认 skills 目录，只验证 customDirs 内的两份 skill
  const origScanGlobal = scanner.scanGlobalSkills;
  scanner.scanGlobalSkills = () => [];

  writeSkill(skillsDir, 'alpha-skill', '# Alpha v1');
  writeSkill(skillsDir, 'beta-skill', '# Beta v1');

  const filters = { customDirs: [skillsDir] };

  try {
    // 首次同步：两个都应纳管
    const first = resourceManager.syncDiscoveredSkills(filters);
    assert.equal(first.success, true);
    assert.equal(first.imported, 2, '两个本机 skill 应被纳管');
    assert.equal(first.updated, 0);
    assert.equal(
      resourceManager.listResources({ type: 'skill' }).length,
      first.scanStats.totalOnDisk,
      '已纳管 skill 数 == 磁盘总数（本机即已纳管）',
    );
    assert.equal(first.scanStats.managedCount, first.scanStats.totalOnDisk);
    // 返回项均已纳管且带 resourceId
    assert.ok(first.items.every(i => i.managed && i.resourceId), 'items 均已纳管带 resourceId');

    // 再次同步：幂等，无新增
    const second = resourceManager.syncDiscoveredSkills(filters);
    assert.equal(second.imported, 0, '重复同步不应再纳管');
    assert.equal(second.updated, 0);

    // 记录 alpha 旧 hash
    const alphaBefore = resourceManager.listResources({ type: 'skill' })
      .find(r => r.name === 'alpha-skill');
    assert.ok(alphaBefore);

    // 改动 alpha 内容 → 自动更新
    writeSkill(skillsDir, 'alpha-skill', '# Alpha v2 CHANGED');
    const third = resourceManager.syncDiscoveredSkills(filters);
    assert.equal(third.imported, 0);
    assert.equal(third.updated, 1, '内容变更应自动更新纳管记录');

    const alphaAfter = resourceManager.listResources({ type: 'skill' })
      .find(r => r.name === 'alpha-skill');
    assert.notEqual(alphaAfter.hash, alphaBefore.hash, '库内 hash 应随内容更新');
  } finally {
    scanner.scanGlobalSkills = origScanGlobal;
    localStats.close();
    fs.rmSync(statsDir, { recursive: true, force: true });
    fs.rmSync(skillsDir, { recursive: true, force: true });
  }
});

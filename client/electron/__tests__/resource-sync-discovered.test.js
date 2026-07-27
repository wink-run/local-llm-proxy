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

test('.agents（agents-hub）skill 纳管后默认投射到已安装 Agent', () => {
  const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-hub-auto-db-'));
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-hub-auto-skills-'));
  localStats.close();
  assert.ok(localStats.init(statsDir, { force: true }), '临时 local-stats DB 应初始化成功');

  writeSkill(hubRoot, 'hub-auto-skill', '# from .agents');

  const origScanGlobal = scanner.scanGlobalSkills;
  // 只暴露一份全局 ~/.agents/skills 条目（模拟 EXTRA_SKILL_ROOTS agents-hub）
  scanner.scanGlobalSkills = () => {
    const skillDir = path.join(hubRoot, 'hub-auto-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    return [{
      scanKey: 'agents-hub::hub-auto-skill',
      type: 'skill',
      name: 'hub-auto-skill',
      display_name: 'hub-auto-skill',
      description: 'hub-auto-skill desc',
      version: '',
      content,
      hash: scanner.hashContent(content),
      agentId: 'agents-hub',
      agentLabel: '.agents',
      skillDir,
      skillPath,
      skillRoot: hubRoot,
      metadata: { tags: [], scannedFrom: skillDir },
      scope: 'global',
    }];
  };

  const targets = require('../resource-agent-targets');
  const gw = require('../mcp-gateway-targets');
  const origInstalled = targets.isAgentInstalled;
  const origHosted = gw.listHostedAgentIds;
  targets.isAgentInstalled = (id) => id === 'cursor' || id === 'claude-code';
  // 可投射目标 = 已纳管(hosted)：默认投射跟随纳管集
  gw.listHostedAgentIds = () => new Set(['cursor', 'claude-code']);

  const projectCalls = [];
  const origProject = resourceManager.projectToAgents.bind(resourceManager);
  resourceManager.projectToAgents = (resourceId, agentIds, scope, options) => {
    projectCalls.push({ resourceId, agentIds: [...agentIds], scope, options: { ...options } });
    return { results: [] };
  };

  try {
    const first = resourceManager.syncDiscoveredSkills({});
    assert.equal(first.imported, 1);

    const res = resourceManager.listResources({ type: 'skill' })
      .find((r) => r.name === 'hub-auto-skill');
    assert.ok(res, '应已纳管');
    assert.equal(res.metadata?.autoProjectedFromAgentsHub, true, '应标记已尝试默认投射');
    assert.equal(projectCalls.length, 1, '应触发一次默认投射');
    assert.deepEqual(projectCalls[0].agentIds.sort(), ['claude-code', 'cursor'].sort());
    assert.equal(projectCalls[0].options.force, false);

    // 再次同步：metadata 已打标，不再投射
    resourceManager.syncDiscoveredSkills({});
    assert.equal(projectCalls.length, 1, '重复同步不应再次默认投射');
  } finally {
    resourceManager.projectToAgents = origProject;
    targets.isAgentInstalled = origInstalled;
    gw.listHostedAgentIds = origHosted;
    scanner.scanGlobalSkills = origScanGlobal;
    localStats.close();
    fs.rmSync(statsDir, { recursive: true, force: true });
    fs.rmSync(hubRoot, { recursive: true, force: true });
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  replaceWithSymlink,
  isSymlinkTo,
  projectSkillToAgent,
  projectPromptToAgent,
  unprojectPromptFromAgent,
  verifyProjection,
} = require('../resource-projector');
const { getAgentTarget } = require('../resource-agent-targets');

// 提示词投射改为 MCP 可见性标记(不落盘)：见 prompt-projection-mcp.test.js
test('projectPromptToAgent/unprojectPromptFromAgent 不落盘,仅返回标记', () => {
  const resource = { type: 'prompt', name: 'refactor', content: '请重构下面的代码：' };
  const proj = projectPromptToAgent(resource, 'cursor');
  assert.equal(proj.projectionType, 'mcp');
  assert.equal(proj.status, 'active');
  assert.equal(proj.targetPath, null);
  assert.equal(unprojectPromptFromAgent(resource, 'cursor').removed, true);
});

test('replaceWithSymlink creates directory symlink to canonical', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-symlink-'));
  const canonicalDir = path.join(tmp, 'canonical', 'demo');
  const targetDir = path.join(tmp, 'agent', 'skills', 'demo');
  const canonicalMd = path.join(canonicalDir, 'SKILL.md');
  const targetMd = path.join(targetDir, 'SKILL.md');

  fs.mkdirSync(canonicalDir, { recursive: true });
  fs.writeFileSync(canonicalMd, '# demo\n', 'utf8');
  fs.writeFileSync(path.join(canonicalDir, 'helper.js'), 'module.exports = {};\n', 'utf8');

  const mode = replaceWithSymlink(targetDir, canonicalDir);
  assert.equal(mode, 'symlink');
  assert.ok(isSymlinkTo(targetDir, canonicalDir));
  assert.equal(fs.readFileSync(targetMd, 'utf8'), '# demo\n');
  assert.ok(fs.existsSync(path.join(targetDir, 'helper.js')));

  fs.writeFileSync(canonicalMd, '# updated\n', 'utf8');
  assert.equal(fs.readFileSync(targetMd, 'utf8'), '# updated\n');

  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 注册一个指向 tmp 的临时投射目标 Agent（避免碰真实 ~/.claude） */
function registerTmpAgent(skillRoot) {
  const { AGENT_RESOURCE_TARGETS } = require('../resource-agent-targets');
  AGENT_RESOURCE_TARGETS['tmp-agent'] = {
    id: 'tmp-agent', label: 'Tmp', getSkillRoot: () => skillRoot,
  };
  return () => { delete AGENT_RESOURCE_TARGETS['tmp-agent']; };
}

test('projectSkillToAgent 拒绝覆盖同名的无关真实目录（防数据丢失）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-conflict-'));
  const authorityDir = path.join(tmp, 'authority', 'demo');
  fs.mkdirSync(authorityDir, { recursive: true });
  fs.writeFileSync(path.join(authorityDir, 'SKILL.md'), '# authority\n', 'utf8');

  const skillRoot = path.join(tmp, 'agent', 'skills');
  const foreignDir = path.join(skillRoot, 'demo');
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, 'SKILL.md'), '# user-own-unrelated\n', 'utf8');
  const cleanup = registerTmpAgent(skillRoot);

  const resource = { type: 'skill', name: 'demo', content: '# c\n', metadata: { authorityPath: authorityDir } };
  try {
    const proj = projectSkillToAgent(resource, 'tmp-agent');
    assert.equal(proj.projectionType, 'conflict');
    assert.equal(proj.conflict, true);
    // 用户的原目录必须原封不动
    assert.ok(!fs.lstatSync(foreignDir).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(foreignDir, 'SKILL.md'), 'utf8'), '# user-own-unrelated\n');

    // force 时才允许替换为软链
    const forced = projectSkillToAgent(resource, 'tmp-agent', 'global', { force: true });
    assert.equal(forced.projectionType, 'symlink');
    assert.ok(isSymlinkTo(foreignDir, authorityDir));
  } finally {
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyProjection 检测软链缺失/悬空并标记可修复', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-verify-'));
  const authorityDir = path.join(tmp, 'authority', 'demo');
  fs.mkdirSync(authorityDir, { recursive: true });
  fs.writeFileSync(path.join(authorityDir, 'SKILL.md'), '# a\n', 'utf8');
  const skillRoot = path.join(tmp, 'agent', 'skills');
  const cleanup = registerTmpAgent(skillRoot);
  const resource = { type: 'skill', name: 'demo', metadata: { authorityPath: authorityDir } };
  const targetDir = path.join(skillRoot, 'demo');

  try {
    const proj = projectSkillToAgent(resource, 'tmp-agent');
    assert.equal(proj.projectionType, 'symlink');
    assert.equal(verifyProjection(resource, 'tmp-agent', 'symlink', targetDir).healthy, true);

    // 用户手删软链 → 不健康、可修复
    fs.unlinkSync(targetDir);
    const broken = verifyProjection(resource, 'tmp-agent', 'symlink', targetDir);
    assert.equal(broken.healthy, false);
    assert.equal(broken.reason, 'missing');
    assert.equal(broken.repairable, true);
  } finally {
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('replaceWithSymlink falls back to directory copy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-copy-'));
  const canonicalDir = path.join(tmp, 'canonical', 'demo');
  fs.mkdirSync(canonicalDir, { recursive: true });
  fs.writeFileSync(path.join(canonicalDir, 'SKILL.md'), '# copy\n', 'utf8');

  const targetDir = path.join(tmp, 'agent', 'skills', 'demo');
  const originalSymlink = fs.symlinkSync;
  fs.symlinkSync = () => {
    throw new Error('symlink denied');
  };

  try {
    const mode = replaceWithSymlink(targetDir, canonicalDir);
    assert.equal(mode, 'copy');
    assert.equal(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8'), '# copy\n');
    assert.ok(!fs.lstatSync(targetDir).isSymbolicLink());
  } finally {
    fs.symlinkSync = originalSymlink;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

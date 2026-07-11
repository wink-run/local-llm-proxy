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

/** 注册一个临时「提示词投射目标」Agent（避免碰真实 ~/.claude/commands） */
function registerTmpPromptAgent(promptRoot, withFrontmatter = true) {
  const { AGENT_PROMPT_TARGETS } = require('../resource-agent-targets');
  AGENT_PROMPT_TARGETS['tmp-prompt-agent'] = {
    id: 'tmp-prompt-agent', label: 'TmpP',
    getPromptRoot: () => promptRoot,
    fileName: n => `${n}.md`,
    invoke: n => `/tokenbank:${n}`,
    withFrontmatter,
  };
  return () => { delete AGENT_PROMPT_TARGETS['tmp-prompt-agent']; };
}

test('projectPromptToAgent 把提示词写成原生命令文件（含调用名）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prompt-'));
  const root = path.join(tmp, 'commands');
  const cleanup = registerTmpPromptAgent(root);
  const resource = { type: 'prompt', name: 'refactor', display_name: '重构助手', description: '帮我重构', content: '请重构下面的代码：' };
  try {
    const proj = projectPromptToAgent(resource, 'tmp-prompt-agent');
    assert.equal(proj.projectionType, 'command');
    assert.equal(proj.invoke, '/tokenbank:refactor');
    const file = path.join(root, 'refactor.md');
    assert.ok(fs.existsSync(file));
    const txt = fs.readFileSync(file, 'utf8');
    assert.ok(txt.includes('请重构下面的代码'));
    assert.ok(txt.includes('tokenbank-managed-prompt'), '应带 TB 标记');

    // verify healthy，删文件后不健康且可修复
    assert.equal(verifyProjection(resource, 'tmp-prompt-agent', 'command', file).healthy, true);
    fs.unlinkSync(file);
    const v = verifyProjection(resource, 'tmp-prompt-agent', 'command', file);
    assert.equal(v.healthy, false);
    assert.equal(v.repairable, true);
  } finally {
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('projectPromptToAgent 不覆盖用户自建同名命令；unproject 不删非 TB 文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prompt2-'));
  const root = path.join(tmp, 'commands');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'deploy.md');
  fs.writeFileSync(file, '# 用户自己的 deploy 命令\n', 'utf8'); // 无 TB 标记
  const cleanup = registerTmpPromptAgent(root);
  const resource = { type: 'prompt', name: 'deploy', content: 'TB 的 deploy' };
  try {
    const proj = projectPromptToAgent(resource, 'tmp-prompt-agent');
    assert.equal(proj.projectionType, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), '# 用户自己的 deploy 命令\n', '用户文件未被改');

    const rm = unprojectPromptFromAgent(resource, 'tmp-prompt-agent', file);
    assert.equal(rm.removed, false);
    assert.ok(fs.existsSync(file), 'unproject 不得删用户自建命令');

    // force 才覆盖
    const forced = projectPromptToAgent(resource, 'tmp-prompt-agent', 'global', { force: true });
    assert.equal(forced.projectionType, 'command');
    assert.ok(fs.readFileSync(file, 'utf8').includes('TB 的 deploy'));
    // 现在是 TB 文件，可被 unproject 删除
    assert.equal(unprojectPromptFromAgent(resource, 'tmp-prompt-agent', file).removed, true);
  } finally {
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

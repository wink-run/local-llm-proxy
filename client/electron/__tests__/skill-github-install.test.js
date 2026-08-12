'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseGithubSkillRef,
  materializeGithubSkill,
  skillMdIn,
} = require('../skill-github-install');

test('parseGithubSkillRef: 完整 URL', () => {
  const r = parseGithubSkillRef('https://github.com/adrianpunk/punk-ip-illustrations');
  assert.equal(r.owner, 'adrianpunk');
  assert.equal(r.repo, 'punk-ip-illustrations');
  assert.equal(r.subpath, '');
  assert.equal(r.cloneUrl, 'https://github.com/adrianpunk/punk-ip-illustrations.git');
});

test('parseGithubSkillRef: 中文前缀 + URL', () => {
  const r = parseGithubSkillRef('安装skill https://github.com/adrianpunk/punk-ip-illustrations');
  assert.ok(r);
  assert.equal(r.repo, 'punk-ip-illustrations');
});

test('parseGithubSkillRef: tree 子路径', () => {
  const r = parseGithubSkillRef('https://github.com/foo/bar/tree/main/skills/demo-skill');
  assert.equal(r.owner, 'foo');
  assert.equal(r.repo, 'bar');
  assert.equal(r.ref, 'main');
  assert.equal(r.subpath, 'skills/demo-skill');
});

test('parseGithubSkillRef: owner/repo 简写', () => {
  const r = parseGithubSkillRef('vercel-labs/agent-skills');
  assert.equal(r.owner, 'vercel-labs');
  assert.equal(r.repo, 'agent-skills');
});

test('parseGithubSkillRef: 纯 skillhub slug 不误判', () => {
  assert.equal(parseGithubSkillRef('find-skill'), null);
  assert.equal(parseGithubSkillRef('skillhub install find-skill'), null);
});

test('materializeGithubSkill: 目标已存在则跳过下载', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-gh-fixture-'));
  const installRoot = path.join(tmp, 'skills');
  const target = path.join(installRoot, 'fixture-skill');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: fixture-skill\ndescription: t\n---\n# hi\n');

  const landed = await materializeGithubSkill({
    owner: 'o',
    repo: 'fixture-skill',
    ref: '',
    subpath: '',
    cloneUrl: 'https://github.com/o/fixture-skill.git',
    sourceUrl: 'https://github.com/o/fixture-skill',
  }, { installRoot, force: false });

  assert.equal(landed.alreadyInstalled, true);
  assert.equal(landed.skillDir, target);
  assert.ok(skillMdIn(landed.skillDir));
  fs.rmSync(tmp, { recursive: true, force: true });
});

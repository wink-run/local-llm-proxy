'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSkillFrontmatter,
  extractSkillDescription,
  groupDiscoveredSkills,
  scanAllAgentSkills,
} = require('../resource-skill-scanner');

test('parseSkillFrontmatter reads name and description', () => {
  const content = `---
name: git-commit
description: Generate commit messages
tags: git, workflow
---

# Body
`;
  const meta = parseSkillFrontmatter(content);
  assert.equal(meta.name, 'git-commit');
  assert.equal(meta.description, 'Generate commit messages');
});

test('extractSkillDescription falls back to body prose when YAML missing', () => {
  const content = `---
name: agent-memory
---

# Agent Memory

为AI智能体提供持久记忆，跨会话存储事实、学习行动、回忆信息和追踪实体。

## Usage
`;
  assert.equal(
    extractSkillDescription(content),
    '为AI智能体提供持久记忆，跨会话存储事实、学习行动、回忆信息和追踪实体。',
  );
});

test('extractSkillDescription prefers frontmatter over body', () => {
  const content = `---
name: x
description: from yaml
---

# Title
body text that should be ignored
`;
  assert.equal(extractSkillDescription(content), 'from yaml');
});

test('scanSkillRoot display_name uses skill name only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-name-'));
  const skillDir = path.join(tmp, 'json-pretty');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: json-pretty
description: format json
---

# JSON 美化
`);
  const { scanCustomSkillTree } = require('../resource-skill-scanner');
  const hit = scanCustomSkillTree(tmp).find(i => i.name === 'json-pretty');
  assert.ok(hit);
  assert.equal(hit.display_name, 'json-pretty');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('groupDiscoveredSkills merges same skill on multiple agents', () => {
  const grouped = groupDiscoveredSkills([
    {
      scanKey: 'claude-code::demo',
      name: 'demo',
      hash: 'abc',
      display_name: 'Demo',
      description: 'd',
      content: 'x',
      agentId: 'claude-code',
      agentLabel: 'Claude Code',
      skillPath: '/a/demo/SKILL.md',
      skillRoot: '/a',
    },
    {
      scanKey: 'codex::demo',
      name: 'demo',
      hash: 'abc',
      display_name: 'Demo',
      description: 'd',
      content: 'x',
      agentId: 'codex',
      agentLabel: 'Codex',
      skillPath: '/b/demo/SKILL.md',
      skillRoot: '/b',
    },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].agents.length, 2);
});

test('scanCustomSkillTree finds skills in project subdirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-'));
  const skillDir = path.join(tmp, 'nested', 'packs', 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: nested-demo
description: nested skill
---

# Demo
`);

  const { scanCustomSkillTree } = require('../resource-skill-scanner');
  const flat = scanCustomSkillTree(tmp);
  const hit = flat.find(i => i.name === 'nested-demo');
  assert.ok(hit, 'expected nested skill');
  assert.equal(hit.scope, 'custom');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scanAllAgentSkills merges default and custom dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-'));
  const skillDir = path.join(tmp, '.agents', 'skills', 'only-custom');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: only-custom\n---\n');

  const merged = scanAllAgentSkills({ customDirs: [tmp] });
  assert.ok(merged.some(i => i.name === 'only-custom'), 'custom dir skills included');

  const defaultsOnly = scanAllAgentSkills({ customDirs: [] });
  assert.ok(!defaultsOnly.some(i => i.name === 'only-custom'), 'without customDirs, custom skill absent');

  fs.rmSync(tmp, { recursive: true, force: true });
});

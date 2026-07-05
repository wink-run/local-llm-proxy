'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSkillFrontmatter, groupDiscoveredSkills } = require('../resource-skill-scanner');

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

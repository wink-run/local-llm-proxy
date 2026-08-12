'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSkillDescription,
  extractAssistantDescription,
  extractPromptDescription,
  extractResourceDescription,
  shouldReplaceDescription,
  isRawRoleBlurb,
} = require('../resource-description');

test('extractSkillDescription: 中文正文首段', () => {
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

test('extractSkillDescription: 改写 You are / Your job', () => {
  const content = `# Music Video Director

You are a professional music video director and editor. Your job: take a music audio source, one or more video footage clips, and a director's instruction — analyze everything deeply, then produce a shot-by-shot edit plan.

**Division of labor:**
`;
  const desc = extractSkillDescription(content);
  assert.ok(!/^you are/i.test(desc), desc);
  assert.ok(desc.includes('Music Video Director'), desc);
  assert.ok(/music audio|shot-by-shot|edit plan/i.test(desc), desc);
});

test('extractSkillDescription: 优先像样的 YAML description', () => {
  const content = `---
name: x
description: from yaml
---

You are a bot.
`;
  assert.equal(extractSkillDescription(content), 'from yaml');
});

test('extractAssistantDescription: 从 soul 取首句', () => {
  const content = JSON.stringify({
    soul: '专精格律与意象，擅长七言绝句。后续很长的设定不要上屏。',
    skills: [],
  });
  assert.equal(extractAssistantDescription(content), '专精格律与意象，擅长七言绝句。');
});

test('extractPromptDescription: 正文首段', () => {
  assert.equal(
    extractPromptDescription('把下面的会议纪要整理成待办列表。\n\n## 输入\n'),
    '把下面的会议纪要整理成待办列表。',
  );
});

test('extractResourceDescription / shouldReplaceDescription', () => {
  assert.equal(isRawRoleBlurb('You are a helper'), true);
  assert.equal(isRawRoleBlurb('音乐视频剪辑助手'), false);
  assert.equal(
    shouldReplaceDescription(
      'You are a professional music video director.',
      'Music Video Director：剪辑音乐视频',
    ),
    true,
  );
  assert.equal(
    shouldReplaceDescription('社区推荐的中文说明', 'You are x'),
    false,
  );
  const d = extractResourceDescription('skill', `# Demo\n\nYou are a demo skill. Your job: help with demos.\n`, {});
  assert.ok(d.includes('Demo'), d);
});

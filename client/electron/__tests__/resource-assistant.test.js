'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAssistantConfig,
  buildAssistantLaunch,
  isAssistantAgentId,
  assistantResourceId,
} = require('../resource-assistant');

test('parseAssistantConfig reads soul field', () => {
  const config = parseAssistantConfig(JSON.stringify({
    soul: '你是 Python 专家',
    runtime_agent: 'codex',
    prompts: ['code-review'],
    skills: ['git-commit'],
  }));
  assert.equal(config.soul, '你是 Python 专家');
  assert.equal(config.runtime_agent, 'codex');
  assert.deepEqual(config.prompts, ['code-review']);
});

test('parseAssistantConfig accepts legacy system_prompt', () => {
  const config = parseAssistantConfig(JSON.stringify({
    system_prompt: 'legacy prompt',
  }));
  assert.equal(config.soul, 'legacy prompt');
});

test('buildAssistantLaunch for claude-code uses append-system-prompt', () => {
  const launch = buildAssistantLaunch('claude-code', 'hello');
  assert.ok(launch.claudeExtraArgs.includes('--append-system-prompt'));
});

test('formatAssistantContent migrates system_prompt to soul', () => {
  const { formatAssistantContent } = require('../resource-assistant');
  const out = formatAssistantContent(JSON.stringify({
    system_prompt: 'hello',
    prompts: ['a'],
  }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.soul, 'hello');
  assert.equal(parsed.system_prompt, undefined);
  assert.deepEqual(parsed.prompts, ['a']);
});

test('assistant agent id prefix', () => {
  assert.ok(isAssistantAgentId('assistant:res-assistant-x'));
  assert.equal(assistantResourceId('assistant:res-assistant-x'), 'res-assistant-x');
});

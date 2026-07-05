'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAssistantConfig,
  buildAssistantLaunch,
  isAssistantAgentId,
  assistantResourceId,
} = require('../resource-assistant');

test('parseAssistantConfig reads JSON fields', () => {
  const config = parseAssistantConfig(JSON.stringify({
    system_prompt: '你是 Python 专家',
    runtime_agent: 'codex',
    prompts: ['code-review'],
    skills: ['git-commit'],
  }));
  assert.equal(config.system_prompt, '你是 Python 专家');
  assert.equal(config.runtime_agent, 'codex');
  assert.deepEqual(config.prompts, ['code-review']);
});

test('buildAssistantLaunch for claude-code uses append-system-prompt', () => {
  const launch = buildAssistantLaunch('claude-code', 'hello');
  assert.ok(launch.claudeExtraArgs.includes('--append-system-prompt'));
});

test('assistant agent id prefix', () => {
  assert.ok(isAssistantAgentId('assistant:res-assistant-x'));
  assert.equal(assistantResourceId('assistant:res-assistant-x'), 'res-assistant-x');
});

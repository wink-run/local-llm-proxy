'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DELIVERY_POLICY,
  withDeliveryPolicyPrompt,
  withClaudeDeliverySystemArgs,
} = require('../agent-delivery-policy');
const { buildClaudeCodeArgs } = require('../agent-executor');
const { buildAssistantLaunch } = require('../resource-assistant');
const mcpManager = require('../mcp-manager');

test('DELIVERY_POLICY forbids paste-script and internal cache paths', () => {
  assert.ok(DELIVERY_POLICY.includes('一键保存'));
  assert.ok(DELIVERY_POLICY.includes('codex-runtimes') || DELIVERY_POLICY.includes('artifact_tool'));
  assert.ok(DELIVERY_POLICY.includes('工作目录'));
});

test('withDeliveryPolicyPrompt prefixes once', () => {
  const once = withDeliveryPolicyPrompt('做个 PPT');
  assert.ok(once.startsWith('【Token Bank 产物交付】'));
  assert.ok(once.includes('做个 PPT'));
  assert.equal(withDeliveryPolicyPrompt(once), once);
});

test('withClaudeDeliverySystemArgs appends system prompt', () => {
  const args = withClaudeDeliverySystemArgs(['-p', '--verbose']);
  assert.ok(args.includes('--append-system-prompt'));
  const i = args.indexOf('--append-system-prompt');
  assert.ok(String(args[i + 1]).includes('【Token Bank 产物交付】'));
});

test('buildClaudeCodeArgs injects delivery policy', () => {
  const args = buildClaudeCodeArgs('hello');
  assert.ok(args.includes('--append-system-prompt'));
  const i = args.indexOf('--append-system-prompt');
  assert.ok(String(args[i + 1]).includes('产物交付'));
});

test('buildAssistantLaunch injects policy for claude and codex', () => {
  const cc = buildAssistantLaunch('claude-code', 'soul text');
  const idx = cc.claudeExtraArgs.indexOf('--append-system-prompt');
  assert.ok(String(cc.claudeExtraArgs[idx + 1]).includes('soul text'));
  assert.ok(String(cc.claudeExtraArgs[idx + 1]).includes('产物交付'));

  const cx = buildAssistantLaunch('codex', 'soul text');
  assert.ok(cx.promptPrefix.includes('soul text'));
  assert.ok(cx.promptPrefix.includes('产物交付'));
});

test('orchestrator system includes delivery policy', () => {
  const { DELIVERY_POLICY: pol } = require('../agent-delivery-policy');
  assert.ok(pol.includes('直接写入'));
  assert.ok(typeof mcpManager.buildOrchestratorLaunch === 'function');
});

test('orchestrator prefers specialized assistants before CLI fallback', () => {
  const { ORCHESTRATOR_SYSTEM } = require('../mcp-manager');
  assert.ok(ORCHESTRATOR_SYSTEM.includes('专业智能体'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('assistant:'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('仅当没有匹配'));
});

'use strict';
// Claude Desktop：多选路由与 mask 名 1:1（选 luna 应对 luna，不能被三档折叠到 glm-5）
const { test } = require('node:test');
const assert = require('node:assert');
const { bindClaudeRoutesToKeyScene, claudeNameAtIndex } = require('../../shared/route-binding');

const CMS = [
  'claude-opus-4-8',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
];

const ROUTES = [
  { model_key: 'r0', scene_name: 'opus-self', steps: [{ model: 'claude-opus-4-8', tier: 'paid' }] },
  { model_key: 'r1', scene_name: 'glm-4.7', steps: [{ model: 'glm-4.7', tier: 'paid' }] },
  { model_key: 'r2', scene_name: 'glm-5', steps: [{ model: 'glm-5', tier: 'paid' }] },
  { model_key: 'r3', scene_name: 'glm-5.1', steps: [{ model: 'glm-5.1', tier: 'paid' }] },
  { model_key: 'r4', scene_name: 'k3', steps: [{ model: 'k3', tier: 'paid' }] },
  { model_key: 'r5', scene_name: 'terra', steps: [{ model: 'gpt-5.6-terra', tier: 'paid' }] },
  { model_key: 'r6', scene_name: 'sol', steps: [{ model: 'gpt-5.6-sol', tier: 'paid' }] },
  { model_key: 'r7', scene_name: 'luna', steps: [{ model: 'gpt-5.6-luna', tier: 'paid' }] },
];

test('claudeNameAtIndex：第 8 槽为 haiku mask', () => {
  assert.equal(claudeNameAtIndex(7, CMS), 'claude-haiku-4-5');
});

test('8 路 1:1：选 haiku mask（UI 显示 luna）应落到 luna，而非 glm-5', () => {
  const ks = {};
  const ids = ROUTES.map((r) => r.model_key);
  bindClaudeRoutesToKeyScene(ks, 'sk-desk', ids, ROUTES, CMS);

  assert.equal(ks['sk-desk']['claude-opus-4-8'].scene_name, 'opus-self');
  assert.equal(ks['sk-desk']['claude-opus-4-5'].scene_name, 'glm-5');
  // UI label=gpt-5.6-luna 对应 inferenceModels[7].name=claude-haiku-4-5
  assert.equal(ks['sk-desk']['claude-haiku-4-5'].scene_name, 'luna');
  assert.notEqual(ks['sk-desk']['claude-haiku-4-5'].scene_name, 'glm-5');
});

test('超出 claude_models 数量的路由不再 modulo 覆盖首槽', () => {
  const ks = {};
  const cms = ['claude-opus-4-8', 'claude-sonnet-4-5'];
  const routes = [
    { model_key: 'r0', scene_name: 'opus', steps: [{ model: 'a' }] },
    { model_key: 'r1', scene_name: 'sonnet', steps: [{ model: 'b' }] },
    { model_key: 'r2', scene_name: 'extra', steps: [{ model: 'c' }] },
  ];
  bindClaudeRoutesToKeyScene(ks, 'sk', ['r0', 'r1', 'r2'], routes, cms);
  assert.equal(ks.sk['claude-opus-4-8'].scene_name, 'opus');
  assert.equal(ks.sk['claude-sonnet-4-5'].scene_name, 'sonnet');
  // 第 3 路无可用 mask，不得覆盖 opus
  assert.notEqual(ks.sk['claude-opus-4-8'].scene_name, 'extra');
});

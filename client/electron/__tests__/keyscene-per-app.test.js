'use strict';
// keyScene per-app 分桶：多个 claude 应用（Desktop / 多个 CLI 实例）按 callerKey 各绑各的路由，互不覆盖。
// 这是「多 CLI 实例按目录绑不同路由」功能的地基。
const { test } = require('node:test');
const assert = require('node:assert');
const { bindClaudeRoutesToKeyScene } = require('../../shared/route-binding');

const ROUTES = [
  { model_key: 'llm-router-auto', scene_name: '综合最优', flow: 'auto', steps: [] },
  { model_key: 'llm-router-free', scene_name: '免费源', flow: 'auto', tier: 'free', steps: [] },
  { model_key: 'llm-router-personal', scene_name: '个人源', flow: 'auto', scope: 'personal', steps: [] },
];
const CMS = ['claude-opus-4-8', 'claude-sonnet-4-5', 'claude-haiku-4-5'];

test('两个 callerKey 绑不同路由，同一模型名不互相覆盖', () => {
  const ks = {};
  bindClaudeRoutesToKeyScene(ks, 'sk-A', ['llm-router-auto'], ROUTES, CMS);
  bindClaudeRoutesToKeyScene(ks, 'sk-B', ['llm-router-free'], ROUTES, CMS);

  // 分桶：顶层 key 是 callerKey，子层才是模型名
  assert.ok(ks['sk-A'] && ks['sk-B'], '应按 callerKey 分桶');
  assert.equal(ks['sk-A']['claude-opus-4-8'].scene_name, '综合最优');
  assert.equal(ks['sk-B']['claude-opus-4-8'].scene_name, '免费源');
  // free 路由带 tier 过滤，auto 不带 —— 证明两桶独立
  assert.equal(ks['sk-A']['claude-opus-4-8'].tier, undefined);
  assert.equal(ks['sk-B']['claude-opus-4-8'].tier, 'free');
});

test('策略/过滤路由（空 steps）也能绑，且带上 flow/scope/tier', () => {
  const ks = {};
  bindClaudeRoutesToKeyScene(ks, 'sk-P', ['llm-router-personal'], ROUTES, CMS);
  const scene = ks['sk-P']['claude-opus-4-8'];
  assert.equal(scene.flow, 'auto');
  assert.equal(scene.scope, 'personal');
});

test('无 callerKey / 无 routeIds → 不写入（防止污染全局）', () => {
  const ks = {};
  bindClaudeRoutesToKeyScene(ks, '', ['llm-router-auto'], ROUTES, CMS);
  bindClaudeRoutesToKeyScene(ks, 'sk-C', [], ROUTES, CMS);
  assert.deepEqual(Object.keys(ks), []);
});

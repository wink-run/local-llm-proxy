'use strict';
// keyScene per-app 分桶：多个 claude 应用（Desktop / 多个 CLI 实例）按 callerKey 各绑各的路由，互不覆盖。
// 这是「多 CLI 实例按目录绑不同路由」功能的地基。
const { test } = require('node:test');
const assert = require('node:assert');
const { bindClaudeRoutesToKeyScene, bindClaudeCliRouteToKeyScene } = require('../../shared/route-binding');

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

// CLI shim（api-key 调用方）：客户端发任意 claude-* 名，单条 route 必须绑到「所有」claude 名，
// 否则只有 cms[0] 命中、claude-sonnet-4-5 等落到 404（多账号 CLI 路由不生效的根因）。
test('bindClaudeCliRouteToKeyScene：单 route 绑到全部 claude 名（含 sonnet/haiku）', () => {
  const ks = {};
  bindClaudeCliRouteToKeyScene(ks, 'sk-CLI', 'p2p:minimax-m2.7', [], CMS);
  for (const name of CMS) {
    assert.ok(ks['sk-CLI'][name], `${name} 应被绑定`);
    assert.equal(ks['sk-CLI'][name].steps[0].model, 'minimax-m2.7');
    assert.equal(ks['sk-CLI'][name].steps[0].tier, 'p2p');
  }
  // 通配兜底：列表外的后台/快速模型名（claude-3-5-haiku-20241022 等）靠 '*' 命中
  assert.ok(ks['sk-CLI']['*'], "应有通配 '*' 兜底");
  assert.equal(ks['sk-CLI']['*'].steps[0].model, 'minimax-m2.7');
});

test('bindClaudeCliRouteToKeyScene：无 key / 无 route → 不写入；有 key+route 即使无模型名也绑通配', () => {
  const ks = {};
  bindClaudeCliRouteToKeyScene(ks, '', 'p2p:x', [], CMS);   // 无 key
  bindClaudeCliRouteToKeyScene(ks, 'sk-X', '', [], CMS);     // 无 route
  assert.deepEqual(Object.keys(ks), [], '无 key/无 route 不写入');
  const ks2 = {};
  bindClaudeCliRouteToKeyScene(ks2, 'sk-Y', 'p2p:x', [], []);   // 无模型名 → 仍绑通配 '*'
  assert.deepEqual(Object.keys(ks2['sk-Y'] || {}), ['*']);
});

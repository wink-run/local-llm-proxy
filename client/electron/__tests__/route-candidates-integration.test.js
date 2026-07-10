'use strict';
// 候选筛选(tier/model) + 链级流转(flow) 集成测试：注入假供给源，驱动真实候选构建/排序。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const gw = require('../local-gateway');
const { buildStrategyCandidates, orderStepsByFlow } = gw;

// 假源：付费 glm-5(payg) / 免费 glm-5+qwen / 付费 gpt-4o(payg)
const CFG = { providers: [
  { id: 'paidglm', type: 'paid', enabled: true, base_url: 'http://p', source: 'payg', models: [{ name: 'glm-5', type: 'chat' }] },
  { id: 'freeglm', type: 'free', enabled: true, base_url: 'http://f',                 models: [{ name: 'glm-5', type: 'chat' }, { name: 'qwen', type: 'chat' }] },
  { id: 'paidgpt', type: 'paid', enabled: true, base_url: 'http://g', source: 'payg', models: [{ name: 'gpt-4o', type: 'chat' }] },
] };
const RP = '/v1/chat/completions';

before(() => { gw.start(19871, () => CFG, null); });   // 空闲端口注入 _getConfig
after(() => { gw.stop(); });

const ids = (cands) => cands.map(c => c.providerId).sort();
const models = (cands) => [...new Set(cands.map(c => c.model))].sort();

test('tier=paid → 只出付费源的模型(glm-5@paidglm, gpt-4o@paidgpt)', () => {
  const c = buildStrategyCandidates('fallback', { tier: 'paid' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['paidglm', 'paidgpt']);
  assert.ok(c.every(x => x.providerTier === 'paid'));
});

test('tier=free → 只出免费源(glm-5, qwen @freeglm)', () => {
  const c = buildStrategyCandidates('fallback', { tier: 'free' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['freeglm', 'freeglm']);
  assert.deepStrictEqual(models(c), ['glm-5', 'qwen']);
});

test('model=glm-5 → 该模型的所有源(付费 + 免费两条)', () => {
  const c = buildStrategyCandidates('fallback', { model: 'glm-5' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['freeglm', 'paidglm']);
});

test('tier=paid + model=glm-5 → 只 glm-5 的付费源', () => {
  const c = buildStrategyCandidates('fallback', { tier: 'paid', model: 'glm-5' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['paidglm']);
});

test('strategy=cost → 免费源(rank0)排在付费源(rank4)前', () => {
  const c = buildStrategyCandidates('cost', { model: 'glm-5' }, RP, false, 'k');
  assert.strictEqual(c[0].providerId, 'freeglm');   // 免费最便宜，最前
  assert.strictEqual(c[c.length - 1].providerId, 'paidglm');
});

test('flow=cost：把"最便宜的步"排到前面（免费步 → 付费步）', () => {
  const steps = [
    { model: 'glm-5', tier: 'paid' },   // 步0：付费
    { model: 'glm-5', tier: 'free' },   // 步1：免费（更便宜）
  ];
  const ordered = orderStepsByFlow(steps, 'cost', RP, false);
  assert.strictEqual(ordered[0].tier, 'free');   // 免费步被排到最前
  assert.strictEqual(ordered[1].tier, 'paid');
});

test('flow=fallback：步序不变（原顺序）', () => {
  const steps = [{ model: 'glm-5', tier: 'paid' }, { model: 'glm-5', tier: 'free' }];
  const ordered = orderStepsByFlow(steps, 'fallback', RP, false);
  assert.strictEqual(ordered[0].tier, 'paid');
  assert.strictEqual(ordered[1].tier, 'free');
});

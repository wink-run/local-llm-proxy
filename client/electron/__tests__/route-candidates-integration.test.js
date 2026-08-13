'use strict';
// 候选筛选(tier/model) + 链级流转(flow) 集成测试：注入假供给源，驱动真实候选构建/排序。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const gw = require('../local-gateway');
const { buildStrategyCandidates, orderStepsByFlow } = gw;

// 假源：付费 glm-5(payg) / 免费 glm-5+qwen / 付费 gpt-4o(payg) / 订阅 glm-5
const CFG = { providers: [
  { id: 'paidglm', type: 'paid', enabled: true, base_url: 'http://p', source: 'payg', models: [{ name: 'glm-5', type: 'chat' }] },
  { id: 'freeglm', type: 'free', enabled: true, base_url: 'http://f',                 models: [{ name: 'glm-5', type: 'chat' }, { name: 'qwen', type: 'chat' }] },
  { id: 'paidgpt', type: 'paid', enabled: true, base_url: 'http://g', source: 'payg', models: [{ name: 'gpt-4o', type: 'chat' }] },
  { id: 'subglm', type: 'paid', enabled: true, base_url: 'http://s', source: 'subscription', models: [{ name: 'glm-5', type: 'chat' }] },
] };
const RP = '/v1/chat/completions';

before(() => { gw.start(19871, () => CFG, null); });   // 空闲端口注入 _getConfig
after(() => { gw.stop(); });

const ids = (cands) => cands.map(c => c.providerId).sort();
const models = (cands) => [...new Set(cands.map(c => c.model))].sort();

test('tier=paid → 只出付费源的模型(glm-5@paidglm/subglm, gpt-4o@paidgpt)', () => {
  const c = buildStrategyCandidates('fallback', { tier: 'paid' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['paidglm', 'paidgpt', 'subglm']);
  assert.ok(c.every(x => x.providerTier === 'paid'));
});

test('tier=free → 只出免费源(glm-5, qwen @freeglm)', () => {
  const c = buildStrategyCandidates('fallback', { tier: 'free' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['freeglm', 'freeglm']);
  assert.deepStrictEqual(models(c), ['glm-5', 'qwen']);
});

test('model=glm-5 → 该模型的所有源(订阅 + 付费 + 免费)', () => {
  const c = buildStrategyCandidates('fallback', { model: 'glm-5' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['freeglm', 'paidglm', 'subglm']);
});

test('tier=paid + model=glm-5 → 只 glm-5 的付费/订阅源', () => {
  const c = buildStrategyCandidates('fallback', { tier: 'paid', model: 'glm-5' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['paidglm', 'subglm']);
});

test('strategy=cost → 订阅 → 免费 → 按量', () => {
  const c = buildStrategyCandidates('cost', { model: 'glm-5' }, RP, false, 'k');
  assert.strictEqual(c[0].providerId, 'subglm');
  assert.strictEqual(c[1].providerId, 'freeglm');
  assert.strictEqual(c[2].providerId, 'paidglm');
});

test('flow=cost：把"最便宜的步"排到前面（免费步 → 付费步）', () => {
  const steps = [
    { model: 'glm-5', tier: 'paid' },   // 步0：付费（含订阅）
    { model: 'glm-5', tier: 'free' },   // 步1：免费
  ];
  const ordered = orderStepsByFlow(steps, 'cost', RP, false);
  // 付费步里有订阅源，代表候选是订阅 → 仍排在免费前
  assert.strictEqual(ordered[0].tier, 'paid');
  assert.strictEqual(ordered[1].tier, 'free');
});

test('flow=fallback：步序不变（原顺序）', () => {
  const steps = [{ model: 'glm-5', tier: 'paid' }, { model: 'glm-5', tier: 'free' }];
  const ordered = orderStepsByFlow(steps, 'fallback', RP, false);
  assert.strictEqual(ordered[0].tier, 'paid');
  assert.strictEqual(ordered[1].tier, 'free');
});

'use strict';
// 分层路由 codec 单测：encodeRoute / parseRoute。
const { test } = require('node:test');
const assert = require('node:assert');
const { encodeRoute, parseRoute } = require('../../shared/route-binding');

test('parseRoute: 单段裸模型', () => {
  assert.deepStrictEqual(parseRoute('glm-5'),
    { strategy: null, tier: null, sharer: null, provider: null, model: 'glm-5' });
});

test('parseRoute: 单段纯策略（全局）', () => {
  assert.strictEqual(parseRoute('auto').strategy, 'auto');
  assert.strictEqual(parseRoute('auto').model, null);
  assert.strictEqual(parseRoute('cost').strategy, 'cost');
});

test('parseRoute: 单段纯 tier / 纯 sharer（全局）', () => {
  assert.strictEqual(parseRoute('paid').tier, 'paid');
  assert.strictEqual(parseRoute('paid').model, null);
  assert.strictEqual(parseRoute('s_a1b2c3').sharer, 's_a1b2c3');
  assert.strictEqual(parseRoute('s_a1b2c3').model, null);
});

test('parseRoute: tier + model', () => {
  assert.deepStrictEqual(parseRoute('paid:glm-5'),
    { strategy: null, tier: 'paid', sharer: null, provider: null, model: 'glm-5' });
});

test('parseRoute: strategy + model', () => {
  const r = parseRoute('auto:glm-5');
  assert.strictEqual(r.strategy, 'auto');
  assert.strictEqual(r.model, 'glm-5');
  assert.strictEqual(r.tier, null);
});

test('parseRoute: strategy + tier + model', () => {
  assert.deepStrictEqual(parseRoute('auto:paid:glm-5'),
    { strategy: 'auto', tier: 'paid', sharer: null, provider: null, model: 'glm-5' });
});

test('parseRoute: sharer + model（钉分享者）', () => {
  const r = parseRoute('s_a1b2c3:glm-5');
  assert.strictEqual(r.sharer, 's_a1b2c3');
  assert.strictEqual(r.model, 'glm-5');
});

test('parseRoute: strategy + provider + model', () => {
  const r = parseRoute('cost:openrouter:glm-5');
  assert.strictEqual(r.strategy, 'cost');
  assert.strictEqual(r.provider, 'openrouter');
  assert.strictEqual(r.model, 'glm-5');
});

test('parseRoute: 全五层', () => {
  assert.deepStrictEqual(parseRoute('auto:paid:s_a1b2c3:openrouter:glm-5'),
    { strategy: 'auto', tier: 'paid', sharer: 's_a1b2c3', provider: 'openrouter', model: 'glm-5' });
});

test('parseRoute: 空/无效输入', () => {
  const empty = { strategy: null, tier: null, sharer: null, provider: null, model: null };
  assert.deepStrictEqual(parseRoute(''), empty);
  assert.deepStrictEqual(parseRoute(null), empty);
  assert.deepStrictEqual(parseRoute(undefined), empty);
});

test('encodeRoute: 固定顺序 + 跳过空层', () => {
  assert.strictEqual(encodeRoute({ model: 'glm-5' }), 'glm-5');
  assert.strictEqual(encodeRoute({ tier: 'paid', model: 'glm-5' }), 'paid:glm-5');
  assert.strictEqual(encodeRoute({ strategy: 'auto', tier: 'paid', model: 'glm-5' }), 'auto:paid:glm-5');
  assert.strictEqual(encodeRoute({ sharer: 's_a1b2c3', model: 'glm-5' }), 's_a1b2c3:glm-5');
  assert.strictEqual(encodeRoute({ strategy: 'auto' }), 'auto');
  assert.strictEqual(encodeRoute({}), '');
  // 顺序无关：即使乱序传入，输出仍是 strategy:tier:sharer:provider:model
  assert.strictEqual(
    encodeRoute({ model: 'glm-5', provider: 'openrouter', tier: 'paid', strategy: 'auto', sharer: 's_x1' }),
    'auto:paid:s_x1:openrouter:glm-5');
});

test('round-trip: parse(encode(x)) === x（规范输入）', () => {
  const cases = [
    { strategy: null, tier: null, sharer: null, provider: null, model: 'glm-5' },
    { strategy: 'auto', tier: 'paid', sharer: null, provider: null, model: 'glm-5' },
    { strategy: 'cost', tier: null, sharer: null, provider: 'openrouter', model: 'glm-5' },
    { strategy: null, tier: null, sharer: 's_a1b2c3', provider: null, model: 'glm-5' },
    { strategy: 'auto', tier: 'paid', sharer: 's_a1b2c3', provider: 'openrouter', model: 'glm-5' },
    { strategy: 'auto', tier: null, sharer: null, provider: null, model: null },
  ];
  for (const c of cases) {
    const clean = {};
    for (const k of ['strategy', 'tier', 'sharer', 'provider', 'model']) clean[k] = c[k] || null;
    assert.deepStrictEqual(parseRoute(encodeRoute(c)), clean, JSON.stringify(c));
  }
});

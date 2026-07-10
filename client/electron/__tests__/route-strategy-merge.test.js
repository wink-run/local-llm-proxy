'use strict';
// 统一路由：策略路由检测 stratStepOf（route-level strategy 兼容 + 单步 strategy-only）。
const { test } = require('node:test');
const assert = require('node:assert');
const { stratStepOf, encodeRouteHeader } = require('../local-gateway');

test('stratStepOf: route-level strategy（旧写法，兼容）', () => {
  assert.deepStrictEqual(stratStepOf({ strategy: 'cost' }),
    { strategy: 'cost', tier: null, provider: null, sharer: null });
});

test('stratStepOf: 单步 strategy-only（统一新写法）', () => {
  assert.deepStrictEqual(stratStepOf({ steps: [{ strategy: 'auto' }] }),
    { strategy: 'auto', tier: null, provider: null, sharer: null });
});

test('stratStepOf: 单步 strategy 带 tier/provider/sharer 过滤', () => {
  assert.deepStrictEqual(
    stratStepOf({ steps: [{ strategy: 'auto', tier: 'paid', provider: 'openrouter', sharer: 's_a1b2c3' }] }),
    { strategy: 'auto', tier: 'paid', provider: 'openrouter', sharer: 's_a1b2c3' });
});

test('stratStepOf: 有 model 的步 → 不是策略路由', () => {
  assert.strictEqual(stratStepOf({ steps: [{ model: 'glm-5' }] }), null);
  assert.strictEqual(stratStepOf({ steps: [{ model: 'glm-5', strategy: 'auto' }] }), null);
});

test('stratStepOf: 多步 → 不是（单步策略）路由，走场景链', () => {
  assert.strictEqual(stratStepOf({ steps: [{ strategy: 'auto' }, { model: 'deepseek' }] }), null);
});

test('stratStepOf: 带 rules 的路由 → null（走规则分支，不被单步策略短路）', () => {
  assert.strictEqual(
    stratStepOf({ steps: [{ strategy: 'auto' }], rules: [{ when: { type: 'input_tokens', op: 'gt', value: 50000 }, steps: [] }] }),
    null);
});

test('stratStepOf: 空/无效', () => {
  assert.strictEqual(stratStepOf(null), null);
  assert.strictEqual(stratStepOf({}), null);
  assert.strictEqual(stratStepOf({ steps: [] }), null);
});

test('encodeRouteHeader: strategy/sharer → X-TB-Route 值', () => {
  assert.strictEqual(encodeRouteHeader({ strategy: 'auto', sharer: 's_a1b2c3' }), 'strategy=auto;sharer=s_a1b2c3');
  assert.strictEqual(encodeRouteHeader({ strategy: 'auto', sharer: null }), 'strategy=auto');
  assert.strictEqual(encodeRouteHeader({ strategy: null, sharer: null }), '');
  assert.strictEqual(encodeRouteHeader(null), '');
});

'use strict';
// 分层路由 codec 单测：encodeRoute / parseRoute。
const { test } = require('node:test');
const assert = require('node:assert');
const { encodeRoute, parseRoute } = require('../../shared/route-binding');

const EMPTY = { strategy: null, scope: null, tier: null, sharer: null, provider: null, model: null };
const withDefaults = (o) => ({ ...EMPTY, ...o });

test('parseRoute: 单段裸模型', () => {
  assert.deepStrictEqual(parseRoute('glm-5'), withDefaults({ model: 'glm-5' }));
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

test('parseRoute: 单段纯 scope（个人/社区，全局）', () => {
  assert.strictEqual(parseRoute('personal').scope, 'personal');
  assert.strictEqual(parseRoute('personal').model, null);
  assert.strictEqual(parseRoute('community').scope, 'community');
  assert.strictEqual(parseRoute('community').model, null);
});

test('parseRoute: tier + model', () => {
  assert.deepStrictEqual(parseRoute('paid:glm-5'), withDefaults({ tier: 'paid', model: 'glm-5' }));
});

test('parseRoute: strategy + model', () => {
  const r = parseRoute('auto:glm-5');
  assert.strictEqual(r.strategy, 'auto');
  assert.strictEqual(r.model, 'glm-5');
  assert.strictEqual(r.tier, null);
});

test('parseRoute: strategy + tier + model', () => {
  assert.deepStrictEqual(parseRoute('auto:paid:glm-5'),
    withDefaults({ strategy: 'auto', tier: 'paid', model: 'glm-5' }));
});

test('parseRoute: scope + tier + model（个人收费某模型）', () => {
  assert.deepStrictEqual(parseRoute('personal:paid:glm-5'),
    withDefaults({ scope: 'personal', tier: 'paid', model: 'glm-5' }));
});

test('parseRoute: strategy + scope + model（社区某模型）', () => {
  const r = parseRoute('auto:community:glm-5');
  assert.strictEqual(r.strategy, 'auto');
  assert.strictEqual(r.scope, 'community');
  assert.strictEqual(r.model, 'glm-5');
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

// OpenRouter 免费模型 id 带 :free，且含 org/name → 不能把末段 free 当 model
test('parseRoute: tier + OpenRouter :free 模型（含斜杠）', () => {
  assert.deepStrictEqual(
    parseRoute('free:openai/gpt-oss-20b:free'),
    withDefaults({ tier: 'free', model: 'openai/gpt-oss-20b:free' }),
  );
});

test('parseRoute: 裸 OpenRouter :free 模型', () => {
  assert.deepStrictEqual(
    parseRoute('openai/gpt-oss-20b:free'),
    withDefaults({ model: 'openai/gpt-oss-20b:free' }),
  );
});

test('parseRoute: strategy + tier + OpenRouter :free 模型', () => {
  const r = parseRoute('auto:free:meta-llama/llama-3.3-70b-instruct:free');
  assert.strictEqual(r.strategy, 'auto');
  assert.strictEqual(r.tier, 'free');
  assert.strictEqual(r.model, 'meta-llama/llama-3.3-70b-instruct:free');
});

test('parseRoute: 全六层', () => {
  assert.deepStrictEqual(parseRoute('auto:personal:paid:s_a1b2c3:openrouter:glm-5'),
    withDefaults({ strategy: 'auto', scope: 'personal', tier: 'paid', sharer: 's_a1b2c3', provider: 'openrouter', model: 'glm-5' }));
});

test('parseRoute: 空/无效输入', () => {
  assert.deepStrictEqual(parseRoute(''), EMPTY);
  assert.deepStrictEqual(parseRoute(null), EMPTY);
  assert.deepStrictEqual(parseRoute(undefined), EMPTY);
});

test('encodeRoute: 固定顺序 + 跳过空层', () => {
  assert.strictEqual(encodeRoute({ model: 'glm-5' }), 'glm-5');
  assert.strictEqual(encodeRoute({ tier: 'paid', model: 'glm-5' }), 'paid:glm-5');
  assert.strictEqual(encodeRoute({ strategy: 'auto', tier: 'paid', model: 'glm-5' }), 'auto:paid:glm-5');
  assert.strictEqual(encodeRoute({ sharer: 's_a1b2c3', model: 'glm-5' }), 's_a1b2c3:glm-5');
  assert.strictEqual(encodeRoute({ strategy: 'auto' }), 'auto');
  assert.strictEqual(encodeRoute({}), '');
  // scope：来源段，位于 strategy 之后、tier 之前
  assert.strictEqual(encodeRoute({ strategy: 'auto', scope: 'personal', tier: 'free' }), 'auto:personal:free');
  assert.strictEqual(encodeRoute({ strategy: 'auto', scope: 'community' }), 'auto:community');
  // 顺序无关：即使乱序传入，输出仍是 strategy:scope:tier:sharer:provider:model
  assert.strictEqual(
    encodeRoute({ model: 'glm-5', provider: 'openrouter', tier: 'paid', scope: 'personal', strategy: 'auto', sharer: 's_x1' }),
    'auto:personal:paid:s_x1:openrouter:glm-5');
});

test('round-trip: parse(encode(x)) === x（含 model 的规范输入）', () => {
  const cases = [
    { model: 'glm-5' },
    { strategy: 'auto', tier: 'paid', model: 'glm-5' },
    { strategy: 'cost', provider: 'openrouter', model: 'glm-5' },
    { sharer: 's_a1b2c3', model: 'glm-5' },
    { scope: 'personal', tier: 'paid', model: 'glm-5' },
    { strategy: 'auto', scope: 'community', model: 'glm-5' },
    { strategy: 'auto', scope: 'personal', tier: 'paid', sharer: 's_a1b2c3', provider: 'openrouter', model: 'glm-5' },
  ];
  for (const c of cases) {
    assert.deepStrictEqual(parseRoute(encodeRoute(c)), withDefaults(c), JSON.stringify(c));
  }
});

test('legacy: 旧 codec tier=p2p 仍解析为 tier（网关兼容旧数据）', () => {
  const r = parseRoute('auto:p2p:deepseek');
  assert.strictEqual(r.tier, 'p2p');
  assert.strictEqual(r.model, 'deepseek');
});

'use strict';
// 上游适配学习表：报文 set/strip + 与 429 硬错误分流
const { test } = require('node:test');
const assert = require('node:assert');
const hints = require('../gateway-upstream-hints');

test('parseBodyConstraintError：temperature / top_p only N', () => {
  const m = hints.parseBodyConstraintError({
    status: 400,
    message: 'HTTP_400: invalid temperature: only 1 is allowed for this model',
  });
  assert.deepEqual(m.set, { temperature: 1 });

  const top = hints.parseBodyConstraintError({
    message: 'HTTP_400',
    body: '{"error":{"message":"invalid top_p: only 0.95 is allowed for this model"}}',
  });
  assert.equal(top.set.top_p, 0.95);
});

test('parseBodyConstraintError：Extra inputs / Unsupported parameter → strip', () => {
  const a = hints.parseBodyConstraintError({
    status: 400,
    message: 'HTTP_400: context_management: Extra inputs are not permitted',
  });
  assert.deepEqual(a.strip, ['context_management']);

  const b = hints.parseBodyConstraintError({
    message: 'Unsupported parameter: \'n\'',
  });
  assert.deepEqual(b.strip, ['n']);

  const c = hints.parseBodyConstraintError({
    message: '"metadata" is not supported',
  });
  assert.deepEqual(c.strip, ['metadata']);
});

test('parseBodyConstraintError：429/401 等硬错误 → null（交给 cooldown）', () => {
  assert.equal(hints.parseBodyConstraintError({
    status: 429, message: 'HTTP_429: rate limit',
  }), null);
  assert.equal(hints.parseBodyConstraintError({
    status: 401, message: 'HTTP_401: unauthorized',
  }), null);
  assert.equal(hints.parseBodyConstraintError({
    message: 'HTTP_500: boom',
  }), null);
});

test('noteHints + applyHints：set 改写、strip 删除；通配 * 共享 strip', () => {
  hints._resetForTests();
  hints.noteHints('kimi-code', 'k3', { set: { temperature: 1 } });
  hints.noteHints('kimi-code', 'k3', { strip: ['n'] });

  const body = { model: 'k3', temperature: 0, n: 2, messages: [] };
  const fixed = hints.applyHints(body, 'kimi-code', 'k3');
  assert.equal(fixed.temperature, 1);
  assert.equal(fixed.n, undefined);
  assert.equal(fixed.model, 'k3');

  // strip 落到 provider::* → 同供给源其它模型也剥
  const other = hints.applyHints({ model: 'k2', n: 1 }, 'kimi-code', 'k2');
  assert.equal(other.n, undefined);

  // 未带 temperature 不注入
  const bare = { model: 'k3', messages: [] };
  assert.strictEqual(hints.applyHints(bare, 'kimi-code', 'k3'), bare);
});

test('applyMutations：无改动返回原引用', () => {
  hints._resetForTests();
  const body = { temperature: 1 };
  assert.strictEqual(hints.applyMutations(body, { set: { temperature: 1 } }), body);
});

test('旧版 temperature 字段可加载', () => {
  const n = hints._normalizeEntry({ key: 'x::y', temperature: 1 });
  assert.deepEqual(n.set, { temperature: 1 });
});

test('describeMutations', () => {
  assert.ok(hints.describeMutations({ set: { temperature: 1 }, strip: ['n'] }).includes('temperature→1'));
  assert.ok(hints.describeMutations({ set: { temperature: 1 }, strip: ['n'] }).includes('strip:n'));
});

test('hintKey 格式', () => {
  assert.equal(hints.hintKey('kimi-code', 'k3'), 'kimi-code::k3');
});

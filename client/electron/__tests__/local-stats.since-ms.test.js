'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sinceTsForDays, sinceMsForDays } = require('../local-stats');

test('sinceMsForDays 与 sinceTsForDays 差 1000 倍（skill/tool 表用毫秒）', () => {
  const sec = sinceTsForDays(1);
  const ms = sinceMsForDays(1);
  assert.equal(ms, sec * 1000);
  // 秒级约 1e9–2e9；毫秒级约 1e12–2e12，避免「今日」窗口误用秒过滤毫秒列
  assert.ok(sec > 1e9 && sec < 1e11, `unexpected sec ${sec}`);
  assert.ok(ms > 1e12 && ms < 1e14, `unexpected ms ${ms}`);
});

test('多日窗口同样换算为毫秒', () => {
  assert.equal(sinceMsForDays(7), sinceTsForDays(7) * 1000);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tsSeconds } = require('../session-import');

test('tsSeconds: Unix 秒不再被误除 1000', () => {
  assert.equal(tsSeconds(1783157730), 1783157730);
});

test('tsSeconds: 毫秒转为秒', () => {
  assert.equal(tsSeconds(1783157730000), 1783157730);
});

test('tsSeconds: ISO 字符串', () => {
  const sec = tsSeconds('2026-07-04T17:35:30+08:00');
  assert.ok(sec >= 1783157000 && sec <= 1783158000);
});

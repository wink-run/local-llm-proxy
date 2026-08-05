'use strict';
// 兼容：local-gateway 仍导出 parseFixedTemperatureError（薄封装）
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFixedTemperatureError } = require('../local-gateway');

test('parseFixedTemperatureError：识别 Kimi 风格 only N is allowed', () => {
  assert.equal(parseFixedTemperatureError({
    status: 400,
    message: 'HTTP_400: invalid temperature: only 1 is allowed for this model',
  }), 1);
});

test('parseFixedTemperatureError：非 temperature / 硬错误 → null', () => {
  assert.equal(parseFixedTemperatureError({
    message: 'HTTP_400: context_management: Extra inputs are not permitted',
  }), null);
  assert.equal(parseFixedTemperatureError({
    status: 429, message: 'HTTP_429: rate limit',
  }), null);
});

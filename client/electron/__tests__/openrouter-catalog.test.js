'use strict';
// OpenRouter 目录：/models 响应解析 —— id→模型名、pricing(每token美元)→每MTok。
const { test } = require('node:test');
const assert = require('node:assert');
const oc = require('../openrouter-catalog');

test('_parse：抽 id 为模型名、pricing 转每 MTok', () => {
  const { models, pricing } = oc._parse({
    data: [
      { id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'google/gemini-3.6-flash', pricing: { prompt: '0.0000001', completion: '0.0000004' } },
      { id: 'free/model:free', pricing: { prompt: '0', completion: '0' } },
    ],
  });
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], { name: 'anthropic/claude-sonnet-5', type: 'chat' });
  assert.deepEqual(pricing['anthropic/claude-sonnet-5'], { in: 3, out: 15 });        // 0.000003*1e6=3
  assert.deepEqual(pricing['google/gemini-3.6-flash'], { in: 0.1, out: 0.4 });
  assert.deepEqual(pricing['free/model:free'], { in: 0, out: 0 });
});

test('_parse：无 id 跳过；无 pricing 不进价目；空/坏输入不抛', () => {
  const { models, pricing } = oc._parse({
    data: [
      { id: '', pricing: { prompt: '1' } },        // 空 id 跳过
      { id: 'x/y' },                                // 无 pricing → 不进 pricing 表
      { pricing: { prompt: '1' } },                 // 无 id 跳过
    ],
  });
  assert.deepEqual(models.map(m => m.name), ['x/y']);
  assert.equal('x/y' in pricing, false);
  assert.deepEqual(oc._parse(null), { models: [], pricing: {} });
  assert.deepEqual(oc._parse({}), { models: [], pricing: {} });
});

'use strict';
// OpenRouter 目录：/models 响应解析 —— id→模型名、pricing(每token美元)→每MTok。
const { test } = require('node:test');
const assert = require('node:assert');
const oc = require('../openrouter-catalog');

test('_parse：只保留 :free 免费模型，收费模型被过滤', () => {
  const { models, pricing } = oc._parse({
    data: [
      { id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } },   // 收费 → 滤掉
      { id: 'deepseek/deepseek-r1:free', pricing: { prompt: '0', completion: '0' } },                   // 免费 → 留
      { id: 'google/gemini-2.0-flash-exp:free', pricing: { prompt: '0', completion: '0' } },            // 免费 → 留
      { id: 'google/lyria-3-pro-preview', pricing: { prompt: '0', completion: '0' } },                  // 价0但无:free → 滤掉(非真免费聊天)
    ],
  });
  assert.deepEqual(models.map(m => m.name), ['deepseek/deepseek-r1:free', 'google/gemini-2.0-flash-exp:free']);
  assert.deepEqual(pricing['deepseek/deepseek-r1:free'], { in: 0, out: 0 });
  assert.equal('anthropic/claude-sonnet-5' in pricing, false);
});

test('_parse：空 id / 无 id 跳过；空或坏输入不抛', () => {
  const { models } = oc._parse({
    data: [
      { id: '', pricing: { prompt: '0' } },          // 空 id 跳过
      { pricing: { prompt: '0' } },                   // 无 id 跳过
      { id: 'x/y:free' },                             // 免费、无 pricing → 留，但不进价目
    ],
  });
  assert.deepEqual(models.map(m => m.name), ['x/y:free']);
  assert.deepEqual(oc._parse(null), { models: [], pricing: {} });
  assert.deepEqual(oc._parse({}), { models: [], pricing: {} });
});

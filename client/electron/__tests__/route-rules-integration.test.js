'use strict';
// 规则路由集成测试：造几条规则(token/关键字/模态/首个命中优先)，验证 pickSteps 选对链。
const { test } = require('node:test');
const assert = require('node:assert');
const { pickSteps, evalWhen } = require('../local-gateway');

// 一条带多规则的场景路由：长上下文 / 含 GPT / 图像 / 默认
const scene = {
  scene_name: '测试路由',
  steps: [{ model: 'deepseek-chat' }],                         // 默认链
  rules: [
    { when: { type: 'input_tokens', op: 'gt', value: 50000 }, steps: [{ model: 'gemini-2.5-pro' }] },
    { when: { type: 'keyword', op: 'contains', value: 'GPT' }, steps: [{ model: 'gpt-4o' }] },
    { when: { type: 'request_type', op: 'is', value: 'image' }, steps: [{ model: 'dall-e-3' }] },
  ],
};
const modelOf = (steps) => steps.map(s => s.model).join(',');

test('规则1：输入 token > 50000 → 走长上下文链(gemini-2.5-pro)', () => {
  const steps = pickSteps(scene, { input_tokens: 80000, keyword_text: '', modality: 'chat' });
  assert.strictEqual(modelOf(steps), 'gemini-2.5-pro');
});

test('规则2：消息含关键字 GPT → 走 gpt-4o（大小写不敏感）', () => {
  assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 100, keyword_text: '帮我用 gpt 写个函数' })), 'gpt-4o');
  assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 100, keyword_text: 'GPT please' })), 'gpt-4o');
});

test('规则3：图像请求 → 走 dall-e-3', () => {
  assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 100, keyword_text: '', modality: 'image' })), 'dall-e-3');
});

test('都不命中 → 默认链(deepseek-chat)', () => {
  assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 100, keyword_text: '你好', modality: 'chat' })), 'deepseek-chat');
});

test('首个命中优先：同时满足 token>50000 和 含 GPT → 规则1(token)先命中', () => {
  const steps = pickSteps(scene, { input_tokens: 90000, keyword_text: '用 GPT 分析这段长文' });
  assert.strictEqual(modelOf(steps), 'gemini-2.5-pro');
});

test('无规则的场景 → 直接默认链', () => {
  assert.strictEqual(modelOf(pickSteps({ steps: [{ model: 'x' }] }, { input_tokens: 999999 })), 'x');
});

// evalWhen 各 op 覆盖
test('evalWhen: 数值比较 gt/lt/gte/lte', () => {
  assert.strictEqual(evalWhen({ type: 'input_tokens', op: 'gt', value: 100 }, { input_tokens: 200 }), true);
  assert.strictEqual(evalWhen({ type: 'input_tokens', op: 'gt', value: 100 }, { input_tokens: 50 }), false);
  assert.strictEqual(evalWhen({ type: 'input_tokens', op: 'lte', value: 100 }, { input_tokens: 100 }), true);
});

test('evalWhen: keyword contains / match(正则)', () => {
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'contains', value: 'python' }, { keyword_text: '写段 Python 代码' }), true);
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'match', value: '^bug' }, { keyword_text: 'BUG in auth' }), true);
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'contains', value: 'java' }, { keyword_text: '写段 python' }), false);
});

test('evalWhen: in（枚举）/ is / not', () => {
  assert.strictEqual(evalWhen({ type: 'model', op: 'in', value: ['gpt-4o', 'claude'] }, { model: 'gpt-4o' }), true);
  assert.strictEqual(evalWhen({ type: 'request_type', op: 'is', value: 'image' }, { modality: 'image' }), true);
  assert.strictEqual(evalWhen({ type: 'request_type', op: 'not', value: 'image' }, { modality: 'chat' }), true);
});

test('evalWhen: 无效/缺字段 → false，不抛', () => {
  assert.strictEqual(evalWhen(null, {}), false);
  assert.strictEqual(evalWhen({ type: 'unknown' }, {}), false);
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'match', value: '[' }, { keyword_text: 'x' }), false); // 坏正则不抛
});

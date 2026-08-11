'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveProvider, getAdapter } = require('../handlers/imageHandler');

// 硅基流动：模型 id 为 org/name（斜杠是模型名一部分，不是 providerId）
const SILICONFLOW = {
  id: 'siliconflow',
  type: 'paid',
  token: 'sk-x',
  base_url: 'https://api.siliconflow.cn/v1',
  models: [
    { name: 'qwen/qwen-image.online.image-cnt', type: 'image' },
    { name: 'tongyi-mai/z-image-turbo.online.image-cnt', type: 'image' },
  ],
};

test('resolveProvider：org/model 生图名命中 siliconflow（不误拆 qwen 为 provider）', () => {
  const r = resolveProvider('qwen/qwen-image.online.image-cnt', [SILICONFLOW]);
  assert.ok(r, '应命中 siliconflow');
  assert.equal(r.provider.id, 'siliconflow');
  // 完整模型名原样传给上游，不要剥掉 qwen/
  assert.equal(r.model, 'qwen/qwen-image.online.image-cnt');
});

test('resolveProvider：paid: 前缀剥离后仍能按全名命中', () => {
  // handleImageGeneration 会先剥 paid:，这里模拟剥完后的入参
  const r = resolveProvider('tongyi-mai/z-image-turbo.online.image-cnt', [SILICONFLOW]);
  assert.ok(r);
  assert.equal(r.provider.id, 'siliconflow');
  assert.equal(r.model, 'tongyi-mai/z-image-turbo.online.image-cnt');
});

test('resolveProvider：真实 providerId/model 仍优先按 id 拆分', () => {
  const openai = {
    id: 'openai',
    type: 'paid',
    token: 'sk-o',
    base_url: 'https://api.openai.com/v1',
    models: [{ name: 'dall-e-3', type: 'image' }],
  };
  const r = resolveProvider('openai/dall-e-3', [openai, SILICONFLOW]);
  assert.ok(r);
  assert.equal(r.provider.id, 'openai');
  assert.equal(r.model, 'dall-e-3');
});

test('getAdapter：siliconflow 走 OpenAI 兼容 /images/generations', () => {
  const a = getAdapter(SILICONFLOW);
  assert.ok(a);
  assert.equal(
    a.buildUrl('qwen/qwen-image.online.image-cnt', SILICONFLOW),
    'https://api.siliconflow.cn/v1/images/generations',
  );
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  getAdapter,
  resolveProvider,
  needsRatioResolution,
} = require('../handlers/imageHandler');

// 目录条目：handler=jimeng-api，与通用 OpenAI 图像路径解耦
const PROVIDER = {
  id: 'jimeng-api',
  type: 'free',
  handler: 'jimeng-api',
  api_format: 'openai',
  token: 'sk-x',
  base_url: 'http://localhost:5100/v1',
  models: [
    { name: 'jimeng-5.0', type: 'image' },
    { name: 'jimeng-4.5', type: 'image' },
    { name: 'nanobanana', type: 'image' },
    { name: 'nanobananapro', type: 'image' },
  ],
};

test('jimeng-api 不走 needsRatioResolution 通用分支（独立 BODY_CONFIGS）', () => {
  // 特化由 BODY_CONFIGS.match(handler/id) 负责，避免与 openai.buildBody 耦合
  assert.equal(needsRatioResolution(PROVIDER, 'jimeng-5.0'), false);
  assert.equal(needsRatioResolution({ id: 'openai' }, 'dall-e-3'), false);
});

test('getAdapter 按 handler=jimeng-api 命中特化适配', () => {
  const a = getAdapter(PROVIDER);
  assert.ok(a);
  const url = a.buildUrl('jimeng-5.0', PROVIDER);
  assert.equal(url, 'http://localhost:5100/v1/images/generations');
});

test('buildUrl 自动补 /v1', () => {
  const p = { ...PROVIDER, base_url: 'http://localhost:5100' };
  assert.equal(getAdapter(p).buildUrl('m', p), 'http://localhost:5100/v1/images/generations');
});

test('buildBody 省略 size；显式 size 转 ratio/resolution', () => {
  const a = getAdapter(PROVIDER);
  const plain = a.buildBody('jimeng-5.0', {
    prompt: '一只可爱的狗',
    n: 1,
    response_format: 'b64_json',
  }, PROVIDER);
  assert.equal(plain.model, 'jimeng-5.0');
  assert.equal(plain.prompt, '一只可爱的狗');
  assert.equal(plain.n, 1);
  assert.equal(plain.response_format, 'b64_json');
  assert.ok(!('size' in plain), 'size must NOT be sent (upstream rejects it)');

  const withSize = a.buildBody('nanobanana', {
    prompt: 'cat',
    size: '1024x768',
    response_format: 'b64_json',
  }, PROVIDER);
  assert.ok(!('size' in withSize));
  assert.equal(withSize.ratio, '4:3');
  assert.equal(withSize.resolution, '1k');
});

test('buildBody 透传显式 ratio/resolution', () => {
  const body = getAdapter(PROVIDER).buildBody('jimeng-4.5', {
    prompt: 'p',
    ratio: '16:9',
    resolution: '2k',
    response_format: 'b64_json',
  }, PROVIDER);
  assert.equal(body.ratio, '16:9');
  assert.equal(body.resolution, '2k');
  assert.ok(!('size' in body));
});

test('resolveProvider 按模型列表命中 jimeng-api', () => {
  const r = resolveProvider('jimeng-5.0', [PROVIDER]);
  assert.ok(r);
  assert.equal(r.provider.id, 'jimeng-api');
  assert.equal(r.model, 'jimeng-5.0');
});

test('resolveProvider 支持 jimeng-api/model 与 tier 前缀剥离后查找', () => {
  const r = resolveProvider('jimeng-api/nanobananapro', [PROVIDER]);
  assert.equal(r.provider.id, 'jimeng-api');
  assert.equal(r.model, 'nanobananapro');
});

test('通用 openai provider 不会因模型名误用 jimeng body', () => {
  const openai = {
    id: 'openai',
    handler: 'openai',
    base_url: 'https://api.openai.com/v1',
    token: 'sk',
  };
  const body = getAdapter(openai).buildBody('dall-e-3', {
    prompt: 'cat',
    response_format: 'b64_json',
  }, openai);
  // 标准 OpenAI 仍默认带 size
  assert.equal(body.size, '1024x1024');
});

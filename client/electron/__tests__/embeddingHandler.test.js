'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProvider, buildEmbeddingsUrl } = require('../handlers/embeddingHandler');

const VOLC = {
  id: 'volcengine',
  type: 'paid',
  base_url: 'https://ark.cn-beijing.volces.com/api/v3',
  models: [{ name: 'doubao-embedding-vision', type: 'embedding' }],
};
const OPENAI = {
  id: 'openai',
  type: 'paid',
  embedding: true,
  base_url: 'https://api.openai.com/v1',
  models: ['text-embedding-3-small'],
};

test('resolveProvider：paid:volcengine:doubao-embedding-vision 钉选火山', () => {
  const r = resolveProvider('paid:volcengine:doubao-embedding-vision', [OPENAI, VOLC]);
  assert.equal(r.provider.id, 'volcengine');
  assert.equal(r.model, 'doubao-embedding-vision');
});

test('resolveProvider：按模型列表命中，不误选首个 embedding 源', () => {
  const r = resolveProvider('doubao-embedding-vision', [OPENAI, VOLC]);
  assert.equal(r.provider.id, 'volcengine');
  assert.equal(r.model, 'doubao-embedding-vision');
});

test('resolveProvider：providerId/model 斜杠格式', () => {
  const r = resolveProvider('openai/text-embedding-3-small', [VOLC, OPENAI]);
  assert.equal(r.provider.id, 'openai');
  assert.equal(r.model, 'text-embedding-3-small');
});

test('buildEmbeddingsUrl：方舟 /api/v3 不重复拼 /v1', () => {
  assert.equal(
    buildEmbeddingsUrl('https://ark.cn-beijing.volces.com/api/v3/'),
    'https://ark.cn-beijing.volces.com/api/v3/embeddings',
  );
});

test('buildEmbeddingsUrl：无版本段时补 /v1/embeddings', () => {
  assert.equal(
    buildEmbeddingsUrl('https://api.example.com'),
    'https://api.example.com/v1/embeddings',
  );
});

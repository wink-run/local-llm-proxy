'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveProvider, getAdapter } = require('../handlers/imageHandler');

const P2P = {
  id: 'tokenbank-p2p',
  type: 'p2p',
  token: 'sk-cloud',
  base_url: 'https://tb.example.com',
  // 网关注入的 peer 列表多为裸字符串（无 type）
  models: ['gemini-2.5-flash-image', 'gpt-image-2', 'claude-sonnet-4-6'],
};

test('resolveProvider：p2p 裸字符串模型可命中生图', () => {
  const r = resolveProvider('gemini-2.5-flash-image', [P2P]);
  assert.ok(r, '应命中 p2p provider');
  assert.equal(r.provider.id, 'tokenbank-p2p');
  assert.equal(r.model, 'gemini-2.5-flash-image');
});

test('resolveProvider：tier 过滤后仅剩 p2p 仍可命中', () => {
  const providers = [P2P].filter(p => p.type === 'p2p');
  const r = resolveProvider('gemini-2.5-flash-image', providers);
  assert.ok(r);
  assert.equal(r.provider.type, 'p2p');
});

test('resolveProvider：不在 peer 列表的模型不误选 p2p', () => {
  const r = resolveProvider('unknown-image-model', [P2P]);
  assert.equal(r, null);
});

test('getAdapter：p2p base_url 无版本段时补 /v1', () => {
  const url = getAdapter(P2P).buildUrl('gemini-2.5-flash-image', P2P);
  assert.equal(url, 'https://tb.example.com/v1/images/generations');
});

test('getAdapter：p2p base_url 已含 /v1 不重复', () => {
  const p = { ...P2P, base_url: 'https://tb.example.com/v1' };
  assert.equal(getAdapter(p).buildUrl('m', p), 'https://tb.example.com/v1/images/generations');
});

test('listP2pImageFailoverModels：首选在前，其它生图名跟后', () => {
  const { listP2pImageFailoverModels } = require('../handlers/imageHandler');
  const names = listP2pImageFailoverModels(P2P, 'gemini-2.5-flash-image');
  assert.equal(names[0], 'gemini-2.5-flash-image');
  assert.ok(names.includes('gpt-image-2'));
  assert.ok(!names.includes('claude-sonnet-4-6'), '对话模型不应进生图 failover');
});

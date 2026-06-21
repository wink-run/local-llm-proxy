'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { _providerTier } = require('../local-gateway');

test('explicit tier wins', () => {
  assert.equal(_providerTier({ id: 'x', tier: 'free', token: 't', base_url: 'https://api.x.com' }), 'free');
});

test('type:free is honored even with token + remote URL (the Agnes AI bug)', () => {
  // 免费供给源带 API key + 远程 URL，仍应记为 free，不被兜底判成 paid
  assert.equal(_providerTier({
    id: 'agnes-ai', type: 'free', token: 'sk-x', base_url: 'https://apihub.agnes-ai.com/v1',
  }), 'free');
});

test('type:paid and type:p2p honored', () => {
  assert.equal(_providerTier({ id: 'y', type: 'paid' }), 'paid');
  assert.equal(_providerTier({ id: 'z', type: 'p2p' }), 'p2p');
  assert.equal(_providerTier('tokenbank-p2p'), 'p2p');
});

test('falls back to paid for token + remote URL when no type/tier', () => {
  assert.equal(_providerTier({ id: 'custom', token: 't', base_url: 'https://api.custom.com' }), 'paid');
});

test('known paid id by string', () => {
  assert.equal(_providerTier('openai'), 'paid');
});

test('local URL or no token → free', () => {
  assert.equal(_providerTier({ id: 'ollama', base_url: 'http://127.0.0.1:11434' }), 'free');
  assert.equal(_providerTier(null), 'free');
});

'use strict';
// Responses 原生透传判定 + ChatGPT Codex backend URL 拼装
const { test } = require('node:test');
const assert = require('node:assert');
const {
  providerSupportsResponses, resolveUpstreamUrl, providerApiFormat,
} = require('../local-gateway');

test('providerSupportsResponses：官方 OpenAI / Codex OAuth / 显式标记', () => {
  assert.equal(providerSupportsResponses({
    id: 'openai', base_url: 'https://api.openai.com/v1', api_format: 'openai',
  }), true);
  assert.equal(providerSupportsResponses({
    id: 'x', base_url: 'https://api.openai.com/v1',
  }), true);
  assert.equal(providerSupportsResponses({
    id: 'codex', auth_type: 'oauth', oauth_provider: 'codex',
    base_url: 'https://api.openai.com/v1',
  }), true);
  assert.equal(providerSupportsResponses({
    id: 'custom', supports_responses: true, base_url: 'https://proxy.example/v1',
  }), true);
  assert.equal(providerSupportsResponses({
    id: 'custom', api_format: 'responses', base_url: 'https://proxy.example/v1',
  }), true);
});

test('providerSupportsResponses：普通 OpenAI 兼容 / Anthropic 不透传', () => {
  assert.equal(providerSupportsResponses({
    id: 'groq', base_url: 'https://api.groq.com/openai/v1', api_format: 'openai',
  }), false);
  assert.equal(providerSupportsResponses({
    id: 'ollama', base_url: 'http://127.0.0.1:11434/v1', api_format: 'openai',
  }), false);
  assert.equal(providerSupportsResponses({
    id: 'openai-compatible', base_url: 'https://fp.example.com/v1', api_format: 'openai',
  }), false);
  // 显式关闭优先于 URL 启发
  assert.equal(providerSupportsResponses({
    id: 'openai', base_url: 'https://api.openai.com/v1', supports_responses: false,
  }), false);
  assert.equal(providerSupportsResponses(null), false);
});

test('resolveUpstreamUrl：官方 OpenAI 保留 /v1/responses', () => {
  assert.equal(
    resolveUpstreamUrl('https://api.openai.com/v1', '/v1/responses'),
    'https://api.openai.com/v1/responses',
  );
  assert.equal(
    resolveUpstreamUrl('https://api.openai.com/v1', '/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions',
  );
});

test('resolveUpstreamUrl：ChatGPT Codex backend 用 /responses（无 v1）', () => {
  assert.equal(
    resolveUpstreamUrl('https://chatgpt.com/backend-api/codex', '/v1/responses'),
    'https://chatgpt.com/backend-api/codex/responses',
  );
  assert.equal(
    resolveUpstreamUrl('https://chatgpt.com/backend-api/codex/', '/responses'),
    'https://chatgpt.com/backend-api/codex/responses',
  );
});

test('providerApiFormat 仍按 api_format / URL 启发', () => {
  assert.equal(providerApiFormat({ api_format: 'anthropic' }), 'anthropic');
  assert.equal(providerApiFormat({ base_url: 'https://api.anthropic.com' }), 'anthropic');
  assert.equal(providerApiFormat({ base_url: 'https://api.openai.com/v1' }), 'openai');
});

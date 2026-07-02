'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFeatures, _internal: { matchRule } } = require('../request-router');

test('extractFeatures 识别 anthropic 协议', () => {
  const feat = extractFeatures({ model: 'claude-3-opus' }, 'agent-1', '/v1/messages');
  assert.equal(feat.protocol, 'anthropic');
  assert.equal(feat.model_family, 'claude');
  assert.equal(feat.agent_id, 'agent-1');
});

test('extractFeatures 识别 openai 协议与 stream', () => {
  const feat = extractFeatures({ model: 'gpt-4o', stream: true, messages: [] }, null, '/v1/chat/completions');
  assert.equal(feat.protocol, 'openai');
  assert.equal(feat.model_family, 'gpt');
  assert.equal(feat.stream, true);
  assert.equal(feat.agent_id, null);
});

test('matchRule 空条件匹配所有', () => {
  assert.equal(matchRule({ protocol: 'openai' }, {}), true);
});

test('matchRule 精确匹配与数组匹配', () => {
  const feat = { protocol: 'openai', model_family: 'gpt', stream: false };
  assert.equal(matchRule(feat, { protocol: 'openai' }), true);
  assert.equal(matchRule(feat, { protocol: 'anthropic' }), false);
  assert.equal(matchRule(feat, { model_family: ['gpt', 'claude'] }), true);
  assert.equal(matchRule(feat, { model_family: ['claude'] }), false);
});

test('matchRule 范围匹配 context_length', () => {
  const feat = { context_length: 500 };
  assert.equal(matchRule(feat, { context_length: { gte: 100, lte: 1000 } }), true);
  assert.equal(matchRule(feat, { context_length: { gt: 500 } }), false);
});

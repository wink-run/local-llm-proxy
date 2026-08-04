'use strict';
// Codex reasoning.summary 为 [{type:'summary_text',text}] 时不能 String() → [object Object]
const { test } = require('node:test');
const assert = require('node:assert');
const { codexReasoningText } = require('../session-trace/codex-rollout');

test('codexReasoningText：summary 数组抽出文本', () => {
  const text = codexReasoningText({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Let me fetch the article link and check relevant skills.' }],
    content: null,
  });
  assert.equal(text.includes('[object Object]'), false);
  assert.match(text, /fetch the article/);
});

test('codexReasoningText：多段 summary 用空行拼接', () => {
  const text = codexReasoningText({
    summary: [
      { type: 'summary_text', text: 'First thought.' },
      { type: 'summary_text', text: 'Second thought.' },
    ],
  });
  assert.match(text, /First thought/);
  assert.match(text, /Second thought/);
});

test('codexReasoningText：空 summary 返回空串', () => {
  assert.equal(codexReasoningText({ summary: [], content: null }), '');
  assert.equal(codexReasoningText({ summary: [{ type: 'summary_text' }] }), '');
});

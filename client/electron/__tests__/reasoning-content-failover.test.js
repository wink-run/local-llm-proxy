'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  anthropicToOpenai,
  openaiToAnthropic,
  isMissingReasoningContentError,
  ensureReasoningContentOnAssistants,
} = require('../local-gateway');

test('anthropicToOpenai：thinking 块 → reasoning_content', () => {
  const oai = anthropicToOpenai({
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先列目录' },
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    }],
  });
  const msg = oai.messages[0];
  assert.equal(msg.reasoning_content, '先列目录');
  assert.equal(msg.content, '好的');
  assert.equal(msg.tool_calls.length, 1);
});

test('openaiToAnthropic：reasoning_content → thinking 块（不并入 text）', () => {
  const anth = openaiToAnthropic({
    choices: [{
      message: {
        role: 'assistant',
        content: '最终答案',
        reasoning_content: '逐步推理',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  }, 'deepseek-v4-flash');
  const types = anth.content.map((b) => b.type);
  assert.deepEqual(types, ['thinking', 'text']);
  assert.equal(anth.content[0].thinking, '逐步推理');
  assert.equal(anth.content[1].text, '最终答案');
});

test('isMissingReasoningContentError 识别 DeepSeek 文案', () => {
  assert.equal(
    isMissingReasoningContentError({
      message: 'HTTP_400: The `reasoning_content` in the thinking mode must be passed back to the API.',
    }),
    true,
  );
  assert.equal(isMissingReasoningContentError({ message: 'HTTP_429: rate' }), false);
});

test('ensureReasoningContentOnAssistants 补 Anthropic thinking / OpenAI 字段', () => {
  const anth = ensureReasoningContentOnAssistants({
    messages: [{
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: '1', name: 'x', input: {} }],
    }],
  });
  assert.equal(anth.messages[0].content[0].type, 'thinking');

  const oai = ensureReasoningContentOnAssistants({
    messages: [{ role: 'assistant', content: 'hi', tool_calls: [{ id: 'c' }] }],
  });
  assert.equal(oai.messages[0].reasoning_content, ' ');
});

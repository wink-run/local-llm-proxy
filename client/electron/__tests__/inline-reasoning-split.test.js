'use strict';

const assert = require('assert');
const {
  splitInlineReasoning,
  dedupeRepeatedText,
  looksLikeInlineReasoning,
  expandMixedOutputSteps,
} = require('../inline-reasoning-split.cjs');

const MIXED = 'The user is just saying "hi - a simple greeting. I should respond concisely without any fluff, as per their CLAUDE.md instructionsHi What are you working on?'
  + 'The user is just saying "hi" - a simple greeting. I should respond concisely without any fluff, as per their CLAUDE.md instructions.Hi. What are you working on?';

assert.ok(looksLikeInlineReasoning(MIXED));

const parts = splitInlineReasoning(MIXED);
assert.ok(parts.some(p => p.stepType === 'thinking'));
assert.ok(parts.some(p => p.stepType === 'output'));
const output = parts.filter(p => p.stepType === 'output').map(p => p.content).join('');
assert.ok(output.includes('Hi'));
assert.ok(!output.includes('CLAUDE.md'));

// 中文回复边界
const CN_MIXED = 'The user is saying "hello" in Chinese. I\'ll respond in Chinese to match their language.你好！ 有什么我可以帮你的吗？'
  + 'The user is saying "hello" in Chinese. I\'ll respond in Chinese to match their language.你好！ 有什么我可以帮你的吗？';
const cnParts = splitInlineReasoning(CN_MIXED);
assert.strictEqual(cnParts.filter(p => p.stepType === 'thinking').length, 1);
assert.strictEqual(cnParts.filter(p => p.stepType === 'output').length, 1);
assert.ok(cnParts.find(p => p.stepType === 'output').content.startsWith('你好'));

const HI_MIXED = 'The user is just saying hi. I should respond briefly. No need for any tools or complex responsesHi. What are you working on?';
const hiParts = splitInlineReasoning(HI_MIXED);
assert.ok(hiParts.some(p => p.stepType === 'thinking'));
assert.ok(hiParts.find(p => p.stepType === 'output').content.startsWith('Hi'));

const { stripDuplicateThinkingPrefix, stripReasoningLeakage } = require('../inline-reasoning-split.cjs');
const stripped = stripDuplicateThinkingPrefix(
  'The user is saying hi. No need for tools.Hi. What are you working on?',
  'The user is saying hi. No need for tools.',
);
assert.ok(stripped.startsWith('Hi'));

// thinking 在引号处截断，output 续写 meta 后才是中文回复
const poemClean = stripReasoningLeakage(
  '写首诗" which means "write a poem" in Chinese. Let me write a short poem for them.好的，为你写一首：《码间行》',
  'The user is asking me to write a poem. They said "',
);
assert.ok(poemClean.startsWith('好的'));
assert.ok(!poemClean.includes('which means'));

const { repairThinkingOutputBoundary } = require('../inline-reasoning-split.cjs');
const titleFixed = repairThinkingOutputBoundary(
  'The user wants another poem. Let me write a fresh one.** 《',
  '无题》 **\n晚风穿过打开的窗口，',
);
assert.ok(titleFixed.thinking.endsWith('fresh one.'));
assert.ok(titleFixed.output.startsWith('**《无题》**'));

// 纯推理流（尚无回复）
const THINK_ONLY = "The user is just saying 'hi' - a casual greeting. I'll respond in friendl";
const thinkOnly = splitInlineReasoning(THINK_ONLY);
assert.strictEqual(thinkOnly.length, 1);
assert.strictEqual(thinkOnly[0].stepType, 'thinking');

const expanded = expandMixedOutputSteps([
  { stepType: 'output', content: MIXED, is_snapshot: true },
]);
assert.ok(expanded.some(s => s.stepType === 'thinking'));
assert.ok(expanded.some(s => s.stepType === 'output'));

assert.strictEqual(
  dedupeRepeatedText('The user is asking about code. '.repeat(4).trim()),
  'The user is asking about code.',
);

console.log('inline-reasoning-split.test.js OK');

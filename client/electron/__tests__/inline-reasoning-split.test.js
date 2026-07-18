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

const {
  stripDuplicateThinkingPrefix,
  stripReasoningLeakage,
  looksLikeLeakedReasoning,
} = require('../inline-reasoning-split.cjs');
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

// 无清晰分界的「纯推理」片段：不单独标 thinking，整段当输出
const THINK_ONLY = "The user is just saying 'hi' - a casual greeting. I'll respond in friendl";
const thinkOnly = splitInlineReasoning(THINK_ONLY);
assert.strictEqual(thinkOnly.length, 1);
assert.strictEqual(thinkOnly[0].stepType, 'output');

// 分界清晰（…instructions.Hi）才拆成 thinking + output
const expanded = expandMixedOutputSteps([
  { stepType: 'output', content: MIXED, is_snapshot: true },
]);
assert.ok(expanded.some(s => s.stepType === 'thinking'));
assert.ok(expanded.some(s => s.stepType === 'output'));

// concelyHi 粘连且可切开 → 有清晰分界
const { hasClearReasoningBoundary, splitInlineReasoning: split2 } = require('../inline-reasoning-split.cjs');
const concely = 'The user just said "hi". This is a simple greeting Let me respond concelyHi What can I help you with?';
assert.ok(hasClearReasoningBoundary(concely));
const concelyParts = split2(concely);
assert.ok(concelyParts.some(p => p.stepType === 'output' && p.content.startsWith('Hi')));
assert.ok(!concelyParts.some(p => p.stepType === 'output' && p.content.includes('Let me respond')));

assert.strictEqual(
  dedupeRepeatedText('The user is asking about code. '.repeat(4).trim()),
  'The user is asking about code.',
);

// 引号内用户原话是中文时，不能把 thinking 截在打开引号处
const WHO_MIXED = 'The user is asking "你是谁". I should introduce myself briefly. '
  + 'The system prompt indicates I\'m Claude Code, Anthropic\'s official CLI for running within '
  + 'the Agent SDK / Token Bank聚合入口的主（编排层）。'
  + '我是 Claude Code，Anthropic 的官方助手。我可以协调多个 Agent 如 Codex、Claude 等来完成你的任务。有什么需要帮忙的吗？';
const whoParts = splitInlineReasoning(WHO_MIXED);
const whoThink = whoParts.find(p => p.stepType === 'thinking')?.content || '';
const whoOut = whoParts.find(p => p.stepType === 'output')?.content || '';
assert.ok(whoThink.includes('你是谁'), '推理应保留引号内用户原话');
assert.ok(whoThink.includes('I should introduce'), '推理不应在打开引号处截断');
assert.ok(!whoThink.endsWith('"') || whoThink.includes('你是谁'), '推理不能只剩打开引号');
assert.ok(whoOut.startsWith('我是'), '回复应从中文自我介绍开始');
assert.ok(!whoOut.includes('I should introduce'), '回复不应混入英文推理');
assert.ok(whoOut.includes('Claude Code'));

// 已截断的 thinking/output 对可修复
const { repairThinkingOutputBoundary: repairQuote } = require('../inline-reasoning-split.cjs');
const quoteFixed = repairQuote(
  'The user is asking "',
  '你是谁". I should introduce myself briefly. Token Bank聚合入口的主（编排层）。我是 Claude Code，官方助手。',
);
assert.ok(quoteFixed.thinking.includes('你是谁'));
assert.ok(quoteFixed.output.startsWith('我是'));

// 推理停在未闭合引号中文处，续写英文 meta + 中文回复
const midQuoteThink = 'The user is asking "你是谁';
const midQuoteOut = '" (Who are you?). This is simple question about my identity Let me give concise answer 我是 Claude Code，Anthropic 的官方 CLI Agent。';
assert.ok(looksLikeLeakedReasoning(midQuoteOut));
const midClean = stripReasoningLeakage(midQuoteOut, midQuoteThink);
assert.ok(midClean.startsWith('我是'), `应剥掉英文续写，实际: ${midClean.slice(0, 40)}`);
assert.ok(!midClean.includes('Who are you'));
assert.ok(!midClean.includes('Let me give'));
const midRepaired = repairQuote(midQuoteThink, midQuoteOut);
assert.ok(midRepaired.thinking.includes('你是谁'));
assert.ok(midRepaired.thinking.includes('Let me give') || midRepaired.thinking.includes('Who are you'));
assert.ok(midRepaired.output.startsWith('我是'));

// 推理断在 "hi"，列表续写 + helpHi 粘连 → 重绘修正
const hiThink = 'The user just said "hi"';
const hiOut = '• a simple greeting. I should respond briefly and ask how can helpHi! What are you working on today?';
assert.ok(looksLikeLeakedReasoning(hiOut));
const hiFixed = repairQuote(hiThink, hiOut);
assert.ok(hiFixed.thinking.includes('simple greeting'), `推理应补全，实际: ${hiFixed.thinking}`);
assert.ok(hiFixed.output.startsWith('Hi!'), `回复应从 Hi! 开始，实际: ${hiFixed.output}`);
assert.ok(!hiFixed.output.includes('I should respond'));

// 词中截断 whatever t + hey need.Hi → 拼回后切开或整段输出
const {
  isTruncatedThinking,
  joinThinkingOutput,
  hasClearReasoningBoundary: clearBound,
} = require('../inline-reasoning-split.cjs');
const truncThink = 'The user is just saying "hi — this a greeting. I should respond with brief, friendly and be ready to help whatever t';
const truncOut = 'hey need.Hi What are you working on?';
assert.ok(isTruncatedThinking(truncThink));
assert.strictEqual(joinThinkingOutput(truncThink, truncOut).includes('they need'), true);
const truncFixed = repairQuote(truncThink, truncOut);
assert.ok(truncFixed.output.includes('What are you working on'));
assert.ok(!truncFixed.output.startsWith('hey need'), `应去掉续写前缀，实际: ${truncFixed.output.slice(0, 40)}`);
if (truncFixed.thinking) {
  assert.ok(clearBound(joinThinkingOutput(truncFixed.thinking, truncFixed.output)));
  assert.ok(truncFixed.output.startsWith('Hi'));
} else {
  // 分界不够清晰时整段当输出也可
  assert.ok(truncFixed.output.includes('Hi'));
}

console.log('inline-reasoning-split.test.js OK');

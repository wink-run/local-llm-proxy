'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  buildClaudeStyleSteps,
  buildTraceStats,
  toolResultText,
  sanitizeCursorText,
} = require('../session-browser');
const { extractContext, clipTraceText, TRACE_STEP_TEXT_MAX } = require('../session-trace/shared');

const span = { t0: 0, span: 1000, lineCount: 10 };

// 真实 Claude Code jsonl 片段：用户输入 → assistant(思考+工具) → tool_result 回执 → Skill 调用
const lines = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我看一下 git 状态' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '先跑 git status' },
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'git status' } },
  ], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu_1', content: 'On branch main\nnothing to commit', is_error: false },
  ] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', id: 'tu_3', name: 'Skill', input: { skill: 'superpowers:brainstorming' } },
  ] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'text', text: 'a\nb' }], is_error: true },
    { type: 'tool_result', tool_use_id: 'tu_3', content: 'Launching skill: superpowers:brainstorming' },
  ] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: '完成。' },
  ] } }),
];

test('buildClaudeStyleSteps captures tool_result steps and skill names', () => {
  const steps = buildClaudeStyleSteps(lines, span);
  const kinds = steps.map(s => s.kind);

  // 之前 tool_result 完全丢失；现在应出现 3 个 tool_result 步骤
  assert.equal(kinds.filter(k => k === 'tool_result').length, 3);
  // 工具调用：Bash×2 + Skill×1
  assert.equal(kinds.filter(k => k === 'tool').length, 3);
  // 真实用户轮次只有 1 次（tool_result 行不算 user）
  assert.equal(kinds.filter(k => k === 'user').length, 1);
  // 思考块
  assert.equal(steps.filter(s => s.reasoning).length, 1);

  // tool_result 用对应的工具名命名
  const firstResult = steps.find(s => s.kind === 'tool_result');
  assert.equal(firstResult.tool, 'Bash');
  assert.match(firstResult.label, /Bash/);
  assert.match(firstResult.text, /nothing to commit/);

  // Skill 步骤带技能名
  const skillStep = steps.find(s => s.tool === 'Skill');
  assert.equal(skillStep.skill, 'superpowers:brainstorming');
  assert.match(skillStep.label, /brainstorming/);

  // is_error 透传
  assert.equal(steps.find(s => s.tool_use_id === 'tu_2').is_error, true);
});

test('buildTraceStats produces tool breakdown and skill counts', () => {
  const steps = buildClaudeStyleSteps(lines, span);
  const stats = buildTraceStats(steps, { rawLines: lines });

  assert.equal(stats.tools, 3);
  assert.equal(stats.toolResults, 3);
  assert.equal(stats.turns, 1);
  assert.equal(stats.skills, 1);
  assert.deepEqual(stats.skillNames, ['superpowers:brainstorming']);
  assert.equal(stats.reasoning, 1);
  assert.equal(stats.errors, 1); // 一个 is_error:true 的 tool_result

  // toolBreakdown 按次数降序：Bash×2 在前，Skill×1 在后
  assert.deepEqual(stats.toolBreakdown, [
    { name: 'Bash', count: 2 },
    { name: 'Skill', count: 1 },
  ]);

  // token 用量累加
  assert.equal(stats.tokens.input, 100);
  assert.equal(stats.tokens.cached, 50);
});

test('toolResultText handles string, array and object shapes', () => {
  assert.equal(toolResultText('hello'), 'hello');
  assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(toolResultText({ output: 'cmd out' }), 'cmd out');
  assert.equal(toolResultText(null), '');
});

test('sanitizeCursorText strips [REDACTED] placeholders', () => {
  assert.equal(sanitizeCursorText('[REDACTED]'), '');
  assert.equal(
    sanitizeCursorText('正在排查 AVG LATENCY 无数据的原因。\n\n[REDACTED]'),
    '正在排查 AVG LATENCY 无数据的原因。',
  );
  assert.equal(sanitizeCursorText('plain text'), 'plain text');
});

test('extractContext forTrace keeps full user_query without list preview truncation', () => {
  const long = 'x'.repeat(300);
  const wrapped = `<user_query>${long}</user_query>`;
  assert.equal(extractContext(wrapped, { forTrace: true }), long);
  assert.match(extractContext(wrapped), /…$/);
  assert.ok(extractContext(wrapped).length <= 160);
});

test('clipTraceText only truncates beyond TRACE_STEP_TEXT_MAX', () => {
  assert.equal(clipTraceText('abc'), 'abc');
  const huge = 'z'.repeat(TRACE_STEP_TEXT_MAX + 10);
  assert.equal(clipTraceText(huge).length, TRACE_STEP_TEXT_MAX);
  assert.match(clipTraceText(huge), /…$/);
});

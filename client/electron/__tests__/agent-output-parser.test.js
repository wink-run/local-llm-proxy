'use strict';

const { stripAnsi, parseAgentOutputLine } = require('../agent-output-parser');
const assert = require('assert');

// ANSI 剥离
assert.strictEqual(
  stripAnsi('\x1b[33mWarning\x1b[39m test'),
  'Warning test',
);
assert.strictEqual(
  stripAnsi('[33mWarning: no stdin[39m'),
  'Warning: no stdin',
);

// 噪声过滤
assert.deepStrictEqual(parseAgentOutputLine('Warning: no stdin data received in 3s', 'claude-code'), []);

// Claude stream-json
const jsonSteps = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: '正在编写贪吃蛇游戏…' },
      { type: 'tool_use', name: 'Write', input: { file_path: 'snake.py' } },
    ],
  },
}), 'claude-code');
assert.strictEqual(jsonSteps.length, 2);
assert.strictEqual(jsonSteps[0].stepType, 'output');
assert.strictEqual(jsonSteps[1].stepType, 'tool_call');
assert.strictEqual(jsonSteps[1].tool_name, 'Write');

// Claude system / api_retry
const retrySteps = parseAgentOutputLine(JSON.stringify({
  type: 'system',
  subtype: 'api_retry',
  attempt: 2,
  max_retries: 10,
  retry_delay_ms: 1105.609,
  error_status: 529,
}), 'claude-code');
assert.strictEqual(retrySteps.length, 1);
assert.strictEqual(retrySteps[0].stepType, 'system_event');
assert.strictEqual(retrySteps[0].system_subtype, 'api_retry');
assert.strictEqual(retrySteps[0].attempt, 2);

assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'system', subtype: 'thinking_tokens',
}), 'claude-code'), []);

// hook_started 跳过
assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'system',
  subtype: 'hook_started',
  hook_name: 'SessionStart:startup',
}), 'claude-code'), []);

// hook_response 解析内嵌 JSON
const hookSteps = parseAgentOutputLine(JSON.stringify({
  type: 'system',
  subtype: 'hook_response',
  hook_name: 'SessionStart:startup',
  output: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '会话已就绪，开始工作。',
    },
  }),
}), 'claude-code');
assert.strictEqual(hookSteps.length, 1);
assert.strictEqual(hookSteps[0].stepType, 'output');
assert.strictEqual(hookSteps[0].content, '会话已就绪，开始工作。');

const { summarizeAgentStdout, extractModifiedFiles, isLikelyFilePath, extractCliSessionId } = require('../agent-output-parser');
const summary = summarizeAgentStdout(
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }),
  'claude-code',
);
assert.strictEqual(summary, '你好');

// 文件路径提取：stream-json Write
const writeLine = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', name: 'Write', input: { file_path: 'skills/code-avatar/SKILL.md', content: '---\nname: x\n---' } },
    ],
  },
});
const extracted = extractModifiedFiles(`${writeLine}\n`);
assert.strictEqual(extracted.length, 1);
assert.strictEqual(extracted[0].path, 'skills/code-avatar/SKILL.md');
assert.strictEqual(extracted[0].operation, 'created');

// JSON 行内 Created: 子串不应误匹配 skill 正文
const badJson = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'Created: false\\n---\\n\\n# Code Avatar' }] },
});
assert.strictEqual(extractModifiedFiles(badJson).length, 0);
assert.strictEqual(isLikelyFilePath('false\\n---\\n\\n# Title'), false);
assert.ok(isLikelyFilePath('src/foo.py'));

assert.strictEqual(
  extractCliSessionId(JSON.stringify({ type: 'thread.started', thread_id: 'uuid-1' }), 'codex'),
  'uuid-1',
);
assert.strictEqual(
  extractCliSessionId(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9' }), 'claude-code'),
  'sess-9',
);

// Codex JSONL
const codexSteps = parseAgentOutputLine(JSON.stringify({
  type: 'event_msg',
  payload: { type: 'agent_message', message: '正在分析代码…' },
}), 'codex');
assert.strictEqual(codexSteps.length, 1);
assert.strictEqual(codexSteps[0].stepType, 'output');

// Codex 新版 item.completed
const itemSteps = parseAgentOutputLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_1',
    type: 'agent_message',
    text: '# 冒泡排序\n\n算法原理…',
  },
}), 'codex');
assert.strictEqual(itemSteps.length, 1);
assert.strictEqual(itemSteps[0].stepType, 'output');
assert.ok(itemSteps[0].content.includes('冒泡排序'));

assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'thread.started',
  thread_id: 'abc',
}), 'codex'), []);

console.log('agent-output-parser.test.js OK');

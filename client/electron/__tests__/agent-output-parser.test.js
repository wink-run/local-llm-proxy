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

console.log('agent-output-parser.test.js OK');

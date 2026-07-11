'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeCodeArgs,
  buildClaudeContinueArgs,
} = require('../agent-executor');

const VALID_SID = '5550fa92-351c-4adb-aaf8-1f654c4b8bd7';

test('buildClaudeContinueArgs uses --resume when continuing with session id', () => {
  assert.deepEqual(
    buildClaudeContinueArgs({ continueSession: true, cliSessionId: VALID_SID }),
    ['--resume', VALID_SID],
  );
});

test('buildClaudeContinueArgs falls back to -c when continuing without session id', () => {
  assert.deepEqual(
    buildClaudeContinueArgs({ continueSession: true }),
    ['-c'],
  );
});

test('buildClaudeContinueArgs ignores stale session id when not continuing', () => {
  assert.deepEqual(
    buildClaudeContinueArgs({ continueSession: false, cliSessionId: VALID_SID }),
    [],
  );
});

test('buildClaudeCodeArgs uses sync json output format', () => {
  assert.deepEqual(
    buildClaudeCodeArgs('hello', { continueSession: false }),
    [
      '-p', '--dangerously-skip-permissions',
      '--output-format', 'json',
      'hello',
    ],
  );
});

test('buildClaudeCodeArgs includes resume before print flags', () => {
  assert.deepEqual(
    buildClaudeCodeArgs('hello', { continueSession: true, cliSessionId: VALID_SID }),
    [
      '--resume', VALID_SID,
      '-p', '--dangerously-skip-permissions',
      '--output-format', 'json',
      'hello',
    ],
  );
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeCodeArgs,
  buildClaudeContinueArgs,
  buildClaudeStreamFlags,
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

test('buildClaudeStreamFlags uses stream-json without partial messages', () => {
  assert.deepEqual(buildClaudeStreamFlags(), [
    '-p', '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ]);
  assert.ok(!buildClaudeStreamFlags().includes('--include-partial-messages'));
});

test('buildClaudeCodeArgs streams instead of sync json', () => {
  const args = buildClaudeCodeArgs('hello', { continueSession: false });
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--append-system-prompt'));
  assert.equal(args[args.length - 1], 'hello');
  const i = args.indexOf('--append-system-prompt');
  assert.ok(String(args[i + 1]).includes('产物交付'));
});

test('buildClaudeCodeArgs includes resume before print flags', () => {
  const args = buildClaudeCodeArgs('hello', { continueSession: true, cliSessionId: VALID_SID });
  assert.deepEqual(args.slice(0, 2), ['--resume', VALID_SID]);
  assert.ok(args.includes('--append-system-prompt'));
  assert.equal(args[args.length - 1], 'hello');
});

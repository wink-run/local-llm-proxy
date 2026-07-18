'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildCursorAgentArgs } = require('../agent-executor');

test('buildCursorAgentArgs uses headless print + stream-json (Tutti-aligned binary driver)', () => {
  const args = buildCursorAgentArgs('hello', { workingDir: '/tmp/proj' });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--force'));
  assert.ok(args.includes('--approve-mcps'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--workspace'));
  assert.ok(args.includes('/tmp/proj'));
  assert.ok(args[args.length - 1].includes('hello'));
});

test('buildCursorAgentArgs resume / continue / model', () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const resume = buildCursorAgentArgs('go', {
    continueSession: true,
    cliSessionId: sid,
    model: 'sonnet-4',
  });
  assert.ok(resume.includes('--resume'));
  assert.ok(resume.includes(sid));
  assert.ok(resume.includes('--model'));
  assert.ok(resume.includes('sonnet-4'));

  const cont = buildCursorAgentArgs('go', { continueSession: true });
  assert.ok(cont.includes('--continue'));
});

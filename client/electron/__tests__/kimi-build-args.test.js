'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildKimiCodeArgs } = require('../agent-executor');

test('buildKimiCodeArgs 含 stream-json / -p，且不用 -y/--auto', () => {
  const args = buildKimiCodeArgs('hello', { model: 'k3' });
  assert.ok(!args.includes('-y'));
  assert.ok(!args.includes('--yolo'));
  assert.ok(!args.includes('--auto'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('-m'));
  assert.ok(args.includes('k3'));
  const pIdx = args.indexOf('-p');
  assert.ok(pIdx >= 0);
  assert.ok(String(args[pIdx + 1]).includes('hello'));
});

test('buildKimiCodeArgs 续聊无 sessionId 时用 -c', () => {
  const args = buildKimiCodeArgs('hi', { continueSession: true });
  assert.ok(args.includes('-c'));
});

test('buildKimiCodeArgs 续聊保留 session_ 前缀 id', () => {
  const sid = 'session_e3436792-d6d7-4d13-9085-d7f86010473d';
  const args = buildKimiCodeArgs('hi', { continueSession: true, cliSessionId: sid });
  assert.ok(args.includes('-S'));
  assert.ok(args.includes(sid));
});

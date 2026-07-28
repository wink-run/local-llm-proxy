'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// os.homedir() (libuv) 优先取 $HOME；改 HOME 即可把 ROOT() 重定向到临时目录。
const REAL_HOME = process.env.HOME;
function withTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  process.env.HOME = home;
  const sessDir = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  return sessDir;
}
function restoreHome() { process.env.HOME = REAL_HOME; }

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function writeRollout(sessDir, lines) {
  const file = path.join(sessDir, `rollout-2026-01-01T00-00-00-${SID}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('parseCodexRolloutFile: 流式解析出 context 与累计用量', () => {
  const { parseCodexRolloutFile } = require('../session-trace/codex-rollout');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  const file = path.join(dir, 'rollout-x.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/proj' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello world' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } } } }),
  ].join('\n'));
  const p = parseCodexRolloutFile(file, {});
  assert.equal(p.context, 'hello world');
  assert.equal(p.cwdHint, '/tmp/proj');
  assert.equal(p.inTok, 80);   // 100 - 20 cached
  assert.equal(p.cached, 20);
  assert.equal(p.outTok, 30);
});

test('trace: 流式产出 user/tool/tool_result 步骤，并按 mtime+size 缓存', () => {
  const { trace } = require('../session-trace/codex-rollout');
  const sessDir = withTempHome();
  try {
    writeRollout(sessDir, [
      { type: 'session_meta', payload: { cwd: '/tmp/proj' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'Bash', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } },
    ]);
    const r1 = trace(SID);
    assert.equal(r1.error, undefined);
    const kinds = r1.steps.map(s => s.kind);
    assert.deepEqual(kinds, ['user', 'tool', 'tool_result']);
    assert.equal(r1.stats.truncated, undefined);

    // 缓存命中：返回等价结果，且改写副本 tokens 不影响后续读取（防缓存污染）。
    r1.stats.tokens.input = 999999;
    const r2 = trace(SID);
    assert.equal(r2.steps.length, 3);
    assert.notEqual(r2.stats.tokens.input, 999999);
  } finally { restoreHome(); }
});

test('trace: 超过 MAX_TRACE_STEPS 时截断并置 truncated', () => {
  const { trace, MAX_TRACE_STEPS } = require('../session-trace/codex-rollout');
  const sessDir = withTempHome();
  try {
    const lines = [{ type: 'session_meta', payload: { cwd: '/tmp/p' } }];
    for (let i = 0; i < MAX_TRACE_STEPS + 50; i++) {
      lines.push({ type: 'event_msg', payload: { type: 'agent_message', message: 'm' + i } });
    }
    writeRollout(sessDir, lines);
    const r = trace(SID);
    assert.equal(r.stats.truncated, true);
    assert.equal(r.steps.length, MAX_TRACE_STEPS);
  } finally { restoreHome(); }
});

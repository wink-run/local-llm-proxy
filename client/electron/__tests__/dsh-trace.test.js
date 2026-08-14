'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { buildStepsFromDshLines, dshUsage } = require('../session-trace/dsh-trace');
const { expandEntity } = require('../app-handlers');
const { compileAppsDoc } = require('../apps-compiler');
const { iterZstdJsonlLines } = require('../jsonl-lines');

const span = { t0: 1_700_000_000_000, span: 10_000, lineCount: 20 };

test('dshUsage maps inputTokens/outputTokens/cacheReadTokens', () => {
  const u = dshUsage({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    reasoningTokens: 8,
  });
  assert.equal(u.inTok, 100);
  assert.equal(u.outTok, 20);
  assert.equal(u.cached, 50);
});

test('dsh steps: user / reasoning / assistant / tool（跳过 chunk）', () => {
  const lines = [
    JSON.stringify({
      type: 'session',
      id: 'session-aaa',
      cwd: '/Users/ully/githubprojects/testabc',
      createdAt: 1000,
    }),
    JSON.stringify({
      type: 'user/message',
      time: 1100,
      data: { content: [{ type: 'text', text: '列出目录' }], role: 'user' },
    }),
    JSON.stringify({ type: 'assistant/chunk', time: 1150, data: { text: '碎' } }),
    JSON.stringify({ type: 'reasoning-chunks', time: 1160, data: { text: '片' } }),
    JSON.stringify({
      type: 'assistant/message',
      time: 1200,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看一眼目录' },
            { type: 'text', text: '目录里有两个文件' },
          ],
          source: { model: 'deepseek-v4-pro' },
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 },
      },
    }),
    JSON.stringify({
      type: 'tool/call',
      time: 1300,
      data: { callId: 't1', name: 'Bash', arguments: '{"command":"ls"}' },
    }),
    JSON.stringify({
      type: 'tool/result',
      time: 1400,
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 't1',
            content: [{ type: 'text', text: 'a.txt\nb.txt' }],
          }],
        },
      },
    }),
  ];
  const steps = buildStepsFromDshLines(lines, span);
  assert.ok(steps.some(s => s.kind === 'user' && s.text.includes('列出目录')));
  assert.ok(steps.some(s => s.kind === 'assistant' && s.reasoning));
  assert.ok(steps.some(s => s.kind === 'tool' && s.tool === 'Bash'));
  assert.ok(steps.some(s => s.kind === 'tool_result' && s.text.includes('a.txt')));
  assert.ok(!steps.some(s => (s.text || '').includes('碎') || (s.text || '').includes('片')));
  const asst = steps.find(s => s.kind === 'assistant' && !s.reasoning);
  assert.ok(asst);
  assert.ok(asst.text.includes('两个文件'));
  assert.equal(asst.inTok, 10);
  assert.equal(asst.outTok, 5);
  assert.equal(asst.cached, 100);
});

test('iterZstdJsonlLines 解拼接 zstd 帧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zstd-'));
  const file = path.join(dir, 'session.jsonl.zstd');
  const frames = ['{"type":"session","id":"s1"}', '{"type":"user/message","data":{"role":"user"}}']
    .map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
  const got = [...iterZstdJsonlLines(file)].map((l) => l.trim()).filter(Boolean);
  assert.equal(got.length, 2);
  assert.equal(JSON.parse(got[0]).type, 'session');
  assert.equal(JSON.parse(got[1]).type, 'user/message');
});

test('iterZstdJsonlLines 大量拼接帧 + 可跳过帧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zstd-many-'));
  const file = path.join(dir, 'session.jsonl.zstd');
  const n = 300;
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push(zlib.zstdCompressSync(Buffer.from(`{"i":${i}}\n`, 'utf8')));
    if (i === 10) {
      // 可跳过帧 magic 0x184D2A50 + 4 字节长度 + payload
      const payload = Buffer.from('skip-me');
      const skip = Buffer.alloc(8 + payload.length);
      skip.writeUInt32LE(0x184D2A50, 0);
      skip.writeUInt32LE(payload.length, 4);
      payload.copy(skip, 8);
      frames.push(skip);
    }
  }
  fs.writeFileSync(file, Buffer.concat(frames));
  const got = [...iterZstdJsonlLines(file)].map((l) => l.trim()).filter(Boolean);
  assert.equal(got.length, n);
  assert.equal(JSON.parse(got[0]).i, 0);
  assert.equal(JSON.parse(got[n - 1]).i, n - 1);
});

test('旧目录 gateway-only 种子升级为 session_import 默认（trace+补录）', () => {
  const ent = expandEntity({
    id: 'deepseek-harness',
    handler: 'deepseek-harness-cli',
    vars: {
      capabilities: {
        gateway_proxy: true,
        session_trace: false,
        session_usage_import: false,
      },
    },
  });
  assert.equal(ent.session_trace, true);
  assert.equal(ent.session_usage_import, true);
  assert.equal(ent.trace_profile, 'dsh-trace');
});

test('云端只关用量补录时仍挂 dsh-trace', () => {
  const ent = expandEntity({
    id: 'deepseek-harness',
    handler: 'deepseek-harness-cli',
    vars: {
      capabilities: {
        gateway_proxy: true,
        session_trace: true,
        session_usage_import: false,
      },
    },
  });
  assert.equal(ent.session_trace, true);
  assert.equal(ent.session_usage_import, false);
  assert.equal(ent.trace_profile, 'dsh-trace');
  assert.equal(ent.session_source_id, 'dsh');
  assert.equal(ent.activity_agent_id, 'deepseek-harness');
});

test('云端只关 session_trace 时不挂 trace', () => {
  const ent = expandEntity({
    id: 'deepseek-harness',
    handler: 'deepseek-harness-cli',
    vars: {
      capabilities: {
        gateway_proxy: true,
        session_trace: false,
        session_usage_import: true,
      },
    },
  });
  assert.equal(ent.session_trace, false);
  assert.equal(ent.session_usage_import, true);
  assert.ok(!ent.trace_profile);
});

test('compileAppsDoc：dsh 默认发出 session_sources（trace+补录）', () => {
  const doc = compileAppsDoc({
    app_entities: [{ id: 'deepseek-harness', handler: 'deepseek-harness-cli' }],
  });
  assert.equal(doc.session_sources.length, 1);
  assert.equal(doc.session_sources[0].id, 'dsh');
  assert.equal(doc.session_sources[0].session_trace, true);
  assert.equal(doc.session_sources[0].session_usage_import, true);
  assert.equal(doc.session_sources[0].glob, '**/session.jsonl.zstd');
  assert.equal(doc.session_sources[0].format, 'jsonl-zstd');
  assert.equal(doc.entities_expanded[0].trace_profile, 'dsh-trace');
});

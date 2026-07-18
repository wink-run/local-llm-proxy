'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildStepsFromWireLines, kimiUsage } = require('../session-trace/kimi-code-trace');
const { expandEntity } = require('../app-handlers');
const { compileAppsDoc } = require('../apps-compiler');
const { matchFilter } = require('../session-import');

const span = { t0: 1_700_000_000_000, span: 10_000, lineCount: 20 };

test('kimiUsage maps inputOther/output/cache', () => {
  const u = kimiUsage({
    inputOther: 100,
    output: 20,
    inputCacheRead: 50,
    inputCacheCreation: 5,
  });
  assert.equal(u.inTok, 100);
  assert.equal(u.outTok, 20);
  assert.equal(u.cached, 50);
});

test('kimi wire steps: user / reasoning / assistant / tool', () => {
  const lines = [
    JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: '列出目录' }], time: 1000 }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1100,
      event: {
        type: 'content.part',
        stepUuid: 'step-1',
        part: { type: 'think', think: '先看一眼目录' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1200,
      event: {
        type: 'tool.call',
        name: 'Bash',
        args: { command: 'ls' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1300,
      event: {
        type: 'tool.result',
        toolCallId: 't1',
        result: { output: 'a.txt\nb.txt' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1400,
      event: {
        type: 'content.part',
        stepUuid: 'step-1',
        part: { type: 'text', text: '目录里有两个文件' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1500,
      event: {
        type: 'step.end',
        uuid: 'step-1',
        usage: { inputOther: 10, output: 5, inputCacheRead: 100 },
      },
    }),
  ];
  const steps = buildStepsFromWireLines(lines, span);
  assert.ok(steps.some(s => s.kind === 'user' && s.text.includes('列出目录')));
  assert.ok(steps.some(s => s.kind === 'assistant' && s.reasoning));
  assert.ok(steps.some(s => s.kind === 'tool' && s.tool === 'Bash'));
  assert.ok(steps.some(s => s.kind === 'tool_result' && s.text.includes('a.txt')));
  const asst = steps.find(s => s.kind === 'assistant' && !s.reasoning);
  assert.ok(asst);
  assert.ok(asst.text.includes('两个文件'));
  assert.equal(asst.inTok, 10);
  assert.equal(asst.outTok, 5);
  assert.equal(asst.cached, 100);
});

test('matchFilter all ANDs conditions', () => {
  const f = {
    all: [
      { field: 'type', equals: 'usage.record' },
      { field: 'usageScope', equals: 'turn' },
    ],
  };
  assert.equal(matchFilter({ type: 'usage.record', usageScope: 'turn' }, f), true);
  assert.equal(matchFilter({ type: 'usage.record', usageScope: 'session' }, f), false);
  assert.equal(matchFilter({ type: 'llm.request', usageScope: 'turn' }, f), false);
});

test('kimi-code entity expands with session_trace + usage import', () => {
  const ent = expandEntity({
    id: 'kimi-code',
    handler: 'kimi-code-cli',
    vars: {
      capabilities: {
        gateway_proxy: true,
        session_trace: true,
        session_usage_import: true,
      },
    },
  });
  assert.equal(ent.session_trace, true);
  assert.equal(ent.session_usage_import, true);
  assert.equal(ent.trace_profile, 'kimi-code-trace');
  assert.equal(ent.session_source_id, 'kimi');
});

test('compileAppsDoc emits kimi session_sources', () => {
  const doc = compileAppsDoc({
    app_entities: [{
      id: 'kimi-code',
      handler: 'kimi-code-cli',
      vars: {
        capabilities: {
          gateway_proxy: true,
          session_trace: true,
          session_usage_import: true,
        },
      },
    }],
  });
  assert.equal(doc.tools.length, 1);
  assert.equal(doc.session_sources.length, 1);
  assert.equal(doc.session_sources[0].id, 'kimi');
  assert.equal(doc.session_sources[0].session_trace, true);
  assert.equal(doc.session_sources[0].session_usage_import, true);
  assert.equal(doc.session_sources[0].glob, '**/agents/*/wire.jsonl');
});

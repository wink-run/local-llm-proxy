'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildStepsFromSpans } = require('../session-trace/workbuddy-trace');
const { expandEntity } = require('../app-handlers');
const { compileAppsDoc } = require('../apps-compiler');

const span = { t0: 0, span: 1000, lineCount: 3 };

test('workbuddy trace steps parse generation spans', () => {
  const steps = buildStepsFromSpans([
    { type: 'user_message', message: '写一个 hello world' },
    {
      type: 'generation',
      model: 'gpt-5',
      startedAt: '2026-01-01T00:00:00.000Z',
      toolOutput: JSON.stringify([{
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [{ message: { role: 'assistant', content: 'console.log("hello")' } }],
      }]),
    },
  ], span);
  assert.ok(steps.some(s => s.kind === 'user'));
  const asst = steps.find(s => s.kind === 'assistant');
  assert.ok(asst);
  assert.ok(asst.text.includes('hello'));
  assert.equal(asst.outTok, 20);
  assert.equal(asst.inTok, 10);
});

test('workbuddy generation with tool_calls shows call summary', () => {
  const steps = buildStepsFromSpans([{
    type: 'generation',
    toolInput: JSON.stringify([{ role: 'user', content: [{ type: 'text', text: '<user_query>读文件</user_query>' }] }]),
    toolOutput: JSON.stringify([{
      usage: { prompt_tokens: 100, completion_tokens: 5 },
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' } }],
        },
      }],
    }]),
  }], span);
  assert.ok(steps.some(s => s.kind === 'user' && s.text.includes('读文件')));
  const asst = steps.find(s => s.kind === 'assistant');
  assert.ok(asst.text.includes('Read'));
  assert.equal(asst.inTok, 100);
});

test('workbuddy user prompt is not truncated in trace steps', () => {
  const long = 'A'.repeat(500);
  const steps = buildStepsFromSpans([{
    type: 'generation',
    toolInput: JSON.stringify([{ role: 'user', content: [{ type: 'text', text: `<user_query>${long}</user_query>` }] }]),
    toolOutput: JSON.stringify([{ usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ message: { content: 'ok' } }] }]),
  }], span);
  const user = steps.find(s => s.kind === 'user');
  assert.equal(user.text.length, 500);
});

test('workbuddy list merges traces under same project directory', () => {
  const { mergeRowsByProject } = require('../session-trace/workbuddy-trace');
  const merged = mergeRowsByProject([
    { session_id: 'trace_a', project: '38453', project_path: '/tmp/traces/38453', calls: 1, tokens: 100, lastTs: 100, context: 'hello' },
    { session_id: 'trace_b', project: '38453', project_path: '/tmp/traces/38453', calls: 3, tokens: 200, lastTs: 200, context: 'hello' },
    { session_id: 'trace_c', project: '999', project_path: '/tmp/traces/999', calls: 1, tokens: 50, lastTs: 150, context: 'other' },
  ]);
  assert.equal(merged.length, 2);
  const p38453 = merged.find(r => r.project === '38453');
  assert.equal(p38453.calls, 4);
  assert.equal(p38453.tokens, 300);
  assert.equal(p38453.session_id, 'trace_b');
  assert.equal(p38453.lastTs, 200);
});

test('workbuddy findSessionFile matches by filename without full scan parse', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { findSessionFile, traceBasename, invalidateTraceFileCache } = require('../session-trace/workbuddy-trace');

  assert.equal(traceBasename('trace_abc'), 'trace_abc.json');
  assert.equal(traceBasename('abc'), 'trace_abc.json');

  // 使用临时 HOME，避免依赖开发者本机 ~/.workbuddy/traces
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-trace-'));
  const traceDir = path.join(tmpHome, '.workbuddy', 'traces');
  fs.mkdirSync(traceDir, { recursive: true });
  const traceName = 'trace_e7f75f80e65149bd829193546bde5f1a.json';
  fs.writeFileSync(path.join(traceDir, traceName), '{}');

  const oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  invalidateTraceFileCache();
  try {
    const f = findSessionFile('trace_e7f75f80e65149bd829193546bde5f1a');
    assert.ok(f && f.endsWith(traceName));
  } finally {
    process.env.HOME = oldHome;
    invalidateTraceFileCache();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('workbuddy function span parses toolInput and toolOutput', () => {
  const steps = buildStepsFromSpans([{
    type: 'function',
    toolName: 'Read',
    toolInput: '{"file_path":"/tmp/a"}',
    toolOutput: JSON.stringify({ title: 'Read 11 lines', content: 'line1\nline2' }),
  }], span);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'tool');
  assert.equal(steps[0].tool, 'Read');
  assert.ok(steps[0].text.includes('line1'));
});

test('workbuddy patch_route writes custom model format', () => {
  const { applyRouteToProxyPatch } = require('../app-handlers');
  const routes = [{ id: 'r1', model_key: 'code', scene_name: '代码助手' }];
  const patch = {
    models: [{
      id: 'placeholder',
      name: 'tokenbank',
      vendor: 'TokenBank',
      url: 'http://127.0.0.1:11430/v1/chat/completions',
      apiKey: 'sk-local-test',
      supportsToolCall: true,
      supportsImages: true,
    }],
    availableModels: ['old'],
  };
  const out = applyRouteToProxyPatch('workbuddy-stats', patch, {
    routeId: 'code',
    routes,
    marker: 'tokenbank',
  });
  assert.equal(out.models.length, 1);
  // id 必须是发给网关的 wire model（model_key），scene_name 只是显示名（见 812ff79）
  assert.equal(out.models[0].id, 'code');
  assert.equal(out.models[0].name, 'tokenbank');
  assert.equal(out.models[0].vendor, 'TokenBank');
  assert.equal(out.availableModels, undefined);
});

test('workbuddy patch_route supports multiple routes', () => {
  const { applyRouteToProxyPatch } = require('../app-handlers');
  const routes = [
    { id: 'r1', model_key: 'code', scene_name: '代码助手' },
    { id: 'r2', model_key: 'auto', scene_name: '自动' },
  ];
  const patch = {
    models: [{ id: 'x', name: 'tokenbank', vendor: 'TokenBank', url: 'http://x/v1', apiKey: 'k' }],
  };
  const out = applyRouteToProxyPatch('workbuddy-stats', patch, {
    routeIds: ['code', 'paid:gpt-4o'],
    routes,
  });
  assert.equal(out.models.length, 2);
  assert.equal(out.models[0].id, 'code');
  assert.equal(out.models[1].id, 'gpt-4o');
  assert.ok(out.models.every(m => m.name === 'tokenbank'));
});

test('claude patch_route writes multiple inferenceModels', () => {
  const { applyRouteToProxyPatch } = require('../app-handlers');
  const routes = [
    { id: 'r1', model_key: 'code', scene_name: '代码助手' },
    { id: 'r2', model_key: 'auto', scene_name: '自动' },
  ];
  const patch = {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: 'http://127.0.0.1:11430',
    inferenceGatewayApiKey: 'sk-test',
  };
  const out = applyRouteToProxyPatch('claude-desktop-api', patch, {
    routeIds: ['code', 'paid:gpt-4o'],
    routes,
    claudeName: 'claude-sonnet-4-5',
  });
  assert.equal(out.inferenceModels.length, 2);
  assert.equal(out.inferenceModels[0].name, 'claude-sonnet-4-5');
  assert.equal(out.inferenceModels[0].labelOverride, '代码助手');
  assert.equal(out.inferenceModels[1].labelOverride, 'gpt-4o');
});

test('codex patch_route writes model from first route', () => {
  const { applyRouteToProxyPatch } = require('../app-handlers');
  const routes = [{ id: 'r1', model_key: 'code', scene_name: '代码助手' }];
  const patch = { model_provider: 'tokenbank' };
  const out = applyRouteToProxyPatch('codex-desktop-api', patch, {
    routeIds: ['code', 'paid:gpt-4o'],
    routes,
  });
  assert.equal(out.model, 'code');
});

test('workbuddy handler expands route_multi_select', () => {
  const ent = expandEntity({ id: 'workbuddy', handler: 'workbuddy-stats', vars: { route_multi_select: true } });
  assert.equal(ent.route_multi_select, true);
});

test('workbuddy handler expands gateway + session + trace', () => {
  const ent = expandEntity({ id: 'workbuddy', handler: 'workbuddy-stats' });
  assert.equal(ent.gateway_proxy, true);
  assert.equal(ent.session_trace, true);
  assert.equal(ent.session_usage_import, true);
  assert.equal(ent.trace_profile, 'workbuddy-trace');
  assert.equal(ent.proxy_mode, 'api_key');
  const doc = compileAppsDoc({ app_entities: [{ id: 'workbuddy', handler: 'workbuddy-stats' }] });
  assert.equal(doc.api_key_apps.length, 1);
  assert.equal(doc.session_sources.length, 1);
  assert.equal(doc.session_sources[0].session_trace, true);
});

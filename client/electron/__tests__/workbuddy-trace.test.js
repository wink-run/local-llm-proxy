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
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      toolOutput: JSON.stringify({
        choices: [{ message: { content: 'console.log("hello")' } }],
      }),
    },
  ], span);
  assert.ok(steps.some(s => s.kind === 'user'));
  assert.ok(steps.some(s => s.kind === 'assistant' && s.outTok === 20));
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
  assert.equal(out.models[0].id, '代码助手');
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
  assert.equal(out.models[0].id, '代码助手');
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
  assert.equal(out.model, '代码助手');
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

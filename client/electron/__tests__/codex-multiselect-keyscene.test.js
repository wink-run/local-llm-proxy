'use strict';
// Codex 多选路由：请求的 model 必须精确命中，不能被 gpt-* 兜底盖成 route_ids[0]
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bindRouteToKeyScene } = require('../../shared/route-binding');
const { routeModelId } = require('../app-handlers');
const { resolveBoundScene } = require('../local-gateway');

test('Codex 多选：请求 gpt-5.6-luna 命中 luna，不被主路由 sol 覆盖', () => {
  const routes = [];
  const keyScene = {};
  const codexGptFallback = {};
  const apiKey = 'sk-local-codex';
  const routeIds = ['paid:gpt-5.6-luna', 'paid:gpt-5.6-sol', 'paid:gpt-5.6-terra'];

  const sub = keyScene[apiKey] || (keyScene[apiKey] = {});
  for (const rid of routeIds) {
    const mid = routeModelId(rid, routes);
    bindRouteToKeyScene(sub, mid, rid, routes);
  }
  // 主路由故意设为 sol（旧逻辑会把所有 gpt-* 都盖成它）
  bindRouteToKeyScene(codexGptFallback, apiKey, routeIds[1], routes);

  const hit = resolveBoundScene({
    origModel: 'gpt-5.6-luna',
    callerKey: apiKey,
    isApiKeyCaller: true,
    isClaudeClientName: false,
    claudeKey: null,
    keyScene,
    codexGptFallback,
  });
  assert.ok(hit, '应命中 keyScene');
  assert.equal(hit.scene_name, 'gpt-5.6-luna');
  assert.equal(hit.steps?.[0]?.model, 'gpt-5.6-luna');
});

test('Codex 未知 gpt-* 辅助模型仍兜底到主路由', () => {
  const routes = [];
  const keyScene = {};
  const codexGptFallback = {};
  const apiKey = 'sk-local-codex';
  const routeIds = ['paid:gpt-5.6-luna', 'paid:gpt-5.6-sol'];

  const sub = keyScene[apiKey] || (keyScene[apiKey] = {});
  for (const rid of routeIds) {
    bindRouteToKeyScene(sub, routeModelId(rid, routes), rid, routes);
  }
  bindRouteToKeyScene(codexGptFallback, apiKey, routeIds[0], routes);

  const hit = resolveBoundScene({
    origModel: 'gpt-4.1-mini', // Codex 内建辅助名，未绑定
    callerKey: apiKey,
    isApiKeyCaller: true,
    isClaudeClientName: false,
    claudeKey: null,
    keyScene,
    codexGptFallback,
  });
  assert.ok(hit, '应走 gpt 兜底');
  assert.equal(hit.scene_name, 'gpt-5.6-luna');
  assert.equal(hit.steps?.[0]?.model, 'gpt-5.6-luna');
});

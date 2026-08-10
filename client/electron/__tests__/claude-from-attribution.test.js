'use strict';
// Claude 透明改写标记：不可把 Codex 自指的 claude-* 真实模型误标成 Claude 映射
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bindClaudeCliRouteToKeyScene, bindRouteToKeyScene } = require('../../shared/route-binding');
const { routeModelId } = require('../app-handlers');
const { resolveBoundScene } = require('../local-gateway');

/** 与 local-gateway route() 内 claudeFrom 判定一致 */
function resolveClaudeFrom({
  origModel, claudeKey, shimClaudeScene, isApiKeyCaller, isClaudeClientName, callerKey, keyScene,
}) {
  if (shimClaudeScene) return origModel;
  const keyBucket = (isApiKeyCaller && callerKey) ? keyScene[callerKey] : null;
  const slot = keyBucket
    ? ((claudeKey && keyBucket[claudeKey]) || (isClaudeClientName && keyBucket['*']) || null)
    : null;
  if (!slot) return null;
  const target = slot.steps?.[0]?.model || slot.scene_name || '';
  if (target && (target === origModel || (claudeKey && target === claudeKey))) return null;
  return claudeKey || origModel;
}

test('Claude Code：claude-opus → k3 时标记透明映射', () => {
  const keyScene = {};
  const apiKey = 'sk-claude';
  const cms = ['claude-opus-4-8', 'claude-sonnet-4-5'];
  bindClaudeCliRouteToKeyScene(keyScene, apiKey, 'paid:k3', [], cms);

  const origModel = 'claude-opus-4-8';
  const hit = resolveBoundScene({
    origModel, callerKey: apiKey, isApiKeyCaller: true,
    isClaudeClientName: true, claudeKey: origModel, keyScene, codexGptFallback: {},
  });
  assert.equal(hit.steps[0].model, 'k3');
  const from = resolveClaudeFrom({
    origModel, claudeKey: origModel, shimClaudeScene: null,
    isApiKeyCaller: true, isClaudeClientName: true, callerKey: apiKey, keyScene,
  });
  assert.equal(from, 'claude-opus-4-8');
});

test('Codex 自指绑定 claude-opus-4-8：不标记 Claude 透明映射', () => {
  const keyScene = {};
  const apiKey = 'sk-codex';
  const rid = 'paid:claude-opus-4-8';
  const mid = routeModelId(rid, []);
  const sub = keyScene[apiKey] || (keyScene[apiKey] = {});
  bindRouteToKeyScene(sub, mid, rid, []);

  const origModel = 'claude-opus-4-8';
  const hit = resolveBoundScene({
    origModel, callerKey: apiKey, isApiKeyCaller: true,
    isClaudeClientName: true, claudeKey: origModel, keyScene, codexGptFallback: {},
  });
  assert.equal(hit.steps[0].model, 'claude-opus-4-8');
  const from = resolveClaudeFrom({
    origModel, claudeKey: origModel, shimClaudeScene: null,
    isApiKeyCaller: true, isClaudeClientName: true, callerKey: apiKey, keyScene,
  });
  assert.equal(from, null, '自指不得标成 Claude 映射');
});

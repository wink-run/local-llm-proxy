'use strict';
// Codex CLI 与 Desktop 合并为单一应用：编译与身份归一
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalAppEntityId, applyCloudConfig, loadDoc, expandEntity } = require('../app-handlers');
const { compileAppsDoc, resolveAppsRuntime } = require('../apps-compiler');

test('canonicalAppEntityId：codex-desktop → codex', () => {
  assert.equal(canonicalAppEntityId('codex-desktop'), 'codex');
  assert.equal(canonicalAppEntityId('codex'), 'codex');
  assert.equal(canonicalAppEntityId('claude-code'), 'claude-code');
});

test('default_entities 只有一条 Codex（codex-desktop-api）', () => {
  applyCloudConfig(null);
  const ents = (loadDoc().default_entities || []).filter(e => e?.id);
  const codexLike = ents.filter(e => canonicalAppEntityId(e.id) === 'codex');
  assert.equal(codexLike.length, 1);
  assert.equal(codexLike[0].id, 'codex');
  assert.equal(codexLike[0].handler, 'codex-desktop-api');
});

test('compileAppsDoc：同时存在 codex + codex-desktop 时只输出一条 api_key', () => {
  applyCloudConfig(null);
  const doc = compileAppsDoc({
    entities: [
      { id: 'codex', handler: 'codex-cli', name: 'Codex (CLI)' },
      { id: 'codex-desktop', handler: 'codex-desktop-api', name: 'Codex Desktop' },
      { id: 'cursor', handler: 'cursor-stats', name: 'Cursor' },
    ],
  });
  const codexTools = (doc.tools || []).filter(t => canonicalAppEntityId(t.id) === 'codex');
  const codexApi = (doc.api_key_apps || []).filter(a => canonicalAppEntityId(a.id) === 'codex');
  assert.equal(codexTools.length, 0, '不应再编译 CLI shim');
  assert.equal(codexApi.length, 1);
  assert.equal(codexApi[0].id, 'codex');
  assert.equal(codexApi[0].name, 'Codex');
  assert.ok(codexApi[0].command === 'codex' || codexApi[0].appx, '应带 Desktop 或 CLI 探测');
});

test('统一 Codex 实体具备 resource_project + session_import', () => {
  applyCloudConfig(null);
  const e = expandEntity({ id: 'codex', handler: 'codex-desktop-api' });
  assert.equal(e.resource_project, true);
  assert.equal(e.session_import, true);
  assert.equal(e.proxy_mode, 'api_key');
  assert.equal(e.name, 'Codex');
});

test('resolveAppsRuntime 默认清单不重复列出 Codex', () => {
  applyCloudConfig(null);
  const rt = resolveAppsRuntime({});
  const ids = [
    ...(rt.tools || []).map(t => t.id),
    ...(rt.api_key_apps || []).map(a => a.id),
  ].filter(id => canonicalAppEntityId(id) === 'codex');
  assert.equal(ids.length, 1);
  assert.equal(ids[0], 'codex');
});

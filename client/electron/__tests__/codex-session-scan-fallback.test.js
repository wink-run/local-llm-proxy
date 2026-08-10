'use strict';
// 旧云端 handler 缺 source_id 时，仍能解析 Codex session_scan，避免调用明细被隐藏
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyCloudConfig,
  expandEntity,
  resolveSessionScan,
  handlersMap,
} = require('../app-handlers');
const { compileAppsDoc } = require('../apps-compiler');

before(() => {
  // 模拟旧云端快照：codex-desktop-api.session 无 source_id
  applyCloudConfig({
    handlers: {
      'codex-desktop-api': {
        capabilities: ['gateway_proxy'],
        session: {
          activity_agent_id: 'codex',
          trace_agent_id: 'codex',
          linked_data_sources: ['session-codex'],
          trace: { profile: 'codex-rollout' },
        },
      },
    },
    session_scans: {},
  });
});

test('resolveSessionScan：缺 source_id 时用 activity_agent_id 回落', () => {
  const h = handlersMap()['codex-desktop-api'];
  const scan = resolveSessionScan(h.session, {}, 'codex-desktop-api');
  assert.ok(scan.meta, '应拿到 codex scan 的 meta');
  assert.ok(Array.isArray(scan.meta) && scan.meta.some(m => m.set && m.set.model));
});

test('expandEntity Codex：session_scan 非空，可按模型统计', () => {
  const e = expandEntity({ id: 'codex', handler: 'codex-desktop-api' });
  assert.equal(e.session_import, true);
  assert.ok(e.session_scan && Object.keys(e.session_scan).length > 0);
  assert.ok(Array.isArray(e.session_scan.meta));
  assert.equal(e.session_source_id, 'codex');
});

test('compileAppsDoc：Codex session_sources 带 meta（调用明细依赖）', () => {
  const doc = compileAppsDoc({
    entities: [{ id: 'codex', handler: 'codex-desktop-api', name: 'Codex' }],
  });
  const src = (doc.session_sources || []).find(s => s.agent_id === 'codex');
  assert.ok(src, '应编译出 session_sources');
  assert.ok(Array.isArray(src.meta) && src.meta.some(m => m.set && m.set.model));
});

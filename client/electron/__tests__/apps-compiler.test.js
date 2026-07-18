'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { compileAppsDoc, resolveAppsRuntime } = require('../apps-compiler');

describe('apps-compiler', () => {
  test('compileAppsDoc expands handler capabilities to sections', () => {
    const doc = compileAppsDoc({
      app_entities: [{
        id: 'openclaw',
        handler: 'openclaw-api',
        name: 'OpenClaw',
        vars: {
          capabilities: {
            gateway_proxy: true,
            session_trace: false,
            session_usage_import: false,
          },
        },
      }],
    });
    assert.equal(doc.tools.length, 0);
    assert.equal(doc.api_key_apps.length, 1);
    assert.equal(doc.api_key_apps[0].id, 'openclaw');
    assert.equal(doc.session_sources.length, 0);
    assert.equal(doc.entities_expanded[0].capabilities.gateway_proxy, true);
  });

  test('session-only entity compiles session_sources with trace flags', () => {
    const doc = compileAppsDoc({
      app_entities: [{
        id: 'claude-code',
        handler: 'claude-code-cli',
        vars: {
          capabilities: {
            gateway_proxy: false,
            session_trace: true,
            session_usage_import: true,
          },
        },
      }],
    });
    assert.equal(doc.tools.length, 0);
    assert.equal(doc.session_sources.length, 1);
    const s = doc.session_sources[0];
    assert.equal(s.agent_id, 'claude-code');
    assert.equal(s.session_trace, true);
    assert.equal(s.session_usage_import, true);
    assert.equal(s.standalone, false);
  });

  test('resolveAppsRuntime falls back to default_entities when section missing', () => {
    const rt = resolveAppsRuntime({
      tools: [{ id: 'stale-tool', name: 'Stale' }],
    });
    assert.ok(rt.app_entities.length > 0);
    assert.ok(rt.tools.length > 0);
  });

  test('resolveAppsRuntime compiles from app_entities', () => {
    const rt = resolveAppsRuntime({
      app_entities: [{
        id: 'hermes',
        handler: 'hermes-cli',
        vars: { capabilities: { gateway_proxy: true, session_trace: false, session_usage_import: false } },
      }],
    });
    assert.equal(rt.tools.length, 1);
    assert.equal(rt.tools[0].id, 'hermes');
  });

  // kimi-code-cli：云端实体依赖内置 handler，避免「未知 handler」被 skip
  test('kimi-code-cli compiles to tools with KIMI_MODEL_* inject', () => {
    const rt = resolveAppsRuntime({
      app_entities: [{
        id: 'kimi-code',
        handler: 'kimi-code-cli',
        vars: { capabilities: { gateway_proxy: true, session_trace: false, session_usage_import: false } },
      }],
    });
    assert.equal(rt.tools.length, 1);
    assert.equal(rt.tools[0].id, 'kimi-code');
    assert.equal(rt.tools[0].detect.command, 'kimi');
    assert.equal(rt.tools[0].protocol, 'anthropic');
    assert.equal(rt.tools[0].inject.env.KIMI_MODEL_PROVIDER_TYPE, 'anthropic');
    assert.ok(rt.tools[0].inject.env.KIMI_MODEL_BASE_URL);
    assert.ok(rt.tools[0].inject.env.KIMI_MODEL_API_KEY);
  });

  test('kimi-code-cli with session caps emits session_sources', () => {
    const rt = resolveAppsRuntime({
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
    assert.equal(rt.session_sources.length, 1);
    assert.equal(rt.session_sources[0].id, 'kimi');
    assert.equal(rt.entities_expanded[0].trace_profile, 'kimi-code-trace');
  });

  test('vars provider_id overlays session source', () => {
    const doc = compileAppsDoc({
      app_entities: [{
        id: 'cursor',
        handler: 'cursor-stats',
        vars: {
          capabilities: { gateway_proxy: false, session_trace: true, session_usage_import: true },
          provider_id: 'cursor-custom',
        },
      }],
    });
    assert.equal(doc.session_sources[0].provider_id, 'cursor-custom');
  });
});

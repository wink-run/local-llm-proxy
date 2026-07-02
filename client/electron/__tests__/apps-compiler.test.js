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

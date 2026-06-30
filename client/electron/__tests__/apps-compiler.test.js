'use strict';

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
    expect(doc.tools).toHaveLength(0);
    expect(doc.api_key_apps).toHaveLength(1);
    expect(doc.api_key_apps[0].id).toBe('openclaw');
    expect(doc.session_sources).toHaveLength(0);
    expect(doc.entities_expanded[0].capabilities.gateway_proxy).toBe(true);
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
    expect(doc.tools).toHaveLength(0);
    expect(doc.session_sources).toHaveLength(1);
    const s = doc.session_sources[0];
    expect(s.agent_id).toBe('claude-code');
    expect(s.session_trace).toBe(true);
    expect(s.session_usage_import).toBe(true);
    expect(s.standalone).toBe(false);
  });

  test('resolveAppsRuntime falls back to default_entities when section missing', () => {
    const rt = resolveAppsRuntime({
      tools: [{ id: 'stale-tool', name: 'Stale' }],
    });
    expect(rt.app_entities.length).toBeGreaterThan(0);
    expect(rt.tools.length).toBeGreaterThan(0);
  });

  test('resolveAppsRuntime compiles from app_entities', () => {
    const rt = resolveAppsRuntime({
      app_entities: [{
        id: 'hermes',
        handler: 'hermes-cli',
        vars: { capabilities: { gateway_proxy: true, session_trace: false, session_usage_import: false } },
      }],
    });
    expect(rt.tools).toHaveLength(1);
    expect(rt.tools[0].id).toBe('hermes');
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
    expect(doc.session_sources[0].provider_id).toBe('cursor-custom');
  });
});

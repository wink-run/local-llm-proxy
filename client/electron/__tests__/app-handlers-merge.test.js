'use strict';

// 回归：tokenbank.yaml 的 handlers 是旧目录快照，内置 handler 升级改了 proxy.mode
// （deepseek-harness cli env 注入 → api_key config-file）后，旧快照不得把应用编回 cli 目标。
// handlersMap() 对 mode 冲突应让内置当前形态胜出，同时保留云端在其余字段的定制。

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const ah = require('../app-handlers');
const { loadDoc, applyCloudConfig, handlersMap, applyRouteToProxyPatch } = ah;

const BUNDLED = loadDoc().handlers || {};

after(() => {
  // 复位：避免污染其他用例的云端状态
  applyCloudConfig(null);
});

test('stale cloud handler with conflicting proxy.mode loses to bundled shape', () => {
  applyCloudConfig(null);
  // 旧快照：cli env 注入（proxy.mode 与内置 api_key 冲突）
  applyCloudConfig({
    handlers: {
      'deepseek-harness-cli': {
        label: 'DeepSeek Harness CLI',
        proxy: {
          mode: 'cli',
          protocol: 'openai',
          strategy: 'base_url-env',
          inject_env: { DEEPSEEK_BASE_URL: 'http://{REVERSE}/v1', DEEPSEEK_API_KEY: '{KEY}' },
        },
      },
    },
  });
  const h = handlersMap()['deepseek-harness-cli'];
  assert.equal(h.proxy.mode, 'api_key', 'mode conflict → bundled api_key wins');
  assert.equal(h.proxy.config_file, '{DSH_HOME|~/.dsh}/settings.yaml', 'bundled config_file wins');
  assert.equal(h.proxy.detect_value, 'dsh', 'bundled detect_value wins');
  assert.ok(h.proxy.patch, 'bundled patch present');
});

test('cloud handler with matching mode keeps its custom fields', () => {
  applyCloudConfig(null);
  const bundled = BUNDLED['deepseek-harness-cli'];
  const mode = bundled?.proxy?.mode || 'api_key';
  // 同 mode 的云端定制（如 description 或新增字段）应保留，不被内置冲掉
  applyCloudConfig({
    handlers: {
      'deepseek-harness-cli': {
        ...bundled,
        description: 'custom-cloud-description',
        proxy: { ...(bundled?.proxy || {}), mode },
      },
    },
  });
  const h = handlersMap()['deepseek-harness-cli'];
  assert.equal(h.proxy.mode, mode, 'matching mode unchanged');
  assert.equal(h.description, 'custom-cloud-description', 'cloud custom field preserved');
  // 其余无冲突 handler 仍从内置取（不受影响）
  assert.ok(BUNDLED['claude-code-cli'], 'bundled has claude-code-cli');
});

test('applyCloudConfig(null) clears cloud handlers', () => {
  applyCloudConfig({ handlers: { 'deepseek-harness-cli': { proxy: { mode: 'cli' } } } });
  applyCloudConfig(null);
  const h = handlersMap()['deepseek-harness-cli'];
  assert.equal(h.proxy.mode, 'api_key', 'after clear → bundled default');
});

describe('tokenbank_models patch_route strategy', () => {
  const base = applyRouteToProxyPatch;
  const patch = {
    'llm-pi-ai.providers.tokenbank.baseURL': 'http://127.0.0.1:11430/v1',
    'agent-default-model.provider': 'tokenbank',
  };
  const routes = [
    { id: 'r1', model_key: 'claude-opus-5' },
    { id: 'r2', model_key: 'deepseek-v4-flash' },
    { id: 'r3', model_key: 'claude-opus-5' },
  ];

  test('bound routes fill models as deduped [{ id }]', () => {
    const out = base('deepseek-harness-cli', patch, { routeIds: ['r1', 'r2', 'r3'], routes, marker: 'tokenbank' });
    assert.deepEqual(out['llm-pi-ai.providers.tokenbank.models'], [
      { id: 'claude-opus-5' }, { id: 'deepseek-v4-flash' },
    ]);
  });

  test('no routes → patch unchanged (main.js fallback to full catalog)', () => {
    const out = base('deepseek-harness-cli', patch, { routeIds: [], routes, marker: 'tokenbank' });
    assert.equal(out, patch);
    assert.ok(!('llm-pi-ai.providers.tokenbank.models' in out));
  });

  test('handler declares route_bindable + multi_select', () => {
    const h = handlersMap()['deepseek-harness-cli'];
    assert.equal(h.proxy.route_bindable, true);
    assert.equal(h.proxy.patch_route.strategy, 'tokenbank_models');
    assert.equal(h.proxy.patch_route.multi_select, true);
  });

  // dsh 的 credentials-local 优先读进程环境；Codex 纳管会把 TOKENBANK_API_KEY 写进 shell，
  // 若 dsh 也用同名 apiKeyEnv，流量会被网关记到 Codex，用量明细为空。
  test('dsh apiKeyEnv is unique and does not share TOKENBANK_API_KEY with Codex', () => {
    const h = handlersMap()['deepseek-harness-cli'];
    const envName = h.proxy.patch['llm-pi-ai.providers.tokenbank.apiKeyEnv'];
    assert.equal(envName, 'TOKENBANK_DSH_API_KEY');
    assert.notEqual(envName, 'TOKENBANK_API_KEY');
  });
});

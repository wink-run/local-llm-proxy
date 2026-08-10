'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpHome, prevHome, prevUserProfile, codexCfg;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-catalog-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete require.cache[require.resolve('../codex-config')];
  delete require.cache[require.resolve('../model-context-window')];
  codexCfg = require('../codex-config');
});

after(() => {
  process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

test('writeCodexCatalog：按模型写入不同 context_window，不硬编码 128000', () => {
  const home = path.join(tmpHome, '.codex');
  fs.mkdirSync(home, { recursive: true });
  const r = codexCfg.writeCodexCatalog(home, [
    { name: 'deepseek-v4-flash', vision: false },
    { name: 'glm-5.2', vision: false },
    { name: 'custom', vision: false, contextWindow: 64000 },
  ]);
  assert.equal(r.ok, true);
  const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  const bySlug = Object.fromEntries(doc.models.map((m) => [m.slug, m]));
  assert.equal(bySlug['deepseek-v4-flash'].context_window, 1048576);
  assert.equal(bySlug['deepseek-v4-flash'].max_context_window, 1048576);
  assert.equal(bySlug['glm-5.2'].context_window, 200000);
  assert.equal(bySlug.custom.context_window, 64000);
  // 工具输出截断保持官方默认，不跟会话窗口绑死
  assert.deepEqual(bySlug['deepseek-v4-flash'].truncation_policy, { limit: 10000, mode: 'tokens' });
});

test('cli-endpoint-config：托管只写 BASE_URL+TOKEN，不注入窗口 env（对齐 cc-switch）', () => {
  const { syncCliInstanceEndpointConfig, PROXY_MANAGED_TOKEN } = require('../cli-endpoint-config');
  const dir = fs.mkdtempSync(path.join(tmpHome, 'cc-'));
  const file = path.join(dir, 'settings.json');
  // 模拟历史硬编码窗口 + 无关 env，托管后应被整段替换掉
  fs.writeFileSync(file, JSON.stringify({
    theme: 'dark',
    env: {
      FOO: '1',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '102400',
    },
  }, null, 2));
  const app = {
    link_method: 'shim', agent_id: 'claude-code', hosted: true,
    route_id: 'r1', instance: { config_dir: dir },
  };
  const r = syncCliInstanceEndpointConfig(app, {
    expandHome: (p) => p,
    gatewayOrigin: 'http://127.0.0.1:11430',
  });
  assert.equal(r, 'routed');
  const env = JSON.parse(fs.readFileSync(file, 'utf8')).env;
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED_TOKEN);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11430');
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.ok(!('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in env));
  assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env));
});

'use strict';
// CLI 兼容端点实例 settings.json 托管：选路由→改写指向网关；直连/还原→还原原始(兼容端点)配置。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { syncCliInstanceEndpointConfig, isGatewayBaseUrl } = require('../cli-endpoint-config');

const GW = 'http://127.0.0.1:11430';
const OPTS = { expandHome: (p) => p, gatewayOrigin: GW };

function mkInstance(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-endpoint-'));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const FORTINET = {
  env: {
    ANTHROPIC_AUTH_TOKEN: 'sk-orig',
    ANTHROPIC_BASE_URL: 'https://nac-ai-dev.fortinet-us.com/',
    ANTHROPIC_SMALL_FAST_MODEL: 'forti-coder',
    DISABLE_TELEMETRY: 'true',
  },
  model: 'forti-coder',
  theme: 'dark',
};
const appFor = (dir, extra = {}) => ({
  link_method: 'shim', agent_id: 'claude-code', api_key: 'sk-local-abc',
  hosted: true, route_id: 'p2p:minimax-m3', instance: { config_dir: dir }, ...extra,
});

test('选路由：改写 settings.json 指向网关 + 本实例 api_key，备份保留原始 Fortinet', () => {
  const dir = mkInstance(FORTINET);
  const file = path.join(dir, 'settings.json');
  const bak = file + '.tokenbank-bak';
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), OPTS), 'routed');
  const s = rd(file);
  assert.equal(s.env.ANTHROPIC_BASE_URL, GW);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'sk-local-abc');
  // 整段替换：env 只剩网关两项，原兼容端点的任何 env 键都不残留
  assert.deepEqual(Object.keys(s.env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.ok(!('ANTHROPIC_SMALL_FAST_MODEL' in s.env), '去掉写死的 fast model');
  assert.ok(!('DISABLE_TELEMETRY' in s.env), '原 env 其它键也不保留');
  assert.ok(!('model' in s), '去掉写死的 model（路由由网关决定）');
  assert.equal(s.theme, 'dark', '顶层非 env 键保留');
  assert.ok(fs.existsSync(bak));
  assert.match(rd(bak).env.ANTHROPIC_BASE_URL, /fortinet/);
  assert.equal(rd(bak).env.ANTHROPIC_AUTH_TOKEN, 'sk-orig');
  assert.equal(rd(bak).env.DISABLE_TELEMETRY, 'true', '备份保留原始完整 env');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('幂等：再次选路由不会把网关配置当作原始配置备份', () => {
  const dir = mkInstance(FORTINET);
  const bak = path.join(dir, 'settings.json.tokenbank-bak');
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);
  assert.match(rd(bak).env.ANTHROPIC_BASE_URL, /fortinet/, '备份仍是 Fortinet');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('直连（route 清空，hosted 仍 true）：还原回原始 Fortinet 配置', () => {
  const dir = mkInstance(FORTINET);
  const file = path.join(dir, 'settings.json');
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);                       // 先托管
  const r = syncCliInstanceEndpointConfig(appFor(dir, { route_id: null, route_ids: null }), OPTS);
  assert.equal(r, 'direct');
  const s = rd(file);
  assert.match(s.env.ANTHROPIC_BASE_URL, /fortinet/);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'sk-orig');
  assert.equal(s.env.DISABLE_TELEMETRY, 'true', '还原后原 env 键完整回来');
  assert.equal(s.model, 'forti-coder');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forceDirect（取消托管/退出）：即便记录里仍有 route 也强制还原', () => {
  const dir = mkInstance(FORTINET);
  const file = path.join(dir, 'settings.json');
  syncCliInstanceEndpointConfig(appFor(dir), OPTS);
  const r = syncCliInstanceEndpointConfig(appFor(dir), { ...OPTS, forceDirect: true });
  assert.equal(r, 'direct');
  assert.match(rd(file).env.ANTHROPIC_BASE_URL, /fortinet/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OAuth 实例（settings.json 无自定义 base_url）：不接管、不生成备份', () => {
  const dir = mkInstance({ theme: 'dark' });
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), OPTS), 'skip');
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json.tokenbank-bak')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无 settings.json 的实例：安全跳过', () => {
  const dir = mkInstance(null);
  assert.equal(syncCliInstanceEndpointConfig(appFor(dir), OPTS), 'skip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isGatewayBaseUrl 判定', () => {
  assert.ok(isGatewayBaseUrl('http://127.0.0.1:11430'));
  assert.ok(isGatewayBaseUrl('http://localhost:11430/'));
  assert.ok(!isGatewayBaseUrl('https://nac-ai-dev.fortinet-us.com/'));
  assert.ok(!isGatewayBaseUrl(''));
});

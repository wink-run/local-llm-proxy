'use strict';
// shim 多账号分发：选账号(CONFIG_DIR)永远执行(不受探活门控)；走网关(base_url+token)受探活门控，
// 且按实例区分——路由态注 token、直连态 unset 网关 env(退回该 config-dir 自身配置)。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const shim = require('../shim-installer');

const WIN = process.platform === 'win32';
const CMD = '__tb_shim_dispatch_test__';
function gen(dispatch, base, baseSel) {
  const p = shim.writeShim(CMD, '/bin/echo', base, dispatch, baseSel);
  const txt = fs.readFileSync(p, 'utf8');
  try { fs.unlinkSync(p); } catch {}
  return txt;
}

test('多账号：选账号在探活门之外；直连实例 unset 网关；路由实例注 token', { skip: WIN }, () => {
  const txt = gen(
    [
      { dir: '/h/code', selectEnv: { CLAUDE_CONFIG_DIR: '/h/.claude-code' }, gatewayEnv: null },
      { dir: '/h/work', selectEnv: { CLAUDE_CONFIG_DIR: '/h/.claude-work' }, gatewayEnv: { ANTHROPIC_AUTH_TOKEN: 'sk-work' } },
    ],
    { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11430', ANTHROPIC_AUTH_TOKEN: 'sk-def' },
    { CLAUDE_CONFIG_DIR: '/h/.claude' },
  );
  const ifIdx = txt.indexOf('if curl');
  const selIdx = txt.indexOf('CLAUDE_CONFIG_DIR="/h/.claude-code"');
  assert.ok(ifIdx > 0, '应有探活块');
  assert.ok(selIdx >= 0 && selIdx < ifIdx, '选账号 CONFIG_DIR 必须在探活门之前（永远执行）');
  // 默认实例的 CONFIG_DIR 也在门外
  assert.ok(txt.indexOf('export CLAUDE_CONFIG_DIR="/h/.claude"') < ifIdx, '默认 CONFIG_DIR 也在探活门外');
  // 直连实例：探活块内 unset 网关 env
  assert.match(txt, /"\/h\/code\/"\*\)\s*unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ;;/);
  // 路由实例：注入自己的 token
  assert.match(txt, /"\/h\/work\/"\*\)\s*export ANTHROPIC_AUTH_TOKEN="sk-work" ;;/);
  // 基础网关 base_url 在探活块内
  assert.ok(txt.indexOf('ANTHROPIC_BASE_URL="http://127.0.0.1:11430"') > ifIdx, '基础网关 base_url 在探活块内');
});

test('单实例（无 dispatch）：不含目录分发 case，结构不变', { skip: WIN }, () => {
  const txt = gen([], { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11430', ANTHROPIC_AUTH_TOKEN: 'sk-x' }, {});
  assert.ok(!txt.includes('case "$PWD/"'), '单实例不应有目录分发 case');
  assert.match(txt, /if curl -s -o \/dev\/null -m 1 "http:\/\/127\.0\.0\.1:11430\/health" 2>\/dev\/null; then/);
  assert.match(txt, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:11430"/);
});

test('直连态但默认路由：TokenBank 关着时（探活失败）仍已切好账号', { skip: WIN }, () => {
  // 探活失败 → 整个 if 块跳过，但选账号 case 在 if 之前 → CONFIG_DIR 已设 → 仍走该账号自身配置
  const txt = gen(
    [{ dir: '/h/code', selectEnv: { CLAUDE_CONFIG_DIR: '/h/.claude-code' }, gatewayEnv: null }],
    { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11430', ANTHROPIC_AUTH_TOKEN: 'sk-def' },
    {},
  );
  const lines = txt.split('\n');
  const caseLine = lines.findIndex(l => l.includes('/h/code/'));
  const ifLine = lines.findIndex(l => l.includes('if curl'));
  assert.ok(caseLine >= 0 && ifLine >= 0 && caseLine < ifLine, '选账号必须在探活 if 之前');
});

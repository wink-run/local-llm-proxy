'use strict';
// 多账号兜底实例选择：优先「留空 dir_glob」，否则回落 is_default，最后取第一个。
const { test } = require('node:test');
const assert = require('node:assert');
const { pickFallbackInstance, buildGatewayEnv, setKeyResolver } = require('../agent-linker');

test('留空 dir_glob 的实例优先当兜底（即便它不是默认目录）', () => {
  const insts = [
    { config_dir: '/h/.claude',   is_default: true,  dir_glob: '~/root' },   // 默认目录，但绑了 root
    { config_dir: '/h/.claude-2', is_default: false, dir_glob: null },       // 非默认但留空 → 兜底
    { config_dir: '/h/.claude-3', is_default: false, dir_glob: '~/code' },
  ];
  assert.equal(pickFallbackInstance(insts).config_dir, '/h/.claude-2');
});

test('都填了目录（无留空）→ 回落 is_default 实例', () => {
  const insts = [
    { config_dir: '/h/.claude-a', is_default: false, dir_glob: '~/a' },
    { config_dir: '/h/.claude',   is_default: true,  dir_glob: '~/b' },
    { config_dir: '/h/.claude-c', is_default: false, dir_glob: '~/c' },
  ];
  assert.equal(pickFallbackInstance(insts).config_dir, '/h/.claude');
});

test('两个都是非默认且都填了目录 → 取第一个（永远有兜底，不会没账号）', () => {
  const insts = [
    { config_dir: '/h/.claude-x', is_default: false, dir_glob: '~/x' },
    { config_dir: '/h/.claude-y', is_default: false, dir_glob: '~/y' },
  ];
  assert.equal(pickFallbackInstance(insts).config_dir, '/h/.claude-x');
});

test('默认实例留空（经典布局）→ 默认即兜底', () => {
  const insts = [
    { config_dir: '/h/.claude',   is_default: true,  dir_glob: null },
    { config_dir: '/h/.claude-2', is_default: false, dir_glob: '~/code' },
  ];
  assert.equal(pickFallbackInstance(insts).config_dir, '/h/.claude');
});

test('空列表 → null，不抛', () => {
  assert.equal(pickFallbackInstance([]), null);
  assert.equal(pickFallbackInstance(null), null);
});

// 画像挖掘 / Debug spawn：Claude 已绑路由时应注 AUTH_TOKEN，避免依赖过期 OAuth
test('buildGatewayEnv: Claude 已绑路由 → 注入 ANTHROPIC_AUTH_TOKEN', () => {
  setKeyResolver(() => 'sk-local-test-key');
  try {
    const env = buildGatewayEnv('claude-code');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-local-test-key');
    assert.ok(env.ANTHROPIC_BASE_URL, '应保留网关 BASE_URL');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  } finally {
    setKeyResolver(null);
  }
});

test('buildGatewayEnv: Claude 未绑路由 → 不注入 AUTH_TOKEN（走 OAuth）', () => {
  setKeyResolver(() => null);
  try {
    const env = buildGatewayEnv('claude-code');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  } finally {
    setKeyResolver(null);
  }
});

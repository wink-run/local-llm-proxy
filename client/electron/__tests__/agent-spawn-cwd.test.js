'use strict';
// 打包后 Agent spawn cwd / env：避免 .app 目录 getcwd EPERM
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const {
  isUnsafeSpawnCwd, dirIsSpawnable, safeAgentCwd, sanitizeAgentSpawnEnv,
} = require('../agent-executor');

test('isUnsafeSpawnCwd：.app/Contents 与 AppTranslocation 不可作子进程 cwd', () => {
  assert.equal(isUnsafeSpawnCwd('/Applications/Token Bank.app/Contents/MacOS'), true);
  assert.equal(
    isUnsafeSpawnCwd('/private/var/folders/xx/AppTranslocation/yyyy/d/Token Bank.app/Contents/MacOS'),
    true,
  );
  assert.equal(isUnsafeSpawnCwd('/Users/ully/githubprojects/local-llm-proxy'), false);
  assert.equal(isUnsafeSpawnCwd(os.homedir()), false);
});

test('dirIsSpawnable：home 可读，.app 路径拒绝', () => {
  assert.equal(dirIsSpawnable(os.homedir()), true);
  assert.equal(dirIsSpawnable('/Applications/Token Bank.app/Contents/MacOS'), false);
  assert.equal(dirIsSpawnable('/no/such/dir-' + Date.now()), false);
});

test('safeAgentCwd：优先可用工作区，跳过 .app cwd', () => {
  const home = os.homedir();
  assert.equal(safeAgentCwd(home), path.resolve(home));
  const appMacos = '/Applications/Token Bank.app/Contents/MacOS';
  const got = safeAgentCwd(appMacos);
  assert.ok(got !== path.resolve(appMacos));
  assert.equal(dirIsSpawnable(got), true);
});

test('sanitizeAgentSpawnEnv：写 PWD、去掉 ELECTRON_RUN_AS_NODE、补 PATH', () => {
  const cwd = os.homedir();
  const env = sanitizeAgentSpawnEnv({
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ASAR: '1',
    PATH: '/usr/bin',
    OLDPWD: '/Applications/Token Bank.app/Contents/MacOS',
    HOME: cwd,
  }, cwd);
  assert.equal(env.PWD, path.resolve(cwd));
  assert.equal(env.INIT_CWD, path.resolve(cwd));
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.ELECTRON_NO_ASAR, undefined);
  assert.equal(env.OLDPWD, undefined);
  assert.ok(env.PATH.includes('/usr/bin'));
  assert.ok(env.PATH.split(':').length > 1, '应补上 Homebrew/nvm 等目录');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseScutilProxy,
  parseWinProxyServer,
  hasProxyEnv,
  injectProxyEnv,
} = require('../../shared/inject-proxy-env');

test('parseScutilProxy: HTTPS 优先', () => {
  assert.equal(parseScutilProxy(`
HTTPEnable : 1
HTTPPort : 7890
HTTPProxy : 127.0.0.1
HTTPSEnable : 1
HTTPSPort : 7890
HTTPSProxy : 127.0.0.1
`), 'http://127.0.0.1:7890');
});

test('parseWinProxyServer', () => {
  assert.equal(parseWinProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseWinProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('injectProxyEnv: 已有环境变量时不覆盖', () => {
  const prev = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://already:1';
  assert.equal(hasProxyEnv(), true);
  assert.equal(injectProxyEnv(), null);
  if (prev === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = prev;
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeServerBase,
  defaultServerUrlFromEnv,
  DEFAULT_TOKEN_SERVER_URL,
} = require('../../shared/default-server-url');

// 保存并恢复环境变量，避免污染其他测试
function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('normalizeServerBase 去除尾部斜杠与 /api、/v1 后缀', () => {
  assert.equal(normalizeServerBase('https://example.com/'), 'https://example.com');
  assert.equal(normalizeServerBase('https://example.com/api'), 'https://example.com');
  assert.equal(normalizeServerBase('https://example.com/v1'), 'https://example.com');
  assert.equal(normalizeServerBase('https://example.com/api/v1'), 'https://example.com');
  assert.equal(normalizeServerBase(''), '');
});

test('defaultServerUrlFromEnv 优先 TOKEN_SERVER_URL', () => {
  withEnv({ TOKEN_SERVER_URL: 'https://custom.example.com/', TOKENBANK_SERVER_URL: undefined }, () => {
    assert.equal(defaultServerUrlFromEnv(), 'https://custom.example.com');
  });
});

test('defaultServerUrlFromEnv 兼容 TOKENBANK_SERVER_URL', () => {
  withEnv({ TOKEN_SERVER_URL: undefined, TOKENBANK_SERVER_URL: 'https://legacy.example.com' }, () => {
    assert.equal(defaultServerUrlFromEnv(), 'https://legacy.example.com');
  });
});

test('defaultServerUrlFromEnv 未配置时回退官方默认', () => {
  withEnv({ TOKEN_SERVER_URL: undefined, TOKENBANK_SERVER_URL: undefined }, () => {
    assert.equal(defaultServerUrlFromEnv(), DEFAULT_TOKEN_SERVER_URL);
  });
});

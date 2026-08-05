'use strict';
// community-agent-client：Windows / 开发态须能读到 Electron userData 下的 cloud_config
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpHome;
let prevHome;
let prevUserProfile;
let prevAppData;
let prevTbUserData;
let client;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-community-auth-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevAppData = process.env.APPDATA;
  prevTbUserData = process.env.TB_USER_DATA;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // 模拟 Windows Roaming（非 win32 也走 APPDATA 分支需手动测；此处用 TB_USER_DATA 覆盖）
  const roaming = path.join(tmpHome, 'AppData', 'Roaming');
  process.env.APPDATA = roaming;
  delete process.env.TB_USER_DATA;

  const ud = path.join(roaming, 'llm-proxy-client');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'local-config.json'), JSON.stringify({
    cloud_config: {
      url: 'https://example.tokenbank.test',
      token: 'sk-test-relay-key',
    },
  }), 'utf8');

  // 清缓存后按临时 HOME 加载
  const resolved = require.resolve('../community-agent-client');
  delete require.cache[resolved];
  client = require('../community-agent-client');
});

after(() => {
  process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = prevAppData;
  if (prevTbUserData === undefined) delete process.env.TB_USER_DATA;
  else process.env.TB_USER_DATA = prevTbUserData;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

test('resolveCloudAuth 可读 %APPDATA%/llm-proxy-client（Windows 开发态路径）', () => {
  // 非 win32 时 candidate 不含 APPDATA 分支：用 TB_USER_DATA 验证同源逻辑
  if (process.platform !== 'win32') {
    process.env.TB_USER_DATA = path.join(process.env.APPDATA, 'llm-proxy-client');
    const resolved = require.resolve('../community-agent-client');
    delete require.cache[resolved];
    client = require('../community-agent-client');
  }
  const auth = client.resolveCloudAuth();
  assert.equal(auth.token, 'sk-test-relay-key');
  assert.equal(auth.base, 'https://example.tokenbank.test');
});

test('resolveCloudAuth 优先 TB_USER_DATA', () => {
  const custom = path.join(tmpHome, 'custom-ud');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'local-config.json'), JSON.stringify({
    cloud_config: { url: 'https://custom.test', token: 'sk-custom' },
  }), 'utf8');
  process.env.TB_USER_DATA = custom;
  const resolved = require.resolve('../community-agent-client');
  delete require.cache[resolved];
  client = require('../community-agent-client');
  const auth = client.resolveCloudAuth();
  assert.equal(auth.token, 'sk-custom');
  assert.equal(auth.base, 'https://custom.test');
});

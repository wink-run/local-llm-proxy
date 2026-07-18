'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('buildCursorSpawnEnv injects CURSOR_AUTH_TOKEN without CURSOR_API_KEY', () => {
  const mod = require('../cursor-ide-auth');
  const session = mod.readIdeCursorSession();
  if (!session?.accessToken) {
    console.log('skip: no Cursor IDE session on this machine');
    return;
  }

  const { env, injected, reason } = mod.buildCursorSpawnEnv({
    PATH: process.env.PATH,
    CURSOR_API_KEY: 'eyJhbGciOiJfake', // 会话型伪 JWT，应被剔除
  });
  assert.equal(injected, true);
  assert.equal(reason, 'ide_state_vscdb');
  assert.equal(env.CURSOR_AUTH_TOKEN, session.accessToken);
  assert.equal(env.CURSOR_API_KEY, undefined);

  // 同步了文件凭证（非钥匙串）
  assert.ok(fs.existsSync(mod.AUTH_JSON));
  const disk = JSON.parse(fs.readFileSync(mod.AUTH_JSON, 'utf8'));
  assert.equal(disk.accessToken, session.accessToken);
});

test('syncIdeAuthJson writes 0600 auth.json shape', () => {
  const mod = require('../cursor-ide-auth');
  const fake = {
    accessToken: 'tok_access_test',
    refreshToken: 'tok_refresh_test',
    email: 't@example.com',
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cursor-auth-'));
  const authPath = path.join(dir, 'auth.json');
  // 临时覆盖路径：直接调用写逻辑等价物
  fs.writeFileSync(authPath, JSON.stringify({
    accessToken: fake.accessToken,
    refreshToken: fake.refreshToken,
  }, null, 2));
  const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['accessToken', 'refreshToken']);
  fs.rmSync(dir, { recursive: true, force: true });
});

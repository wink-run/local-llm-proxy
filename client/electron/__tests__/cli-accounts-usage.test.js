'use strict';
// 多账号 CLI 额度：凭证读取(claude ms→s / codex jwt exp) + 有效性判断的纯逻辑。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readAccountCreds, tokenValid } = require('../usage/cli-accounts');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-usage-')); }

test('readAccountCreds(claude)：从 .credentials.json 读，expiresAt 毫秒→秒', () => {
  const d = tmpdir();
  const expMs = Date.now() + 3600_000;
  fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: expMs, subscriptionType: 'max' } }));
  const c = readAccountCreds('claude-code', d);
  assert.equal(c.access_token, 'a');
  assert.equal(c.refresh_token, 'r');
  assert.equal(c.expires_at, Math.floor(expMs / 1000), 'ms→s');
  assert.equal(c.subscriptionType, 'max');
});

test('readAccountCreds(codex)：从 auth.json 读，过期时间从 id_token JWT exp', () => {
  const d = tmpdir();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64').replace(/=+$/, '');
  const idtok = `h.${payload}.s`;
  fs.writeFileSync(path.join(d, 'auth.json'), JSON.stringify({ tokens: { access_token: 'x', refresh_token: 'y', id_token: idtok, account_id: 'acc' } }));
  const c = readAccountCreds('codex', d);
  assert.equal(c.access_token, 'x');
  assert.equal(c.expires_at, exp, 'jwt exp');
  assert.equal(c.account_id, 'acc');
});

test('readAccountCreds：无凭证文件 → null', () => {
  assert.equal(readAccountCreds('claude-code', tmpdir()), null);
});

test('tokenValid：未过期=true，过期=false，无 expires_at=当作有效', () => {
  const now = Date.now() / 1000;
  assert.equal(tokenValid({ access_token: 'a', expires_at: now + 600 }), true);
  assert.equal(tokenValid({ access_token: 'a', expires_at: now - 10 }), false);
  assert.equal(tokenValid({ access_token: 'a', expires_at: null }), true);
  assert.equal(tokenValid({ expires_at: now + 600 }), false, '无 access_token=false');
});

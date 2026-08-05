'use strict';
// Codex Desktop：缺 config.toml 时 allowCreate 可新建；还原时删除自建文件
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpHome;
let prevHome;
let prevUserProfile;
let codexCfg;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-create-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // 清掉已缓存模块，使 STATE_DIR 读到临时 HOME
  const resolved = require.resolve('../codex-config');
  delete require.cache[resolved];
  codexCfg = require('../codex-config');
});

after(() => {
  process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

test('applyCodexProvider 缺文件且无 allowCreate → config-missing', () => {
  const cfg = path.join(tmpHome, '.codex-a', 'config.toml');
  const r = codexCfg.applyCodexProvider(cfg, {
    baseUrl: 'http://127.0.0.1:11430/v1', model: 'gpt-5', bearerToken: 'k',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config-missing');
  assert.ok(!fs.existsSync(cfg));
});

test('applyCodexProvider allowCreate 可新建并写入 provider', () => {
  const dir = path.join(tmpHome, '.codex-b');
  const cfg = path.join(dir, 'config.toml');
  fs.mkdirSync(dir, { recursive: true });
  const r = codexCfg.applyCodexProvider(cfg, {
    baseUrl: 'http://127.0.0.1:11430/v1', model: 'gpt-5', bearerToken: 'k',
    allowCreate: true,
  });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(cfg));
  const txt = fs.readFileSync(cfg, 'utf8');
  assert.match(txt, /model_provider\s*=\s*"tokenbank"/);
  assert.match(txt, /\[model_providers\.tokenbank\]/);
  // 新建文件不应产生「原始备份」
  assert.ok(!fs.existsSync(cfg + '.tokenbank-bak'));
});

test('revertCodexProvider 删除自建 config.toml', () => {
  const dir = path.join(tmpHome, '.codex-c');
  const cfg = path.join(dir, 'config.toml');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(codexCfg.applyCodexProvider(cfg, {
    baseUrl: 'http://127.0.0.1:11430/v1', model: 'm', bearerToken: 'k',
    allowCreate: true,
  }).ok, true);
  assert.ok(fs.existsSync(cfg));
  const rev = codexCfg.revertCodexProvider(cfg);
  assert.equal(rev.ok, true);
  assert.ok(!fs.existsSync(cfg), '自建文件还原后应删除');
});

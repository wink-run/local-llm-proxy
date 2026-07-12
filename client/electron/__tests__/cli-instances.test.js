'use strict';
// CLI 多账号实例扫描：枚举 ~/.claude + ~/.claude-* 独立 CONFIG_DIR，各读账号邮箱。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanClaudeInstances, enumConfigDirs, reconcileCliInstances } = require('../cli-instances');

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-'));
  const mk = (dir, email, sub) => {
    const d = path.join(home, dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', subscriptionType: sub, expiresAt: 123 } }));
    if (email) fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: 'uuid-' + dir } }));
  };
  return { home, mk };
}

test('枚举默认目录 + 同级 -* 目录，跳过 .claude.json 文件', () => {
  const { home, mk } = mkHome();
  mk('.claude', 'default@x.com', 'max');
  mk('.claude-work', 'work@x.com', 'pro');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');       // 文件，应被跳过
  fs.writeFileSync(path.join(home, '.claude.json.backup'), '{}');
  const dirs = enumConfigDirs('.claude', null, home).map(d => path.basename(d)).sort();
  assert.deepEqual(dirs, ['.claude', '.claude-work']);
});

test('每个 CONFIG_DIR = 一个账号实例，抽出邮箱/订阅/凭证', () => {
  const { home, mk } = mkHome();
  mk('.claude', 'default@x.com', 'max');
  mk('.claude-work', 'work@company.com', 'pro');
  const insts = scanClaudeInstances(home).sort((a, b) => a.config_dir.localeCompare(b.config_dir));
  assert.equal(insts.length, 2);
  const byEmail = Object.fromEntries(insts.map(i => [i.account_email, i]));
  assert.ok(byEmail['default@x.com'].is_default);
  assert.equal(byEmail['default@x.com'].subscription, 'max');
  assert.equal(byEmail['work@company.com'].is_default, false);
  assert.equal(byEmail['work@company.com'].subscription, 'pro');
  assert.ok(insts.every(i => i.has_credentials));
});

test('无凭证的目录也列出（account 为 null），不崩', () => {
  const { home } = mkHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });   // 空目录，无凭证
  const insts = scanClaudeInstances(home);
  assert.equal(insts.length, 1);
  assert.equal(insts[0].has_credentials, false);
  assert.equal(insts[0].account_email, null);
});

test('对账：迁移旧 shim 记录、保留用户路由、追加新账号、失效标记', () => {
  const apps = [
    { id: 'app-shim-claude-code', agent_id: 'claude-code', link_method: 'shim', route_id: 'llm-router-auto' }, // 旧记录，无 instance
    { id: 'app-other', agent_id: null, link_method: 'manual' },
  ];
  const scanned = [
    { tool: 'claude-code', config_dir: '/h/.claude', is_default: true, account_email: 'a@x.com', subscription: 'max', has_credentials: true },
    { tool: 'claude-code', config_dir: '/h/.claude-work', is_default: false, account_email: 'w@x.com', subscription: 'pro', has_credentials: true },
  ];
  let seq = 0;
  const makeRecord = (inst) => ({ id: 'new-' + (seq++), agent_id: inst.tool, link_method: 'shim', route_id: null,
    instance: { config_dir: inst.config_dir, is_default: inst.is_default, account_email: inst.account_email, dir_glob: null } });

  const { apps: out, added } = reconcileCliInstances(apps, scanned, makeRecord);
  const claudeRecs = out.filter(a => a.agent_id === 'claude-code');
  assert.equal(claudeRecs.length, 2, '默认迁移到旧记录 + 新增 1 条 = 2');
  // 旧记录迁移：保留 route_id，附上默认 instance
  const migrated = out.find(a => a.id === 'app-shim-claude-code');
  assert.equal(migrated.route_id, 'llm-router-auto', '保留用户路由');
  assert.equal(migrated.instance.config_dir, '/h/.claude');
  assert.equal(migrated.instance.account_email, 'a@x.com');
  assert.ok(migrated.instance.is_default);
  // 新账号追加
  assert.equal(added.length, 1);
  assert.equal(added[0].instance.account_email, 'w@x.com');
  // 非 claude 记录不动
  assert.ok(out.find(a => a.id === 'app-other'));
});

test('对账幂等：二次扫描不重复追加；目录消失则标 invalid', () => {
  const apps = [
    { id: 'r1', agent_id: 'claude-code', link_method: 'shim', route_id: 'x', instance: { config_dir: '/h/.claude', is_default: true, dir_glob: '~/a' } },
    { id: 'r2', agent_id: 'claude-code', link_method: 'shim', route_id: null, instance: { config_dir: '/h/.claude-work', is_default: false } },
  ];
  // 二次扫描：work 目录没了
  const scanned = [{ tool: 'claude-code', config_dir: '/h/.claude', is_default: true, account_email: 'a@x.com', has_credentials: true }];
  const { apps: out, added } = reconcileCliInstances(apps, scanned, () => { throw new Error('不该造新记录'); });
  assert.equal(added.length, 0, '幂等，无新增');
  assert.equal(out.find(a => a.id === 'r1').instance.dir_glob, '~/a', '保留 dir_glob');
  assert.equal(out.find(a => a.id === 'r2').instance.invalid, true, '消失的目录标 invalid');
});

test('账户并集：scanned ∪ personal 按 email 去重，标 source/has_local/already_added', () => {
  const path = require('path');
  const { mergeAccountOptions } = require('../cli-instances');
  const scanned = [
    { account_email: 'a@x.com', config_dir: '/h/.claude', is_default: true, subscription: 'max' },
    { account_email: 'w@x.com', config_dir: '/h/.claude-work', is_default: false },
  ];
  const personal = [
    { email: 'a@x.com', subscription: 'max' },        // 与 scanned 重叠 → both
    { email: 'p@x.com', subscription: 'pro' },        // 仅个人源，无本机登录
  ];
  const existing = new Set([path.resolve('/h/.claude')]);   // 默认已建记录
  const out = mergeAccountOptions(scanned, personal, existing);
  const by = Object.fromEntries(out.map(o => [o.email, o]));
  assert.equal(out.length, 3, 'a(去重) + w + p');
  assert.equal(by['a@x.com'].source, 'both');
  assert.equal(by['a@x.com'].has_local, true);
  assert.equal(by['a@x.com'].already_added, true);
  assert.equal(by['w@x.com'].source, 'scanned');
  assert.equal(by['w@x.com'].already_added, false);
  assert.equal(by['p@x.com'].source, 'personal');
  assert.equal(by['p@x.com'].has_local, false);
  assert.equal(by['p@x.com'].config_dir, null);
});

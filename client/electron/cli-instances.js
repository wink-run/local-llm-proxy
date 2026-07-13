// client/electron/cli-instances.js
// 扫描 CLI 工具（claude / codex）的多账号实例：每个独立 CONFIG_DIR = 一个账号实例。
// 纯只读：枚举 ~/.claude、~/.claude-* 等同级 CONFIG_DIR，各读 .credentials.json + 账号邮箱。
// 供「首次启动 / 百宝箱装完 / 手动重扫」统一调用，发现结果交由上层生成 app 实例记录。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isGatewayBaseUrl } = require('./cli-endpoint-config');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// 读实例的「纳管前」settings.json（真实来源）：当前 settings.json 若已被 TokenBank 改写成
// 指向网关，则用 .tokenbank-bak（原始备份）；否则当前文件本身就是原始。返回 { orig, managed }。
// managed=true 表示该实例的 settings.json 当前正被 TokenBank 托管（指向网关）。
function readOriginalSettings(dir) {
  const file = path.join(dir, 'settings.json');
  const cur = readJson(file);
  const curManaged = isGatewayBaseUrl(cur && cur.env && cur.env.ANTHROPIC_BASE_URL);
  if (curManaged) {
    const bak = readJson(file + '.tokenbank-bak');
    const bakManaged = isGatewayBaseUrl(bak && bak.env && bak.env.ANTHROPIC_BASE_URL);
    return { orig: (bak && !bakManaged) ? bak : cur, managed: true };
  }
  return { orig: cur, managed: false };
}

// 枚举 home 下 base（如 .claude）本体 + 同级 base-*（如 .claude-work）目录。
// 只认目录，跳过 .claude.json 这类文件。附带 env 指定的 CONFIG_DIR（可能在别处）。
// home 可注入（测试用），默认 os.homedir()。
function enumConfigDirs(base, envDir, home = os.homedir()) {
  const out = new Set();
  const def = path.join(home, base);
  if (fs.existsSync(def) && fs.statSync(def).isDirectory()) out.add(def);
  try {
    for (const name of fs.readdirSync(home)) {
      if (name === base) continue;
      if (!name.startsWith(base + '-')) continue;
      const full = path.join(home, name);
      try { if (fs.statSync(full).isDirectory()) out.add(full); } catch {}
    }
  } catch {}
  if (envDir) {
    const abs = path.isAbsolute(envDir) ? envDir : path.join(home, envDir);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) out.add(abs);
  }
  return [...out];
}

// 是否默认 CONFIG_DIR（~/.claude 或 ~/.codex）——决定账号配置是否回落到 home 根的旧路径。
function isDefaultDir(dir, base, home = os.homedir()) {
  return path.resolve(dir) === path.resolve(path.join(home, base));
}

/** 扫描 Claude Code 的账号实例。返回 [{ tool, config_dir, is_default, account_email, account_uuid,
 *  organization, subscription, has_credentials, expires_at }]，无凭证的目录也会列出（account 为 null）。 */
function scanClaudeInstances(home = os.homedir()) {
  const dirs = enumConfigDirs('.claude', process.env.CLAUDE_CONFIG_DIR, home);
  return dirs.map((dir) => {
    const isDef = isDefaultDir(dir, '.claude', home);
    const creds = readJson(path.join(dir, '.credentials.json'));
    const oauth = creds && creds.claudeAiOauth;
    // 账号信息：自定义 dir 在 $dir/.claude.json；默认 dir 回落到 ~/.claude.json（历史布局）
    const cfg = readJson(path.join(dir, '.claude.json'))
      || (isDef ? readJson(path.join(home, '.claude.json')) : null);
    const acct = cfg && cfg.oauthAccount;
    // 账号类型分类（决定纳管用 shim 还是 config-copy）：读纳管前的 settings.json，
    // 原始里有「非网关」的 ANTHROPIC_BASE_URL → 配置文件型(兼容端点)；否则有 OAuth 凭证 → oauth；都没有 → unknown。
    const { orig, managed } = readOriginalSettings(dir);
    const origBase = (orig && orig.env && orig.env.ANTHROPIC_BASE_URL) || null;
    const isCompat = !!(origBase && !isGatewayBaseUrl(origBase));
    const authMode = isCompat ? 'config-file'
      : ((oauth && oauth.accessToken) || acct?.emailAddress) ? 'oauth'
      : 'unknown';
    return {
      tool: 'claude-code',
      config_dir: dir,
      is_default: isDef,
      account_email: acct?.emailAddress || null,
      account_uuid: acct?.accountUuid || null,
      organization: acct?.organizationName || null,
      subscription: acct?.organizationType || oauth?.subscriptionType || null,
      has_credentials: !!(oauth && oauth.accessToken),
      expires_at: oauth?.expiresAt || null,
      // 账号类型 + 兼容端点信息（供 UI 展示 & 纳管机制选择）
      auth_mode: authMode,                                    // 'oauth' | 'config-file' | 'unknown'
      base_url: isCompat ? origBase : null,                   // 兼容端点原始 base_url（非网关）
      model: isCompat ? ((orig && orig.model) || null) : null,
      managed,                                                // 当前 settings.json 是否已被 TokenBank 改写
    };
  });
}

/** 扫描 Codex 的账号实例。CODEX_HOME/~/.codex/~/.codex-*，凭证在 auth.json。 */
function scanCodexInstances(home = os.homedir()) {
  const dirs = enumConfigDirs('.codex', process.env.CODEX_HOME, home);
  return dirs.map((dir) => {
    const isDef = isDefaultDir(dir, '.codex', home);
    const auth = readJson(path.join(dir, 'auth.json'));
    const tokens = auth && auth.tokens;
    return {
      tool: 'codex',
      config_dir: dir,
      is_default: isDef,
      account_email: tokens?.id_token ? decodeJwtEmail(tokens.id_token) : (auth?.email || null),
      account_uuid: tokens?.account_id || null,
      organization: null,
      subscription: null,
      has_credentials: !!(tokens && (tokens.access_token || tokens.id_token)),
      expires_at: auth?.last_refresh || null,
    };
  });
}

// 从 JWT 的 payload 里抽 email（不校验签名，只读展示用）。
function decodeJwtEmail(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString('utf8'));
    return payload.email || payload['https://api.openai.com/profile']?.email || null;
  } catch { return null; }
}

function scanCliInstances(tool, home = os.homedir()) {
  if (tool === 'claude-code') return scanClaudeInstances(home);
  if (tool === 'codex') return scanCodexInstances(home);
  return [];
}

// 工具 → 其 CONFIG_DIR 基名（多账号会话补录/额度用）
const TOOL_CONFIG_BASE = { 'claude-code': '.claude', codex: '.codex' };

// 多账号会话补录的 data_source：默认账号沿用 base（如 'session-claude'，向后兼容 + 保留 data_source_map）；
// 非默认账号追加 ':<目录名>'（如 'session-claude:claude-work'），使每个实例只匹配自己账号的会话、不重复计数。
// session-import 打标 与 main.appSessionDataSource 归属必须用同一函数，保证两边一致。
function cliSessionDataSource(base, configDir, cfgBase, home = os.homedir()) {
  if (!base || !configDir || !cfgBase) return base;
  if (path.resolve(configDir) === path.resolve(path.join(home, cfgBase))) return base;   // 默认账号
  return `${base}:${path.basename(configDir).replace(/^\.+/, '')}`;
}

// 把一个扫描实例的账号信息合并进 app 记录的 instance 段（保留用户配的 dir_glob）。
function mergeInstanceMeta(rec, inst) {
  rec.instance = {
    ...(rec.instance || {}),
    config_dir: inst.config_dir,
    is_default: inst.is_default,
    account_email: inst.account_email,
    subscription: inst.subscription,
    has_credentials: inst.has_credentials,
    invalid: false,
    dir_glob: rec.instance?.dir_glob ?? null,   // 用户配的生效目录，不覆盖
  };
}

/**
 * 扫描结果与已存 app 记录对账（幂等，按 config_dir 为 key）。纯函数：
 *  - 已存在(config_dir 匹配) → 保留 route_id/name/dir_glob，只刷新账号信息；
 *  - 首次迁移：默认实例(~/.claude) ↔ 旧的无 instance 段的 shim 记录，附加 instance；
 *  - 新发现 → 用 makeRecord(inst) 造记录追加；
 *  - config_dir 已消失 → instance.invalid=true（不删，避免误删用户配置）。
 * makeRecord 由调用方提供（负责生成 id/api_key 等副作用），便于测试注入。
 * 返回 { apps, added }。
 */
function reconcileCliInstances(apps, scanned, makeRecord) {
  const out = apps.map((a) => ({ ...a }));
  const added = [];
  const byTool = {};
  for (const inst of scanned) (byTool[inst.tool] = byTool[inst.tool] || []).push(inst);

  for (const [tool, insts] of Object.entries(byTool)) {
    const existing = out.filter((a) => a.agent_id === tool && a.link_method === 'shim');
    const seenDirs = new Set();
    for (const inst of insts) {
      seenDirs.add(path.resolve(inst.config_dir));
      let rec = existing.find((a) => a.instance && path.resolve(a.instance.config_dir || '') === path.resolve(inst.config_dir));
      if (!rec && inst.is_default) rec = existing.find((a) => !a.instance || !a.instance.config_dir);  // 旧记录迁移
      if (rec) {
        mergeInstanceMeta(rec, inst);
      } else {
        const nr = makeRecord(inst);
        if (nr) { added.push(nr); out.push(nr); existing.push(nr); }
      }
    }
    for (const a of existing) {
      const dir = a.instance && a.instance.config_dir;
      if (dir && !seenDirs.has(path.resolve(dir))) a.instance = { ...a.instance, invalid: true };
    }
  }
  return { apps: out, added };
}

/**
 * 账户下拉三层并集（供「手工新建 CLI 实例」的账户选择）：
 *  1. scanned —— 本机扫到的 CONFIG_DIR 登录（事实来源，即使没登记为源也在）；
 *  2. personal —— 已登记的个人源账户（可能没本机登录）；
 *  按 email 去重（scanned 优先，保留其 config_dir），标 source 与 has_local。
 * personal: [{ email, subscription?, source_id? }]，existingDirs: 已建实例记录的 config_dir 集合。
 */
function mergeAccountOptions(scanned = [], personal = [], existingDirs = new Set()) {
  const byEmail = new Map();
  for (const s of scanned) {
    const key = (s.account_email || s.config_dir || '').toLowerCase();
    byEmail.set(key, {
      email: s.account_email || null,
      config_dir: s.config_dir,
      subscription: s.subscription || null,
      is_default: !!s.is_default,
      has_local: true,
      already_added: existingDirs.has(path.resolve(s.config_dir)),
      source: 'scanned',
    });
  }
  for (const p of personal) {
    const email = p.email || p.account_email;
    if (!email) continue;
    const key = String(email).toLowerCase();
    if (byEmail.has(key)) { byEmail.get(key).source = 'both'; continue; }   // 已有本机登录 → 合并标记
    byEmail.set(key, {
      email, config_dir: null, subscription: p.subscription || null,
      is_default: false, has_local: false, already_added: false, source: 'personal',
    });
  }
  return [...byEmail.values()];
}

module.exports = {
  scanClaudeInstances, scanCodexInstances, scanCliInstances,
  enumConfigDirs, reconcileCliInstances, mergeAccountOptions,
  cliSessionDataSource, TOOL_CONFIG_BASE,
};

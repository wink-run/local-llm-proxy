'use strict';
/**
 * 多账号 CLI 的订阅额度抓取（Claude / Codex）。
 *
 * 与 usage/index.js 的区别：index 按 cfg.providers（=已登记的源）逐个抓；这里按【本机扫到的
 * CLI 实例 config_dir】逐个抓 —— 不进 providers、不加源，纯读各账号自己的登录态拿订阅剩余。
 *
 * 安全约束（关键）：只在 access_token 仍有效时抓；过期则标 'expired' 跳过，绝不主动刷新——
 * Claude 的 refresh_token 是轮换式的，若我们刷新却没回写该账号的 .credentials.json，会把 CLI
 * 自己的登录态搞失效（与 anthropic-paid 那次同一个坑）。刷新保活交给 CLI 自己。
 */
const fs = require('fs');
const path = require('path');
const { fetchClaudeUsage } = require('./claude');
const { fetchCodexUsage } = require('./codex');
const oauth = require('../oauth');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// 刷新过期 token 并【回写该账号的凭证文件】——承接 refresh_token 轮换、保活 CLI 自身登录。
// 谁刷新谁必须回写，否则轮换后该文件里的旧 refresh_token 失效、CLI 下次刷新就挂（anthropic-paid 那个坑）。
async function refreshAndPersist(tool, dir, creds) {
  const name = tool === 'codex' ? 'codex' : 'claude';
  const fresh = await oauth.refresh(name, creds);   // { access_token, refresh_token, expires_at(秒), ... }
  try {
    if (name === 'claude') {
      const file = path.join(dir, '.credentials.json');
      const j = readJson(file) || {};
      j.claudeAiOauth = {
        ...(j.claudeAiOauth || {}),
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token || creds.refresh_token,
        expiresAt: fresh.expires_at ? fresh.expires_at * 1000 : (j.claudeAiOauth && j.claudeAiOauth.expiresAt),  // 秒→毫秒
      };
      fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
    } else {
      const file = path.join(dir, 'auth.json');
      const j = readJson(file) || {};
      j.tokens = {
        ...(j.tokens || {}),
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token || creds.refresh_token,
        ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
      };
      fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
    }
  } catch (e) { /* 回写失败不致命：本次仍用 fresh 抓取，只是没保活文件 */ }
  return fresh;
}

// JWT payload.exp（秒）——codex 的过期时间藏在 id_token 里。
function jwtExp(jwt) {
  try {
    const p = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : null;
  } catch { return null; }
}

/** 读某 config_dir 的 OAuth 凭证，统一成 { access_token, refresh_token, expires_at(秒), ... }。 */
function readAccountCreds(tool, dir) {
  if (tool === 'claude-code' || tool === 'claude') {
    const j = readJson(path.join(dir, '.credentials.json'));
    const o = (j && j.claudeAiOauth) || {};
    if (!o.accessToken) return null;
    return {
      access_token: o.accessToken,
      refresh_token: o.refreshToken || null,
      expires_at: o.expiresAt ? Math.floor(o.expiresAt / 1000) : null,   // 文件里是毫秒 → 转秒（oauth.needsRefresh 用秒）
      subscriptionType: o.subscriptionType || null,
      rateLimitTier: o.rateLimitTier || null,
    };
  }
  if (tool === 'codex') {
    const j = readJson(path.join(dir, 'auth.json'));
    const t = (j && j.tokens) || {};
    if (!t.access_token) return null;
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token || null,
      expires_at: jwtExp(t.id_token),   // 秒
      account_id: t.account_id || null,
      id_token: t.id_token || null,
    };
  }
  return null;
}

// token 是否仍有效（留 60s 余量）。expires_at 未知时当作有效（CLI 自己保活）。
function tokenValid(creds) {
  if (!creds || !creds.access_token) return false;
  if (!creds.expires_at) return true;
  return creds.expires_at - Date.now() / 1000 > 60;
}

/** 抓单个账号（config_dir）的订阅额度。失败/过期不抛，返回带 error 的对象供逐条展示。 */
async function fetchCliAccountUsage(tool, dir, deps = {}) {
  const base = { tool, config_dir: dir };
  let creds = readAccountCreds(tool, dir);
  if (!creds) return { ...base, error: 'no-credentials' };
  // 过期：有 refresh_token 就刷新+回写（保活 CLI）；无则/刷新失败标 need-relogin。
  if (!tokenValid(creds)) {
    if (!creds.refresh_token) return { ...base, error: 'need-relogin' };
    try { creds = await refreshAndPersist(tool, dir, creds); }
    catch (e) { return { ...base, error: 'need-relogin', detail: (e && e.message) || String(e) }; }
  }
  const oauth_provider = tool === 'codex' ? 'codex' : 'claude';
  // 合成 provider：id 不在 cfg.providers 里 → oauth.prepare 的回写不会命中 → 不污染 providers。
  const synth = { id: `cli:${tool}:${dir}`, oauth_provider, auth_type: 'oauth', credentials: creds };
  const fetcher = tool === 'codex' ? fetchCodexUsage : fetchClaudeUsage;
  try {
    const r = await fetcher(synth, {
      getCfg: () => (typeof deps.getCfg === 'function' ? deps.getCfg() : null),
      saveCfg: () => {},   // token 有效→不刷新；即便刷新也不回写(id 不在 providers)
    });
    return { ...r, ...base };
  } catch (e) {
    return { ...base, error: (e && e.message) || String(e) };
  }
}

/** 抓一批账号（[{tool, config_dir, account_email}]）的额度。顺序执行，避免并发刷新同源 token。 */
async function fetchCliAccountsUsage(accounts, deps = {}) {
  const out = [];
  for (const a of accounts || []) {
    const r = await fetchCliAccountUsage(a.tool, a.config_dir, deps);
    out.push({ ...r, account_email: a.account_email || null, is_default: !!a.is_default, app_id: a.app_id || null });
  }
  return out;
}

module.exports = { fetchCliAccountUsage, fetchCliAccountsUsage, readAccountCreds, tokenValid };

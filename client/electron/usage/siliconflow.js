'use strict';
/**
 * SiliconFlow（硅基流动）额度抓取 —— 余额型。
 *
 * 优先级：
 * 1) 控制台钱包（与官网「余额」一致）：
 *    GET https://walletd.siliconflow.cn/api/v1/subject/profile/peek
 *    Cookie: __SF_auth.session-token + Header: X-Subject-Id
 *    金额单位为 10^12（pico-CNY），需除以 1e12。
 * 2) API Key：GET {base}/user/info（官方文档字段；已知常与控制台不一致，作回退）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { providerApiKey, toNum } = require('./shared');

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1';
const WALLETD_PEEK = 'https://walletd.siliconflow.cn/api/v1/subject/profile/peek';
const ACCOUNT_SUBJECTS = 'https://account.siliconflow.cn/api/subjects';
/** 控制台 financialInfo 金额单位 → 元 */
const BALANCE_SCALE = 1e12;
const COOKIE_DIGEST_PREFIX = 32;
const SESSION_COOKIE = '__SF_auth.session-token';

function resolveUserInfoUrl(provider) {
  const base = String((provider && provider.base_url) || DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, '');
  return `${base}/user/info`;
}

/** financialInfo 原始整数字符串 → 元 */
function scaleBalance(raw) {
  const n = toNum(raw);
  if (n == null) return null;
  return n / BALANCE_SCALE;
}

/**
 * 控制台 wallet peek → 统一快照。
 * balance/available ≈ 官网「余额」；remainingCreditLine ≈「剩余可透支额度」。
 */
function mapWalletFinancialInfo(financialInfo, provider, extra = {}) {
  const f = financialInfo || {};
  const remaining = scaleBalance(f.available != null ? f.available : f.balance);
  const cash = scaleBalance(f.recharged);
  const used = scaleBalance(f.used);
  const creditLimit = scaleBalance(f.remainingCreditLine != null ? f.remainingCreditLine : f.lineOfCredit);
  if (remaining == null && cash == null) return null;
  return {
    provider: 'siliconflow',
    id: (provider && provider.id) || 'siliconflow',
    available: true,
    credits: {
      total: remaining,
      remaining,
      toppedUp: cash,
      used,
      creditLimit,
      currency: 'CNY',
      usedPercent: null,
    },
    primary: null,
    windows: [],
    source: 'walletd-peek',
    fetchedAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * user/info 响应 → 统一快照（纯函数，可单测）。
 * totalBalance = 总余额；chargeBalance = 充值余额；balance = 赠送余额字段。
 */
function mapSiliconFlowUsage(data, provider) {
  const root = data || {};
  const d = root.data && typeof root.data === 'object' ? root.data : root;
  const total = toNum(d.totalBalance != null ? d.totalBalance : d.total_balance);
  const charge = toNum(d.chargeBalance != null ? d.chargeBalance : d.charge_balance);
  const granted = toNum(d.balance);
  const remaining = total != null ? total
    : granted != null ? granted
      : charge;

  return {
    provider: 'siliconflow',
    id: (provider && provider.id) || 'siliconflow',
    email: d.email || null,
    name: d.name || null,
    subjectId: d.id || null,
    available: root.status !== false && d.status !== 'disabled',
    credits: {
      total: remaining,
      remaining,
      granted,
      toppedUp: charge,
      currency: 'CNY',
      usedPercent: null,
    },
    primary: null,
    windows: [],
    source: 'user-info',
    fetchedAt: new Date().toISOString(),
  };
}

function readChromeSafeStoragePassword() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).replace(/\n$/, '');
  } catch {
    return null;
  }
}

function decryptCookieToText(encryptedValue, password) {
  if (!encryptedValue || !password) return null;
  const buf = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : Buffer.from(encryptedValue);
  if (buf.length < 19) return null;
  const prefix = buf.slice(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  let pt;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    pt = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (pt.length > COOKIE_DIGEST_PREFIX) {
    return pt.slice(COOKIE_DIGEST_PREFIX).toString('utf8');
  }
  return pt.toString('utf8');
}

/** Chrome / Chromium 用户数据目录候选（优先 Default）。 */
function chromeCookieDbCandidates(home = os.homedir()) {
  if (process.platform === 'darwin') {
    const root = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    return [
      path.join(root, 'Default', 'Cookies'),
      path.join(root, 'Profile 1', 'Cookies'),
      path.join(root, 'Profile 2', 'Cookies'),
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const root = path.join(local, 'Google', 'Chrome', 'User Data');
    return [
      path.join(root, 'Default', 'Cookies'),
      path.join(root, 'Profile 1', 'Cookies'),
    ];
  }
  const root = path.join(home, '.config', 'google-chrome');
  return [
    path.join(root, 'Default', 'Cookies'),
    path.join(root, 'Profile 1', 'Cookies'),
  ];
}

/** 从 Chrome Cookie 库读取硅基流动会话 token。 */
function readSiliconFlowSessionToken(deps = {}) {
  if (deps.sessionToken) return deps.sessionToken;
  const password = deps.password || readChromeSafeStoragePassword();
  if (!password) return null;
  const dbs = deps.cookiesPath
    ? [deps.cookiesPath]
    : chromeCookieDbCandidates(deps.home);
  for (const dbPath of dbs) {
    if (!fs.existsSync(dbPath)) continue;
    const tmp = path.join(os.tmpdir(), `tb-sf-cookies-${process.pid}-${Date.now()}.db`);
    try {
      fs.copyFileSync(dbPath, tmp);
      let hex = '';
      try {
        const Database = require('better-sqlite3');
        const db = new Database(tmp, { readonly: true, fileMustExist: true });
        const row = db.prepare(
          `SELECT encrypted_value FROM cookies
           WHERE name=? AND host_key LIKE '%siliconflow%'
           ORDER BY length(encrypted_value) DESC LIMIT 1`,
        ).get(SESSION_COOKIE);
        db.close();
        if (row && row.encrypted_value) {
          hex = Buffer.from(row.encrypted_value).toString('hex');
        }
      } catch {
        hex = execFileSync('sqlite3', [
          tmp,
          `SELECT hex(encrypted_value) FROM cookies WHERE name='${SESSION_COOKIE}' AND host_key LIKE '%siliconflow%' ORDER BY length(encrypted_value) DESC LIMIT 1;`,
        ], { encoding: 'utf8', timeout: 5000 }).trim();
      }
      const token = hex ? decryptCookieToText(Buffer.from(hex, 'hex'), password) : null;
      if (token && token.length > 20) return token;
    } catch {
      /* 下一份 Cookie DB */
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  return null;
}

async function resolveSubjectId({ sessionToken, apiKey, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  // 会话 → account subjects
  if (sessionToken) {
    try {
      const resp = await doFetch(ACCOUNT_SUBJECTS, {
        headers: {
          Cookie: `${SESSION_COOKIE}=${sessionToken}`,
          Accept: 'application/json',
        },
      });
      if (resp.ok) {
        const json = await resp.json();
        const list = (json && json.data) || [];
        if (Array.isArray(list) && list[0] && list[0].subjectId) {
          return String(list[0].subjectId);
        }
      }
    } catch { /* fall through */ }
  }
  // API Key → user/info.id（与 subjectId 同值）
  if (apiKey) {
    try {
      const resp = await doFetch(`${DEFAULT_BASE}/user/info`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      if (resp.ok) {
        const json = await resp.json();
        const id = json && json.data && json.data.id;
        if (id) return String(id);
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function fetchViaConsoleWallet(provider, deps = {}) {
  const sessionToken = readSiliconFlowSessionToken(deps);
  if (!sessionToken) return null;
  const doFetch = deps.fetchImpl || fetch;
  const apiKey = providerApiKey(provider);
  const subjectId = deps.subjectId || await resolveSubjectId({
    sessionToken, apiKey, fetchImpl: doFetch,
  });
  if (!subjectId) return null;

  const resp = await doFetch(WALLETD_PEEK, {
    headers: {
      Cookie: `${SESSION_COOKIE}=${sessionToken}`,
      'X-Subject-Id': subjectId,
      Accept: 'application/json',
      Origin: 'https://cloud.siliconflow.cn',
      Referer: 'https://cloud.siliconflow.cn/',
    },
  });
  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) {
    const err = new Error(`walletd HTTP ${resp.status}`);
    err.code = 'soft';
    throw err;
  }
  const json = await resp.json();
  if (json && json.code != null && Number(json.code) !== 20000) {
    return null;
  }
  const financial = json && json.data && json.data.financialInfo;
  return mapWalletFinancialInfo(financial, provider, { subjectId });
}

async function fetchViaUserInfo(provider, deps = {}) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少 SiliconFlow API key');
  const doFetch = deps.fetchImpl || fetch;
  const url = resolveUserInfoUrl(provider);
  const resp = await doFetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (resp.status === 401) throw new Error('401：API key 无效');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (json && json.code != null && Number(json.code) !== 20000 && json.status !== true) {
    throw new Error((json && json.message) || `SiliconFlow 错误码 ${json.code}`);
  }
  return mapSiliconFlowUsage(json, provider);
}

async function fetchSiliconFlowUsage(provider, deps = {}) {
  // 1) 控制台钱包（与官网余额对齐）
  try {
    const wallet = await fetchViaConsoleWallet(provider, deps);
    if (wallet && wallet.credits && wallet.credits.remaining != null) {
      return wallet;
    }
  } catch (e) {
    if (e && e.code === 'auth') throw e;
    // 软失败 → user/info
  }

  // 2) API Key user/info 回退
  const snap = await fetchViaUserInfo(provider, deps);
  const rem = snap.credits && snap.credits.remaining;
  // user/info 常返回 0 且与控制台不符：提示用浏览器登录
  if (rem == null || rem === 0) {
    snap.warning = 'API Key 余额为 0 或与控制台不符；请用 Chrome 登录 cloud.siliconflow.cn 后刷新以读取官网余额';
  }
  return snap;
}

module.exports = {
  fetchSiliconFlowUsage,
  mapSiliconFlowUsage,
  mapWalletFinancialInfo,
  resolveUserInfoUrl,
  scaleBalance,
  BALANCE_SCALE,
  readSiliconFlowSessionToken,
};

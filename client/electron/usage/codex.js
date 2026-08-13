'use strict';
/**
 * Codex（OpenAI ChatGPT 订阅）额度抓取。
 *
 * 优先级（对齐 token-monitor）：
 *   1) 本机 `codex app-server` JSON-RPC（account/rateLimits/read）—— 不依赖直连 chatgpt.com
 *   2) GET https://chatgpt.com/backend-api/wham/usage（OAuth / ~/.codex/auth.json）
 *
 * 窗口：primary/secondary → 会话 5h / 周 / 月（按 windowDurationMins / limit_window_seconds）
 */
const oauth = require('../oauth');
const { num, readCliCreds } = require('./shared');
const { codexPlanLabelFromParts } = require('./plan-labels');
const { readCodexRpc } = require('./codex-rpc');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function unixToISO(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return null;
  // RPC resetsAt 有时是秒、有时已是毫秒
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

/** 窗口时长（分钟）→ { id, title } */
function windowLabelFromMinutes(min) {
  if (min == null) return { id: 'window', title: '额度' };
  if (min <= 6 * 60) return { id: 'five_hour', title: '会话 · 5h' };
  if (min <= 24 * 60) return { id: 'one_day', title: '今日 · 24h' };
  if (min <= 7 * 24 * 60 + 60) return { id: 'seven_day', title: '本周 · 7d' };
  if (min <= 31 * 24 * 60) return { id: 'monthly', title: '本月额度' };
  return { id: 'window', title: '额度' };
}

function windowLabel(sec) {
  if (sec == null) return { id: 'window', title: '额度' };
  return windowLabelFromMinutes(Math.round(sec / 60));
}

/** wham 风格 window → 统一窗口 */
function mapWhamWindow(raw, overrides = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = num(raw.used_percent ?? raw.usedPercent);
  if (usedPercent == null && raw.reset_at == null && raw.resetsAt == null && raw.reset_after_seconds == null) {
    return null;
  }
  const sec = num(raw.limit_window_seconds);
  const mins = num(raw.windowDurationMins ?? raw.window_duration_mins)
    ?? (sec != null ? Math.round(sec / 60) : null);
  const label = mins != null ? windowLabelFromMinutes(mins) : windowLabel(sec);
  let resetsAt = unixToISO(raw.reset_at ?? raw.resetsAt);
  if (!resetsAt && num(raw.reset_after_seconds) != null) {
    resetsAt = new Date(Date.now() + num(raw.reset_after_seconds) * 1000).toISOString();
  }
  return {
    id: overrides.id || label.id,
    title: overrides.title || label.title,
    usedPercent: usedPercent == null ? 0 : usedPercent,
    usageKnown: usedPercent != null,
    resetsAt,
    windowMinutes: mins,
  };
}

function mapAdditionalWindows(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const rl = entry.rate_limit || {};
    const name = (entry.limit_name || entry.metered_feature || '').trim();
    for (const [w, suffix] of [[rl.primary_window, ''], [rl.secondary_window, ' · 周']]) {
      const mapped = mapWhamWindow(w, name ? { id: `extra:${name}${suffix}`, title: name + suffix } : {});
      if (mapped && !seen.has(mapped.id)) { seen.add(mapped.id); out.push(mapped); }
    }
  }
  return out;
}

function pickCredits(c) {
  if (!c || typeof c !== 'object') return null;
  if (!(c.has_credits || c.hasCredits || c.balance != null)) return null;
  const bal = typeof c.balance === 'string' ? parseFloat(c.balance) : c.balance;
  return {
    total: num(bal),
    currency: 'USD',
    usedPercent: null,
    unlimited: !!(c.unlimited),
  };
}

/** wham /usage JSON → 统一快照 */
function mapCodexUsage(data, provider) {
  const d = data || {};
  const rl = d.rate_limit || {};
  const windows = [];
  for (const w of [mapWhamWindow(rl.primary_window), mapWhamWindow(rl.secondary_window)]) if (w) windows.push(w);
  for (const w of mapAdditionalWindows(d.additional_rate_limits)) windows.push(w);
  const session = windows.find((w) => w.id === 'five_hour');
  const weekly = windows.find((w) => w.id === 'seven_day');
  const primary = session && session.usageKnown ? session : weekly || session || windows[0] || null;

  const rawPlan = d.plan_type
    || (d.account && (d.account.plan_type || d.account.planType))
    || null;
  const plan = codexPlanLabelFromParts(rawPlan) || rawPlan || null;

  return {
    provider: 'codex',
    id: (provider && provider.id) || 'codex',
    email: (d.email || (d.account && d.account.email) || null),
    plan,
    primary,
    windows,
    credits: pickCredits(d.credits),
    source: 'http',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * app-server RPC payload → 统一快照。
 * rateLimits.primary 使用 usedPercent / windowDurationMins / resetsAt。
 */
function mapCodexRpcUsage(payload, provider) {
  const p = payload || {};
  const byId = p.rateLimitsByLimitId || {};
  const rl = p.rateLimits || byId.codex || {};
  // 有的版本把额度再包一层 rateLimits
  const snap = rl.primary || rl.secondary || rl.planType
    ? rl
    : (rl.rateLimits || rl);
  const windows = [];
  for (const [key, titleHint] of [['primary', null], ['secondary', null]]) {
    const w = mapWhamWindow(snap[key], titleHint ? { title: titleHint } : {});
    if (w) windows.push(w);
  }
  const session = windows.find((w) => w.id === 'five_hour');
  const weekly = windows.find((w) => w.id === 'seven_day');
  const primary = session && session.usageKnown ? session : weekly || session || windows[0] || null;

  const account = p.account || {};
  const rawPlan = snap.planType || snap.plan_type || account.planType || account.plan_type || null;
  const plan = codexPlanLabelFromParts(rawPlan) || rawPlan || null;

  return {
    provider: 'codex',
    id: (provider && provider.id) || 'codex',
    email: account.email || null,
    plan,
    primary,
    windows,
    credits: pickCredits(snap.credits || snap.Credits),
    source: 'rpc',
    sourceDetail: p.sourceDetail || null,
    fetchedAt: new Date().toISOString(),
  };
}

function describeFetchError(e) {
  const msg = (e && e.message) || String(e);
  const cause = e && e.cause;
  const code = cause && cause.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(msg)) {
    return '无法连接 chatgpt.com（超时）。已尝试本地 Codex RPC，请确认已安装 ChatGPT/Codex 应用';
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || /fetch failed/i.test(msg)) {
    return '网络不可用，无法拉取 Codex 额度。请检查网络或使用本机 ChatGPT.app';
  }
  return msg;
}

async function fetchCodexUsageHttp(provider, { getCfg, saveCfg } = {}) {
  let prepared = provider;
  let creds = null;
  try {
    prepared = await oauth.prepare(provider, getCfg, saveCfg);
    creds = prepared.credentials || null;
  } catch {
    creds = provider.credentials || null;
  }
  if (!creds || !creds.access_token) creds = readCliCreds('codex') || creds;
  const token = creds && creds.access_token;
  if (!token) throw new Error('缺少登录凭证，请先完成非官方订阅登录（ChatGPT/Codex）');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const accId = creds.account_id;
  if (accId) headers['ChatGPT-Account-Id'] = accId;
  const resp = await fetch(USAGE_URL, { headers });
  if (resp.status === 401) throw new Error('401 未授权，请重新进行非官方订阅登录');
  if (resp.status === 403) throw new Error('403：订阅已失效或无权访问，请确认 ChatGPT/Codex 会员有效');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapCodexUsage(await resp.json(), prepared);
}

async function fetchCodexUsage(provider, deps = {}) {
  let rpcError = null;
  try {
    const payload = await readCodexRpc(deps);
    const snap = mapCodexRpcUsage(payload, provider);
    // 有窗口或至少有套餐名就采用 RPC 结果
    if ((snap.windows && snap.windows.length > 0) || snap.plan) return snap;
  } catch (e) {
    rpcError = e;
  }

  try {
    return await fetchCodexUsageHttp(provider, deps);
  } catch (httpErr) {
    // 网络失败时：若 RPC 曾成功拿到空窗，仍尽量回落；否则抛可读中文错误
    if (rpcError && /未找到 Codex|not found|ENOENT/i.test(String(rpcError.message))) {
      throw new Error(`未找到本机 Codex/ChatGPT 应用，且 ${describeFetchError(httpErr)}`);
    }
    throw new Error(describeFetchError(httpErr));
  }
}

module.exports = {
  fetchCodexUsage,
  mapCodexUsage,
  mapCodexRpcUsage,
  mapWindow: mapWhamWindow,
  fetchCodexUsageHttp,
};

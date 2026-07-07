'use strict';
/**
 * Codex（OpenAI ChatGPT 订阅）额度抓取（窗口型，移植自 CodexBar wham/usage）。
 * 端点：GET https://chatgpt.com/backend-api/wham/usage
 * 头：Authorization: Bearer <access_token> + ChatGPT-Account-Id（若有）
 * 响应：rate_limit.{primary_window,secondary_window}{ used_percent, reset_at(unix秒), limit_window_seconds }
 * 凭证：复用 oauth.prepare（local 已支持 codex 设备码 OAuth）。
 */
const oauth = require('../oauth');
const { num, readCliCreds } = require('./shared');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function unixToISO(ts) {
  return typeof ts === 'number' && isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
}

/** limit_window_seconds → { id, title }（5h / 24h / 7d / 30d / 其它）。 */
function windowLabel(sec) {
  if (sec == null) return { id: 'window', title: '额度' };
  const min = Math.round(sec / 60);
  if (min <= 6 * 60) return { id: 'five_hour', title: '会话 · 5h' };
  if (min <= 24 * 60) return { id: 'one_day', title: '今日 · 24h' };
  if (min <= 7 * 24 * 60 + 60) return { id: 'seven_day', title: '本周 · 7d' };
  if (min <= 31 * 24 * 60) return { id: 'monthly', title: '本月 · 30d' };
  return { id: 'window', title: '额度' };
}

/** rate_limit 的一个 window → 统一窗口；按 limit_window_seconds 归类窗口名。 */
function mapWindow(raw, overrides = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = num(raw.used_percent);
  if (usedPercent == null && raw.reset_at == null && raw.reset_after_seconds == null) return null;
  const sec = num(raw.limit_window_seconds);
  const windowMinutes = sec != null ? Math.round(sec / 60) : null;
  const label = windowLabel(sec);
  // reset_at（unix 秒）优先；缺失时用 reset_after_seconds 相对量推算。
  let resetsAt = unixToISO(raw.reset_at);
  if (!resetsAt && num(raw.reset_after_seconds) != null) {
    resetsAt = new Date(Date.now() + num(raw.reset_after_seconds) * 1000).toISOString();
  }
  return {
    id: overrides.id || label.id,
    title: overrides.title || label.title,
    usedPercent: usedPercent == null ? 0 : usedPercent,
    usageKnown: usedPercent != null,
    resetsAt,
    windowMinutes,
  };
}

/** additional_rate_limits（模型专属限额，如 Codex Spark）→ 额外窗口列表。 */
function mapAdditionalWindows(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const rl = entry.rate_limit || {};
    const name = (entry.limit_name || entry.metered_feature || '').trim();
    for (const [w, suffix] of [[rl.primary_window, ''], [rl.secondary_window, ' · 周']]) {
      const mapped = mapWindow(w, name ? { id: `extra:${name}${suffix}`, title: name + suffix } : {});
      if (mapped && !seen.has(mapped.id)) { seen.add(mapped.id); out.push(mapped); }
    }
  }
  return out;
}

/** usage 响应 → 统一快照（纯函数，可单测）。 */
function mapCodexUsage(data, provider) {
  const d = data || {};
  const rl = d.rate_limit || {};
  const windows = [];
  for (const w of [mapWindow(rl.primary_window), mapWindow(rl.secondary_window)]) if (w) windows.push(w);
  for (const w of mapAdditionalWindows(d.additional_rate_limits)) windows.push(w);
  const session = windows.find((w) => w.id === 'five_hour');
  const weekly = windows.find((w) => w.id === 'seven_day');
  const primary = session && session.usageKnown ? session : weekly || session || windows[0] || null;

  let credits = null;
  const c = d.credits;
  if (c && (c.has_credits || c.balance != null)) {
    const bal = typeof c.balance === 'string' ? parseFloat(c.balance) : c.balance;
    credits = { total: num(bal), currency: 'USD', usedPercent: null, unlimited: !!c.unlimited };
  }

  return {
    provider: 'codex',
    id: (provider && provider.id) || 'codex',
    plan: d.plan_type || null,
    primary,
    windows,
    credits,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchCodexUsage(provider, { getCfg, saveCfg } = {}) {
  // 优先走 agent config 里的 OAuth 凭证（oauth.prepare 会顺带刷新）；
  // 拿不到时回退读 Codex CLI 自维护的 ~/.codex/auth.json（CLI 自己保活）。
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
  if (!token) throw new Error('缺少 access_token，请重新登录 ChatGPT/Codex');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const accId = creds.account_id;
  if (accId) headers['ChatGPT-Account-Id'] = accId;
  const resp = await fetch(USAGE_URL, { headers });
  if (resp.status === 401) throw new Error('401 未授权，请重新登录');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapCodexUsage(await resp.json(), prepared);
}

module.exports = { fetchCodexUsage, mapCodexUsage, mapWindow };

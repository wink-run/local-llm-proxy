'use strict';
/**
 * Codex（OpenAI ChatGPT 订阅）额度抓取（窗口型，移植自 CodexBar wham/usage）。
 * 端点：GET https://chatgpt.com/backend-api/wham/usage
 * 头：Authorization: Bearer <access_token> + ChatGPT-Account-Id（若有）
 * 响应：rate_limit.{primary_window,secondary_window}{ used_percent, reset_at(unix秒), limit_window_seconds }
 * 凭证：复用 oauth.prepare（local 已支持 codex 设备码 OAuth）。
 */
const oauth = require('../oauth');
const { num } = require('./shared');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function unixToISO(ts) {
  return typeof ts === 'number' && isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
}

/** rate_limit 的一个 window → 统一窗口；按 limit_window_seconds 判断 5h / 7d。 */
function mapWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = num(raw.used_percent);
  if (usedPercent == null && raw.reset_at == null) return null;
  const sec = num(raw.limit_window_seconds);
  const windowMinutes = sec != null ? Math.round(sec / 60) : null;
  let id = windowMinutes === 300 ? 'five_hour' : windowMinutes === 10080 ? 'seven_day' : 'window';
  const title = id === 'five_hour' ? '会话 · 5h' : id === 'seven_day' ? '本周 · 7d' : '额度';
  return {
    id,
    title,
    usedPercent: usedPercent == null ? 0 : usedPercent,
    usageKnown: usedPercent != null,
    resetsAt: unixToISO(raw.reset_at),
    windowMinutes,
  };
}

/** usage 响应 → 统一快照（纯函数，可单测）。 */
function mapCodexUsage(data, provider) {
  const d = data || {};
  const rl = d.rate_limit || {};
  const windows = [];
  for (const w of [mapWindow(rl.primary_window), mapWindow(rl.secondary_window)]) if (w) windows.push(w);
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
  const prepared = await oauth.prepare(provider, getCfg, saveCfg);
  const token = prepared.credentials && prepared.credentials.access_token;
  if (!token) throw new Error('缺少 access_token，请重新登录 ChatGPT/Codex');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const accId = prepared.credentials.account_id;
  if (accId) headers['ChatGPT-Account-Id'] = accId;
  const resp = await fetch(USAGE_URL, { headers });
  if (resp.status === 401) throw new Error('401 未授权，请重新登录');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapCodexUsage(await resp.json(), prepared);
}

module.exports = { fetchCodexUsage, mapCodexUsage, mapWindow };

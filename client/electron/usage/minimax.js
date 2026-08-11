'use strict';
/**
 * MiniMax 额度抓取。
 *
 * 1) Coding / Token Plan：GET {host}/v1/api/openplatform/coding_plan/remains
 *    或 GET {host}/v1/token_plan/remains（model_remains 窗口）
 * 2) 现金余额：GET {host}/account/query_balance
 *    → available_amount / cash_balance / voucher_balance（CNY）
 */
const { providerApiKey, toNum } = require('./shared');

const CN_HOST = 'https://api.minimaxi.com';
const GLOBAL_HOST = 'https://api.minimax.io';

function resolveHost(provider) {
  const base = String((provider && provider.base_url) || CN_HOST).toLowerCase();
  if (base.includes('minimax.io')) return GLOBAL_HOST;
  // base 可能是 https://api.minimaxi.com/v1
  if (base.includes('minimaxi.com')) return CN_HOST;
  return CN_HOST;
}

function okBaseResp(json) {
  const br = json && json.base_resp;
  if (!br) return true;
  return Number(br.status_code) === 0;
}

/**
 * model_remains 条目 → 窗口。
 * 注意：部分字段 current_interval_*_percent 表示「剩余百分比」，需反转为已用。
 */
function mapModelRemain(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.model_name || item.modelName || 'general').toLowerCase();
  // 跳过视频等非对话额度
  if (/video|speech|music|image/.test(name) && !/general|chat|text|m2|m3/.test(name)) {
    return null;
  }

  let usedPercent = null;
  const remPct = toNum(
    item.current_interval_remaining_percent != null
      ? item.current_interval_remaining_percent
      : item.usage_percent != null ? item.usage_percent : item.usagePercent,
  );
  const usedPctField = toNum(item.current_interval_used_percent);
  if (usedPctField != null) usedPercent = usedPctField;
  else if (remPct != null) usedPercent = Math.min(100, Math.max(0, 100 - remPct));

  const total = toNum(item.current_interval_total_count);
  const remaining = toNum(item.current_interval_usage_count); // 历史字段名：usage_count 实为剩余
  if (usedPercent == null && total != null && total > 0 && remaining != null) {
    usedPercent = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
  }
  if (usedPercent == null) return null;

  const start = toNum(item.start_time);
  const end = toNum(item.end_time);
  let windowMinutes = null;
  let id = 'interval';
  let title = item.model_name || '配额';
  if (start != null && end != null && end > start) {
    windowMinutes = Math.round((end - start) / 60000);
    if (windowMinutes >= 280 && windowMinutes <= 320) {
      id = 'five_hour';
      title = '会话 · 5h';
    } else if (windowMinutes >= 9000) {
      id = 'seven_day';
      title = '本周';
    }
  }
  const wh = toNum(item.window_hours);
  if (wh === 5) { id = 'five_hour'; title = '会话 · 5h'; windowMinutes = 300; }
  if (wh === 168 || toNum(item.window_days) === 7) {
    id = 'seven_day'; title = '本周'; windowMinutes = 10080;
  }

  let resetsAt = null;
  if (end != null && end > 0) resetsAt = new Date(end).toISOString();
  else if (toNum(item.remains_time) != null) {
    resetsAt = new Date(Date.now() + Number(item.remains_time)).toISOString();
  }

  return {
    id: `${id}_${name}`.replace(/[^a-z0-9_]/gi, '_'),
    title: title === '会话 · 5h' || title === '本周' ? title : `${title}`,
    usedPercent,
    usageKnown: true,
    resetsAt,
    windowMinutes,
  };
}

function mapRemainsWindows(json) {
  const root = (json && json.data && Array.isArray(json.data.model_remains))
    ? json.data
    : json;
  const arr = (root && root.model_remains) || [];
  if (!Array.isArray(arr)) return [];
  const windows = [];
  for (const item of arr) {
    const w = mapModelRemain(item);
    if (w) windows.push(w);
  }
  // 去重：同 id 保留已用更高者
  const byId = new Map();
  for (const w of windows) {
    const prev = byId.get(w.id);
    if (!prev || w.usedPercent > prev.usedPercent) byId.set(w.id, w);
  }
  return [...byId.values()];
}

function mapBalanceCredits(json) {
  const d = json || {};
  const available = toNum(d.available_amount);
  const cash = toNum(d.cash_balance);
  const voucher = toNum(d.voucher_balance);
  const credit = toNum(d.credit_balance);
  if (available == null && cash == null) return null;
  const remaining = available != null ? available : cash;
  return {
    total: remaining,
    remaining,
    toppedUp: cash,
    granted: voucher,
    creditLimit: credit,
    currency: 'CNY',
    usedPercent: null,
  };
}

/** remains / balance 响应 → 统一快照。 */
function mapMiniMaxUsage({ remains, balance }, provider) {
  const windows = remains ? mapRemainsWindows(remains) : [];
  const credits = balance ? mapBalanceCredits(balance) : null;
  const primary = windows.find((w) => /five_hour/.test(w.id))
    || windows[0]
    || null;
  return {
    provider: 'minimax',
    id: (provider && provider.id) || 'minimax',
    available: true,
    plan: windows.length ? 'Coding / Token Plan' : null,
    primary,
    windows,
    credits,
    source: [
      remains && 'plan-remains',
      credits && 'query-balance',
    ].filter(Boolean).join('+') || null,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchJson(url, key) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: resp.status, json, text };
}

async function fetchMiniMaxUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少 MiniMax API key');
  const host = resolveHost(provider);
  const soft = [];

  let remains = null;
  for (const path of [
    '/v1/api/openplatform/coding_plan/remains',
    '/v1/token_plan/remains',
    '/v1/coding_plan/remains',
  ]) {
    try {
      const { status, json } = await fetchJson(`${host}${path}`, key);
      if (status === 401 || status === 403) throw Object.assign(new Error('401：API key 无效'), { code: 'auth' });
      if (json && okBaseResp(json) && ((json.model_remains && json.model_remains.length)
        || (json.data && json.data.model_remains && json.data.model_remains.length))) {
        remains = json;
        break;
      }
      if (json && json.base_resp && json.base_resp.status_msg) {
        soft.push(json.base_resp.status_msg);
      }
    } catch (e) {
      if (e && e.code === 'auth') throw e;
      soft.push((e && e.message) || String(e));
    }
  }

  let balance = null;
  try {
    // 余额接口在 www / api 主机均可；优先与 host 同域
    const balHosts = host.includes('minimax.io')
      ? [GLOBAL_HOST]
      : [CN_HOST, 'https://www.minimaxi.com'];
    for (const h of balHosts) {
      const { status, json } = await fetchJson(`${h}/account/query_balance`, key);
      if (status === 401 || status === 403) continue;
      if (json && okBaseResp(json) && (json.available_amount != null || json.cash_balance != null)) {
        balance = json;
        break;
      }
    }
  } catch (e) {
    soft.push((e && e.message) || String(e));
  }

  const snap = mapMiniMaxUsage({ remains, balance }, provider);
  if (!snap.windows.length && !snap.credits) {
    throw new Error(soft.filter(Boolean).join('；') || 'MiniMax 无可用额度数据');
  }
  // 已有现金余额时，不把「无 Token Plan」当主提示
  if (!snap.windows.length && soft[0] && !snap.credits) {
    snap.warning = soft[0];
  }
  return snap;
}

module.exports = {
  fetchMiniMaxUsage,
  mapMiniMaxUsage,
  mapModelRemain,
  mapBalanceCredits,
  resolveHost,
};

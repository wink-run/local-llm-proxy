'use strict';
/**
 * 智谱（Zhipu / BigModel）额度抓取。
 *
 * 1) Coding Plan：GET {origin}/api/monitor/usage/quota/limit
 *    limits[]：TOKENS_LIMIT（5h / 周）+ TIME_LIMIT（MCP 月）
 * 2) 按量余额：GET {origin}/api/biz/account/getAccountBalanceEnough
 *    data 为可用余额数值（CNY）
 *
 * Authorization 支持「裸 Key」或「Bearer Key」（两端点均实测可用）。
 */
const { providerApiKey, toNum } = require('./shared');

const CN_ORIGIN = 'https://open.bigmodel.cn';
const INTL_ORIGIN = 'https://api.z.ai';

function resolveOrigin(provider) {
  const base = String((provider && provider.base_url) || CN_ORIGIN).toLowerCase();
  if (base.includes('api.z.ai') || base.includes('z.ai')) return INTL_ORIGIN;
  // https://open.bigmodel.cn/api/paas/v4 → origin
  const m = String((provider && provider.base_url) || CN_ORIGIN)
    .match(/^(https?:\/\/[^/]+)/i);
  return (m && m[1]) || CN_ORIGIN;
}

function authHeaders(key) {
  // 裸 Key 与 Bearer 均可；统一带 Bearer，兼容监控与 biz
  const k = String(key || '').trim();
  const value = /^Bearer\s+/i.test(k) ? k : `Bearer ${k}`;
  return {
    Authorization: value,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function resetIsoFromMs(ms) {
  const n = toNum(ms);
  if (n == null || n <= 0) return null;
  return new Date(n).toISOString();
}

/**
 * Coding Plan limits → windows。
 * percentage 为已用百分比；unit/number 区分 5h(unit=3,number=5) / 周 / 月。
 */
function mapQuotaLimits(data) {
  const root = data || {};
  const limits = Array.isArray(root.limits) ? root.limits : [];
  const level = root.level ? String(root.level) : null;
  const tokenLimits = limits
    .filter((l) => l && String(l.type).toUpperCase() === 'TOKENS_LIMIT')
    .slice()
    .sort((a, b) => (toNum(a.nextResetTime) || 0) - (toNum(b.nextResetTime) || 0));

  const windows = [];
  tokenLimits.forEach((item, idx) => {
    const pct = toNum(item.percentage);
    if (pct == null) return;
    const unit = toNum(item.unit);
    const number = toNum(item.number);
    let id = `tokens_${idx}`;
    let title = 'Token 额度';
    let windowMinutes = null;
    // 文档约定：unit=3 number=5 → 5 小时；unit=6 number=1 → 周
    if (unit === 3 && number === 5) {
      id = 'five_hour';
      title = '会话 · 5h';
      windowMinutes = 300;
    } else if (unit === 6 || (unit === 5 && number === 7) || idx === 1) {
      id = 'seven_day';
      title = '本周';
      windowMinutes = 10080;
    } else if (idx === 0) {
      id = 'five_hour';
      title = '会话 · 5h';
      windowMinutes = 300;
    }
    windows.push({
      id,
      title,
      usedPercent: Math.min(100, Math.max(0, pct)),
      usageKnown: true,
      resetsAt: resetIsoFromMs(item.nextResetTime),
      windowMinutes,
    });
  });

  const mcp = limits.find((l) => l && String(l.type).toUpperCase() === 'TIME_LIMIT');
  if (mcp) {
    const usage = toNum(mcp.usage);
    const current = toNum(mcp.currentValue);
    const remaining = toNum(mcp.remaining);
    let usedPercent = toNum(mcp.percentage);
    if (usedPercent == null && usage != null && usage > 0 && current != null) {
      usedPercent = (current / usage) * 100;
    } else if (usedPercent == null && usage != null && usage > 0 && remaining != null) {
      usedPercent = ((usage - remaining) / usage) * 100;
    }
    if (usedPercent != null) {
      windows.push({
        id: 'mcp_monthly',
        title: 'MCP · 本月',
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        usageKnown: true,
        resetsAt: resetIsoFromMs(mcp.nextResetTime),
        windowMinutes: null,
      });
    }
  }

  return {
    windows,
    plan: level ? `Coding Plan · ${level}` : (windows.length ? 'Coding Plan' : null),
  };
}

function mapZhipuUsage({ quota, balance }, provider) {
  const mapped = quota ? mapQuotaLimits(quota) : { windows: [], plan: null };
  const windows = mapped.windows || [];
  const balNum = toNum(balance);
  const credits = balNum != null
    ? {
      total: balNum,
      remaining: balNum,
      currency: 'CNY',
      usedPercent: null,
    }
    : null;
  const primary = windows.find((w) => w.id === 'five_hour') || windows[0] || null;
  return {
    provider: 'zhipu',
    id: (provider && provider.id) || 'zhipu',
    available: true,
    plan: mapped.plan,
    primary,
    windows,
    credits,
    source: [
      windows.length && 'quota-limit',
      credits && 'account-balance',
    ].filter(Boolean).join('+') || null,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchZhipuUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少智谱 API key');
  const origin = resolveOrigin(provider);
  const headers = authHeaders(key);
  const soft = [];

  let quota = null;
  try {
    const resp = await fetch(`${origin}/api/monitor/usage/quota/limit`, { headers });
    const json = await resp.json().catch(() => null);
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error('401：API key 无效'), { code: 'auth' });
    }
    if (json && (json.success === true || Number(json.code) === 200)
      && json.data && Array.isArray(json.data.limits) && json.data.limits.length) {
      quota = json.data;
    } else if (json && json.msg) {
      soft.push(json.msg);
    }
  } catch (e) {
    if (e && e.code === 'auth') throw e;
    soft.push((e && e.message) || String(e));
  }

  let balance = null;
  try {
    // 国内 biz 余额；intl 同源尝试
    const urls = [
      `${origin}/api/biz/account/getAccountBalanceEnough`,
      'https://open.bigmodel.cn/api/biz/account/getAccountBalanceEnough',
      'https://bigmodel.cn/api/biz/account/getAccountBalanceEnough',
    ];
    for (const url of urls) {
      const resp = await fetch(url, { headers });
      const json = await resp.json().catch(() => null);
      if (json && (json.success === true || Number(json.code) === 200)
        && json.data != null && typeof json.data !== 'object') {
        balance = json.data;
        break;
      }
      // 少数版本 data 为对象
      if (json && json.data && typeof json.data === 'object') {
        const n = toNum(json.data.availableBalance != null
          ? json.data.availableBalance
          : json.data.balance);
        if (n != null) { balance = n; break; }
      }
    }
  } catch (e) {
    soft.push((e && e.message) || String(e));
  }

  const snap = mapZhipuUsage({ quota, balance }, provider);
  if (!snap.windows.length && !snap.credits) {
    throw new Error(soft.filter(Boolean).join('；') || '智谱无可用额度数据');
  }
  if (!snap.windows.length && soft[0] && /coding plan/i.test(soft[0])) {
    // 仅余额时不把「无 coding plan」当错误刷屏
    snap.warning = null;
  } else if (!snap.windows.length && soft[0]) {
    snap.warning = soft[0];
  }
  return snap;
}

module.exports = {
  fetchZhipuUsage,
  mapZhipuUsage,
  mapQuotaLimits,
  resolveOrigin,
};

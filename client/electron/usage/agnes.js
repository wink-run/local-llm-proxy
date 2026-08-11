'use strict';
/**
 * Agnes AI 额度抓取 —— OpenAI 兼容 billing 口径。
 *
 * 国际站：https://apihub.agnes-ai.com/v1
 * 中国站：https://api.agnes-ai.cn/v1
 * （密钥与站点绑定，不可跨站调用）
 *
 * 端点：
 *   GET {base}/dashboard/billing/subscription  → hard_limit_usd / soft_limit_usd
 *   GET {base}/dashboard/billing/usage?start_date&end_date → total_usage（美分）
 *
 * 约定（对齐 NewAPI / OpenAI 兼容网关）：
 *   - total_usage 单位为美分，÷100 → USD
 *   - hard_limit_usd ≥ 1e7（常见哨兵 100000000）视为无限额度
 */
const { providerApiKey, toNum } = require('./shared');

const INTL_BASE = 'https://apihub.agnes-ai.com/v1';
const CN_BASE = 'https://api.agnes-ai.cn/v1';
/** 兼容文档偶发写法；若用户填了此 host 也按中国站处理 */
const CN_ALT_BASE = 'https://apihub.agnes-ai.cn/v1';
const UNLIMITED_USD = 1e7;

function detectRegion(baseUrl) {
  const s = String(baseUrl || '').toLowerCase();
  if (/\.cn(\/|$|:)/.test(s) || s.includes('agnes-ai.cn')) return 'cn';
  if (s.includes('apihub.agnes-ai.com') || s.includes('agnes-ai.com')) return 'intl';
  return 'intl';
}

/** 按 provider.base_url 解析抓取根路径（含 /v1），绝不跨站。 */
function resolveAgnesBase(provider) {
  const raw = String((provider && provider.base_url) || '').trim().replace(/\/+$/, '');
  if (raw) {
    // 已含 /v1
    if (/\/v\d+$/i.test(raw)) return raw;
    return `${raw}/v1`;
  }
  return INTL_BASE;
}

function regionLabel(region) {
  return region === 'cn' ? '中国站' : '国际站';
}

/** Unix 秒；默认近 100 天（覆盖常见账单窗）。 */
function defaultUsageRange(nowSec = Math.floor(Date.now() / 1000)) {
  return {
    start_date: nowSec - 100 * 86400,
    end_date: nowSec + 86400,
  };
}

/**
 * subscription + usage → 统一快照（纯函数，可单测）。
 * @param {{ subscription?: object, usage?: object, region?: string }}
 */
function mapAgnesUsage({ subscription, usage, region }, provider) {
  const sub = subscription || {};
  const usedCents = toNum(usage && usage.total_usage);
  const usedUsd = usedCents != null ? usedCents / 100 : null;
  const hard = toNum(sub.hard_limit_usd != null ? sub.hard_limit_usd : sub.hard_limit);
  const soft = toNum(sub.soft_limit_usd != null ? sub.soft_limit_usd : sub.soft_limit);
  const limitUsd = hard != null ? hard : soft;
  const unlimited = limitUsd != null && limitUsd >= UNLIMITED_USD;

  let remaining = null;
  let usedPercent = null;
  let total = null;
  if (!unlimited && limitUsd != null) {
    total = limitUsd;
    remaining = usedUsd != null ? Math.max(0, limitUsd - usedUsd) : limitUsd;
    if (usedUsd != null && limitUsd > 0) {
      usedPercent = Math.min(100, Math.max(0, (usedUsd / limitUsd) * 100));
    }
  }

  const windows = [];
  let primary = null;
  if (usedPercent != null) {
    primary = {
      id: 'credits',
      title: '额度',
      usedPercent,
      usageKnown: true,
      resetsAt: null,
      windowMinutes: null,
    };
    windows.push(primary);
  }

  const reg = region || detectRegion(provider && provider.base_url);
  return {
    provider: 'agnes-ai',
    id: (provider && provider.id) || 'agnes-ai',
    available: true,
    region: reg,
    // 站点标签放在卡片 base_url 后面，不挤进额度徽章
    plan: unlimited ? 'Token · 无限' : null,
    credits: {
      total: unlimited ? null : total,
      remaining: unlimited ? null : remaining,
      used: usedUsd,
      unlimited: !!unlimited,
      currency: 'USD',
      usedPercent,
    },
    primary,
    windows,
    source: 'dashboard-billing',
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

async function fetchAgnesUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少 Agnes AI API key');
  const base = resolveAgnesBase(provider);
  const region = detectRegion(base);

  const range = defaultUsageRange();
  const usageQs = `start_date=${range.start_date}&end_date=${range.end_date}`;

  const [subRes, usageRes] = await Promise.all([
    fetchJson(`${base}/dashboard/billing/subscription`, key),
    fetchJson(`${base}/dashboard/billing/usage?${usageQs}`, key),
  ]);

  if (subRes.status === 401 || usageRes.status === 401) {
    throw new Error(`401：API key 无效（请确认是否为${regionLabel(region)}密钥）`);
  }
  if (subRes.status === 403 || usageRes.status === 403) {
    throw new Error(`403：无权限读取额度（${regionLabel(region)}）`);
  }
  if (!subRes.json && !usageRes.json) {
    throw new Error(`HTTP ${subRes.status || usageRes.status}`);
  }
  // usage 失败但 subscription 成功时仍可展示限额
  if (usageRes.status >= 400 && !(subRes.json && subRes.json.object)) {
    throw new Error((usageRes.json && usageRes.json.error && usageRes.json.error.message)
      || `usage HTTP ${usageRes.status}`);
  }

  return mapAgnesUsage({
    subscription: subRes.json,
    usage: usageRes.json,
    region,
  }, provider);
}

module.exports = {
  fetchAgnesUsage,
  mapAgnesUsage,
  resolveAgnesBase,
  detectRegion,
  INTL_BASE,
  CN_BASE,
  CN_ALT_BASE,
  UNLIMITED_USD,
};

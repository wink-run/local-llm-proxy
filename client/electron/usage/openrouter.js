'use strict';
/**
 * OpenRouter 额度抓取（余额型，移植自 CodexBar OpenRouterUsageStats）。
 * 端点：GET https://openrouter.ai/api/v1/credits  ·  Authorization: Bearer <api_key>
 * 响应：{ data: { total_credits, total_usage } }（USD）→ 余额 + 已用百分比。
 */
const { providerApiKey, toNum } = require('./shared');

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

/** credits 响应 → 统一快照（纯函数，可单测）。 */
function mapOpenRouterUsage(data, provider) {
  const d = (data && data.data) || {};
  const total = toNum(d.total_credits);
  const used = toNum(d.total_usage);
  const remaining = total != null && used != null ? Math.max(0, total - used) : null;
  const usedPercent = total != null && used != null && total > 0 ? Math.min(100, (used / total) * 100) : null;

  const windows = [];
  let primary = null;
  if (usedPercent != null) {
    primary = { id: 'credits', title: '额度', usedPercent, usageKnown: true, resetsAt: null, windowMinutes: null };
    windows.push(primary);
  }
  return {
    provider: 'openrouter',
    id: (provider && provider.id) || 'openrouter',
    credits: { total, used, remaining, usedPercent, currency: 'USD' },
    primary,
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchOpenRouterUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少 OpenRouter API key');
  const resp = await fetch(CREDITS_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (resp.status === 401) throw new Error('401：API key 无效');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapOpenRouterUsage(await resp.json(), provider);
}

module.exports = { fetchOpenRouterUsage, mapOpenRouterUsage };

'use strict';
/**
 * DeepSeek 额度抓取（纯余额型，移植自 CodexBar DeepSeekUsageFetcher）。
 * 端点：GET https://api.deepseek.com/user/balance  ·  Authorization: Bearer <api_key>
 * 响应：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 * 注意：金额是字符串，且无「用量百分比」概念（只有余额）。
 */
const { providerApiKey, toNum } = require('./shared');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/** balance 响应 → 统一快照（纯函数，可单测）。 */
function mapDeepSeekUsage(data, provider) {
  const d = data || {};
  const info = (Array.isArray(d.balance_infos) && d.balance_infos[0]) || {};
  return {
    provider: 'deepseek',
    id: (provider && provider.id) || 'deepseek',
    available: d.is_available !== false,
    credits: {
      total: toNum(info.total_balance),
      granted: toNum(info.granted_balance),
      toppedUp: toNum(info.topped_up_balance),
      currency: info.currency || 'CNY',
      usedPercent: null, // 纯余额，无百分比
    },
    primary: null,
    windows: [],
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchDeepSeekUsage(provider) {
  const key = providerApiKey(provider);
  if (!key) throw new Error('缺少 DeepSeek API key');
  const resp = await fetch(BALANCE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (resp.status === 401) throw new Error('401：API key 无效');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapDeepSeekUsage(await resp.json(), provider);
}

module.exports = { fetchDeepSeekUsage, mapDeepSeekUsage };

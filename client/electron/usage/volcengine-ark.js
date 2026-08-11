'use strict';
/**
 * 火山引擎方舟按量付费额度 —— 仅费用中心余额（QueryBalanceAcct）。
 *
 * base_url：https://ark.cn-beijing.volces.com/api/v3/
 * 与 Coding Plan / Agent Plan 订阅（volcengine / api-volcengine）分开；
 * 订阅额度见 usage/volcengine.js。
 */
const { resolveVolcAkSk } = require('./volcengine');
const { fetchVolcengineBalance } = require('./volcengine-billing');
const { regionFromBaseUrl } = require('./volcengine-openapi');

async function fetchVolcengineArkUsage(provider) {
  const aksk = resolveVolcAkSk(provider);
  if (!aksk) {
    return {
      provider: 'volcengine-ark',
      id: (provider && provider.id) || 'volcengine-ark',
      available: false,
      primary: null,
      windows: [],
      plan: null,
      credits: null,
      source: null,
      warning: '填写 AccessKey 以查询按量余额',
      fetchedAt: new Date().toISOString(),
    };
  }
  const region = regionFromBaseUrl(provider && provider.base_url);
  const bal = await fetchVolcengineBalance({
    accessKeyId: aksk.accessKeyId,
    secretAccessKey: aksk.secretAccessKey,
    region,
  });
  return {
    provider: 'volcengine-ark',
    id: (provider && provider.id) || 'volcengine-ark',
    available: true,
    primary: null,
    windows: [],
    plan: null,
    credits: bal.credits || null,
    source: bal.source || 'billing-balance',
    warning: null,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchVolcengineArkUsage };

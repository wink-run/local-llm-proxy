// 个人页计费配置与 Token Bank 服务端同步（跨终端）
'use strict';

const http = require('http');
const https = require('https');

const BILLING_FIELDS = [
  'user_subscriptions',
  'user_payg_providers',
  'provider_pricing_overrides',
  'subscription_plans',
];

/** 归一化服务器根地址（无配置时返回空，不写死默认 IP） */
function normalizeBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
}

function requestJson(method, serverUrl, path, token, body) {
  const base = normalizeBase(serverUrl);
  if (!base) return Promise.reject(new Error('未配置 Token Bank 服务地址'));
  const url = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
  const mod = url.protocol === 'https:' ? https : http;
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method,
      timeout: 15000,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { reject(new Error('invalid json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 从 local-config 提取可同步字段 */
function pickBilling(obj = {}) {
  return {
    user_subscriptions: Array.isArray(obj.user_subscriptions) ? obj.user_subscriptions : [],
    user_payg_providers: Array.isArray(obj.user_payg_providers) ? obj.user_payg_providers : [],
    provider_pricing_overrides: obj.provider_pricing_overrides && typeof obj.provider_pricing_overrides === 'object'
      ? obj.provider_pricing_overrides : {},
    subscription_plans: obj.subscription_plans && typeof obj.subscription_plans === 'object'
      ? obj.subscription_plans : {},
  };
}

function isEmptyBilling(b) {
  return !(b.user_subscriptions?.length)
    && !(b.user_payg_providers?.length)
    && !Object.keys(b.provider_pricing_overrides || {}).length
    && !Object.keys(b.subscription_plans || {}).length;
}

/** 写入 local-config（本地缓存，供网关离线估价） */
function applyToCfg(cfg, billing) {
  const b = pickBilling(billing);
  cfg.user_subscriptions = b.user_subscriptions;
  cfg.user_payg_providers = b.user_payg_providers;
  cfg.provider_pricing_overrides = b.provider_pricing_overrides;
  cfg.subscription_plans = b.subscription_plans;
  return cfg;
}

async function fetchUserBilling(token, serverUrl) {
  return pickBilling(await requestJson('GET', serverUrl, '/user/accounts', token));
}

async function saveUserBilling(token, serverUrl, patch) {
  const body = {};
  for (const k of BILLING_FIELDS) {
    if (patch[k] !== undefined) body[k] = patch[k];
  }
  return pickBilling(await requestJson('PUT', serverUrl, '/user/accounts', token, body));
}

/**
 * 从云端拉取；云端为空且本地有旧数据时自动上传一次（迁移）。
 * 失败时回退本地缓存。
 */
async function syncFromCloud(token, serverUrl, localCfg) {
  const local = pickBilling(localCfg);
  if (!token) return local;
  let remote;
  try {
    remote = await fetchUserBilling(token, serverUrl);
  } catch {
    return local;
  }
  if (isEmptyBilling(remote) && !isEmptyBilling(local)) {
    try {
      remote = await saveUserBilling(token, serverUrl, local);
    } catch {
      return local;
    }
  }
  return remote;
}

module.exports = {
  pickBilling,
  applyToCfg,
  syncFromCloud,
  saveUserBilling,
  fetchUserBilling,
  isEmptyBilling,
  normalizeBase,
};

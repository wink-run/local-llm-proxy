// 个人供给源账户：仅本机配置，不经云端拉取/合并（避免多设备错乱）。
// 各端通过设备心跳 inventory.accounts_summary 单向上报登记摘要；云端个人页按设备展示。
'use strict';

const http = require('http');
const https = require('https');

// 历史字段（已停用跨端账户同步；保留常量供旧调用方解构，不再读写云端）
const BILLING_FIELDS = [
  'user_subscriptions',
  'user_payg_providers',
  'provider_pricing_overrides',
  'subscription_plans',
];

const isCustom = (x) => !!(x && x.custom);
const nonCustom = (list) => (Array.isArray(list) ? list.filter(x => !isCustom(x)) : []);
const customOnly = (list) => (Array.isArray(list) ? list.filter(isCustom) : []);

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
  const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return {
    user_subscriptions: Array.isArray(obj.user_subscriptions) ? obj.user_subscriptions : [],
    user_payg_providers: Array.isArray(obj.user_payg_providers) ? obj.user_payg_providers : [],
    provider_pricing_overrides: objOf(obj.provider_pricing_overrides),
    subscription_plans: objOf(obj.subscription_plans),
  };
}

function isEmptyBilling(b) {
  return !(b.user_subscriptions?.length)
    && !(b.user_payg_providers?.length)
    && !Object.keys(b.provider_pricing_overrides || {}).length
    && !Object.keys(b.subscription_plans || {}).length;
}

/** 合并账户实例：本机已有项优先（同 id 保留本地），再追加云端独有项 */
function mergeInstanceLists(localList = [], remoteList = []) {
  const local = Array.isArray(localList) ? localList : [];
  const remote = Array.isArray(remoteList) ? remoteList : [];
  const out = [];
  const seen = new Set();
  for (const x of local) {
    if (!x?.id || seen.has(x.id)) continue;
    out.push(x);
    seen.add(x.id);
  }
  for (const x of remote) {
    if (!x?.id || seen.has(x.id)) continue;
    out.push(x);
    seen.add(x.id);
  }
  return out;
}

/** 不再用云端 billing 覆盖本机（个人供给源各设备独立） */
function applyToCfg(cfg, _billing) {
  return cfg;
}

async function fetchUserBilling(_token, _serverUrl) {
  return pickBilling({});
}

async function saveUserBilling(_token, _serverUrl, patch) {
  return pickBilling(patch);
}

/** 个人供给源配置仅读本机，不拉云端 */
async function syncFromCloud(_token, _serverUrl, localCfg) {
  return pickBilling(localCfg);
}

module.exports = {
  pickBilling,
  applyToCfg,
  mergeInstanceLists,
  syncFromCloud,
  saveUserBilling,
  fetchUserBilling,
  isEmptyBilling,
  normalizeBase,
};

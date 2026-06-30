// 个人页计费配置与 Token Bank 服务端同步（跨终端）
'use strict';

const http = require('http');
const https = require('https');

// 跨终端同步字段。注意：以下三类是「纯本地」数据，不进此列表、不上云：
//   · direct_source_billing   直连应用计费（本机安装的应用，计费是本机估算）
//   · source_template_overrides 本地模板覆盖
//   · user_*[].custom===true   自定义源实例（不在官方目录里，机器本地的）
// custom 实例混在 user_subscriptions / user_payg_providers 里，上传时拆出、下载时与云端官方实例合并。
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

/** 写入 local-config（本地缓存，供网关离线估价） */
function applyToCfg(cfg, billing) {
  const b = pickBilling(billing);
  const localPick = pickBilling(cfg);
  // 刊例价/套餐：云端为基线，本机覆盖项保留
  cfg.provider_pricing_overrides = { ...b.provider_pricing_overrides, ...localPick.provider_pricing_overrides };
  cfg.subscription_plans = { ...b.subscription_plans, ...localPick.subscription_plans };
  // 自定义实例(custom:true)纯本地；官方实例本机与云端按 id 合并（本机优先）
  cfg.user_subscriptions = [
    ...customOnly(cfg.user_subscriptions),
    ...mergeInstanceLists(nonCustom(cfg.user_subscriptions), nonCustom(b.user_subscriptions)),
  ];
  cfg.user_payg_providers = [
    ...customOnly(cfg.user_payg_providers),
    ...mergeInstanceLists(nonCustom(cfg.user_payg_providers), nonCustom(b.user_payg_providers)),
  ];
  // direct_source_billing / source_template_overrides 纯本地，不被云端覆盖（保留 cfg 现值）
  return cfg;
}

async function fetchUserBilling(token, serverUrl) {
  return pickBilling(await requestJson('GET', serverUrl, '/user/accounts', token));
}

async function saveUserBilling(token, serverUrl, patch) {
  const { stripBillingSecrets } = require('../shared/accounts-summary');
  const body = {};
  for (const k of BILLING_FIELDS) {
    if (patch[k] !== undefined) body[k] = patch[k];
  }
  // 自定义实例(custom:true)不上云，只上传官方实例
  if (Array.isArray(body.user_subscriptions)) body.user_subscriptions = nonCustom(body.user_subscriptions);
  if (Array.isArray(body.user_payg_providers)) body.user_payg_providers = nonCustom(body.user_payg_providers);
  return pickBilling(await requestJson('PUT', serverUrl, '/user/accounts', token, stripBillingSecrets(body)));
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
  mergeInstanceLists,
  syncFromCloud,
  saveUserBilling,
  fetchUserBilling,
  isEmptyBilling,
  normalizeBase,
};

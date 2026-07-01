// catalog-sync.js — 后台拉 /api/catalog 写入 providers.registry.yaml；UI 只读 yaml
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const yaml = require('js-yaml');

const configLoader = require('./config-loader');

const USER_REGISTRY_YAML = path.join(os.homedir(), '.tokenbank', 'providers.registry.yaml');
const FETCH_TIMEOUT_MS = 12000;

let _syncInFlight = null;

function normalizeBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
}

/** GET /api/catalog → JSON */
function fetchCatalogJson(baseUrl) {
  const base = normalizeBase(baseUrl);
  if (!base) return Promise.resolve(null);
  const url = `${base}/api/catalog`;
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** catalog provider → registry.providers 条目 */
function catalogProviderToRegistry(p) {
  if (!p?.id) return null;
  const models = [];
  for (const m of p.models || []) {
    if (typeof m === 'string') {
      models.push({ id: m, modality: 'chat' });
    } else if (m && typeof m === 'object') {
      const id = String(m.name || m.id || m.model || '').trim();
      if (id) models.push({ id, modality: m.type || m.modality || 'chat' });
    }
  }
  // pricing 键补全 models
  const pricing = { ...(p.pricing && typeof p.pricing === 'object' ? p.pricing : {}) };
  for (const k of Object.keys(pricing)) {
    if (!k || k === '_excluded_models' || k === 'excluded_models') continue;
    if (!models.some(x => x.id === k)) models.push({ id: k, modality: 'chat' });
  }
  const out = {
    id: p.id,
    label: p.label || p.id,
    icon: p.icon || '🔧',
    tier: p.type || 'paid',
    hint: p.hint || '',
    base_url: p.base_url || '',
    handler: p.handler || 'openai',
    api_format: p.api_format || 'openai',
    enabled_default: !!p.enabled_default,
    keyless: !!p.keyless,
    key_prefix: Array.isArray(p.key_prefix) ? p.key_prefix : [],
    signup_url: p.signup_url || '',
    models,
    pricing,
  };
  if (p.payg) out.payg = true;
  if (p.modalities && typeof p.modalities === 'object') out.modalities = p.modalities;
  return out;
}

/** catalog subscription_sources → billing_sources 条目 */
function subscriptionSourceToBilling(s, existing) {
  const sid = s.id;
  if (!sid) return null;
  const pricing = { ...(s.pricing && typeof s.pricing === 'object' ? s.pricing : {}) };
  const models = [];
  const seen = new Set();
  const push = (id, modality = 'chat') => {
    const n = String(id || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    models.push({ id: n, modality, pricing: pricing[n] || {} });
  };
  for (const m of s.models || []) {
    if (typeof m === 'string') push(m);
    else if (m && typeof m === 'object') push(m.name || m.id, m.type || m.modality || 'chat');
  }
  for (const k of Object.keys(pricing)) push(k);
  const kind = s.kind === 'api_sub' ? 'api_sub' : 'app_sub';
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    id: existing?.id || sid,
    source_id: sid,
    category: kind,
    label: s.label || existing?.label || sid,
    icon: s.icon || existing?.icon || '🔧',
    agent_id: s.agent_id || existing?.agent_id || sid,
    plan_provider_id: s.plan_provider_id ?? existing?.plan_provider_id,
    subscription_to_api: s.subscription_to_api === true,
    base_url: s.base_url || existing?.base_url || '',
    api_format: s.api_format || existing?.api_format || 'openai',
    models: models.length ? models : (existing?.models || []),
    pricing: Object.keys(pricing).length ? pricing : (existing?.pricing || {}),
    plans: Array.isArray(s.plans) && s.plans.length ? s.plans : (existing?.plans || []),
    sort_order: existing?.sort_order ?? 0,
  };
}

/** 合并 /api/catalog 到 registry yaml 文档 */
function mergeCatalogIntoRegistryDoc(existingDoc, catalogPayload) {
  const existing = existingDoc && typeof existingDoc === 'object' ? existingDoc : {};
  const providers = (catalogPayload?.providers || [])
    .map(catalogProviderToRegistry)
    .filter(Boolean);

  const billingByKey = {};
  for (const s of existing.billing_sources || []) {
    const k = s.source_id || s.id;
    if (k) billingByKey[k] = { ...s };
  }
  for (const sub of catalogPayload?.subscription_sources || []) {
    const k = sub.id;
    if (!k) continue;
    const merged = subscriptionSourceToBilling(sub, billingByKey[k]);
    if (merged) billingByKey[k] = merged;
  }

  return {
    version: existing.version || catalogPayload?.version || 1,
    providers: providers.length ? providers : (existing.providers || []),
    billing_sources: Object.values(billingByKey).sort(
      (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
    ),
  };
}

function readExistingRegistryDoc() {
  try {
    if (fs.existsSync(USER_REGISTRY_YAML)) {
      return configLoader.mergeRegistryDoc(yaml.load(fs.readFileSync(USER_REGISTRY_YAML, 'utf8')) || {});
    }
  } catch {}
  return configLoader.mergeRegistryDoc(configLoader.registryDefaultDoc());
}

/** 写入 ~/.tokenbank/providers.registry.yaml 并刷新内存缓存 */
function writeRegistryDoc(doc) {
  const tbDir = path.dirname(USER_REGISTRY_YAML);
  if (!fs.existsSync(tbDir)) fs.mkdirSync(tbDir, { recursive: true });
  fs.writeFileSync(USER_REGISTRY_YAML, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
  configLoader.reloadRegistryDoc();
}

/**
 * 拉远端 catalog 写入 yaml；成功返回 { ok, updated }。
 * @param {{ baseUrl?: string, readLocalConfig?: () => object, onApplied?: () => void }} opts
 */
async function syncCatalogToRegistry(opts = {}) {
  const readCfg = opts.readLocalConfig || (() => ({}));
  const baseUrl = normalizeBase(
    opts.baseUrl || readCfg()?.cloud_config?.url || process.env.TOKEN_SERVER_URL || '',
  );
  if (!baseUrl) return { ok: false, error: 'no_server_url' };

  const catalogPayload = await fetchCatalogJson(baseUrl);
  if (!catalogPayload?.providers?.length) {
    return { ok: false, error: 'catalog_fetch_failed' };
  }

  const merged = mergeCatalogIntoRegistryDoc(readExistingRegistryDoc(), catalogPayload);
  writeRegistryDoc(merged);

  // 同步内存刊例价快照（billing-config 读 yaml 前可用）
  try {
    const billingConfig = require('./billing-config');
    billingConfig.setLiveCatalogPayload(catalogPayload);
  } catch {}

  // 按新 registry 清理本地过期计费项
  try {
    const billingConfig = require('./billing-config');
    const readLocalConfig = opts.readLocalConfig;
    const applyUserBillingCfg = opts.applyUserBillingCfg;
    if (readLocalConfig && applyUserBillingCfg) {
      const cfg = readLocalConfig();
      const { cfg: pruned, changed } = billingConfig.pruneLocalBillingAgainstServer(cfg);
      if (changed) applyUserBillingCfg(pruned);
    }
  } catch (e) {
    console.warn('[catalog-sync] prune billing failed:', e.message);
  }

  if (typeof opts.onApplied === 'function') opts.onApplied();
  return { ok: true, updated: true };
}

/** 非阻塞后台同步（去重） */
function scheduleBackgroundSync(opts = {}) {
  if (_syncInFlight) return _syncInFlight;
  _syncInFlight = syncCatalogToRegistry(opts)
    .catch(err => {
      console.warn('[catalog-sync] background sync failed:', err?.message || err);
      return { ok: false, error: String(err?.message || err) };
    })
    .finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}

/** UI 读取：始终从 yaml 生成 catalog 快照 */
function readCatalogFromYaml() {
  return configLoader.builtinCatalogPayload();
}

module.exports = {
  syncCatalogToRegistry,
  scheduleBackgroundSync,
  readCatalogFromYaml,
  mergeCatalogIntoRegistryDoc,
  fetchCatalogJson,
};

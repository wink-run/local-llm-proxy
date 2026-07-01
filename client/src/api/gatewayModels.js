// 本地网关可选模型：统一从 /v1/models 拉取（OpenAI 列表格式），网关页与调试页共用
import { getConfig, getGateway, getLocalConfig, isElectron } from './adapter';
import { getServerUrl, normalizeServerBase } from '../config';
import { loadUserAccounts } from './userAccounts';
import { fetchServerCommunityModels } from '../lib/communityModels';
import {
  collectPersonalAvailableModels,
  enrichProvidersForRouting,
  mergeAccountsForGateway,
} from '../lib/personalAvailableModels';

const modelId = (m) => (typeof m === 'string' ? m : (m?.name || m?.id || ''));

/** 本地 gateway HTTP 地址：Electron / Vite dev 固定 127.0.0.1，避免 file:// 或 localhost→::1 导致无效 URL */
export function resolveLocalGatewayHost() {
  if (isElectron()) return '127.0.0.1';
  const h = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
  if (!h || h === 'localhost' || h === '127.0.0.1') return '127.0.0.1';
  return h;
}

/** 根据 /v1/models 条目的 owned_by 推断 free | p2p | paid */
function tierFromOwnedBy(owned, provById = {}) {
  const ob = String(owned || '').trim();
  // Claude 透明名：仅供 Claude Desktop 校验，下拉不展示
  if (!ob || ob === 'anthropic') return null;
  if (ob === 'p2p' || ob === 'tokenbank-p2p' || ob === 'local') return 'p2p';
  const prov = provById[ob];
  if (prov?.type === 'free') return 'free';
  if (prov?.type === 'p2p') return 'p2p';
  if (prov?.type === 'paid') return 'paid';
  // 网关已暴露、配置里能匹配到 provider id → 视为个人付费层
  if (prov) return 'paid';
  return null;
}

/**
 * 解析 OpenAI 风格模型列表：{ object: 'list', data: [{ id, owned_by, ... }] }
 * @returns {Array<{ id: string, tier: 'free'|'p2p'|'paid' }>}
 */
export function parseV1ModelsResponse(json, provById = {}) {
  const out = [];
  const seen = new Set();
  for (const m of json?.data || []) {
    const id = m?.id;
    if (!id) continue;
    const tier = tierFromOwnedBy(m.owned_by, provById);
    if (!tier) continue;
    const k = `${tier}:${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const mtype = m?.model_type;
    out.push({
      id,
      tier,
      ...(mtype && mtype !== 'chat' ? { type: mtype } : {}),
    });
  }
  return out;
}

async function fetchV1ModelsJson(baseUrl, headers = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, { headers });
  if (!res.ok) return null;
  return res.json();
}

/** 拉取前先同步云端 P2P 模型到本地 gateway 缓存 */
async function refreshPeerModelsCache() {
  try {
    if (isElectron() && window.electronAPI?.gateway?.refreshPeerModels) {
      await window.electronAPI.gateway.refreshPeerModels();
    } else {
      await fetch('/api/gateway/refresh-peer-models', { method: 'POST' });
    }
  } catch {}
}

/** 读取本地 gateway 原始 /v1/models JSON（网关未启动时返回 null） */
async function fetchLocalGatewayV1ModelsJson() {
  let gwPort = null;
  let gwRunning = false;
  try {
    const gw = await getGateway().status();
    gwPort = gw?.port || null;
    gwRunning = !!gw?.running;
  } catch {}
  if (!gwPort || !gwRunning) return null;

  try {
    const host = resolveLocalGatewayHost();
    return await fetchV1ModelsJson(`http://${host}:${gwPort}`);
  } catch {
    return null;
  }
}

/** 本地网关 /v1/models（网关未启动时返回 null） */
async function fetchLocalGatewayV1Models(provById) {
  const json = await fetchLocalGatewayV1ModelsJson();
  if (!json) return null;
  const models = parseV1ModelsResponse(json, provById);
  return models.length ? models : null;
}

/**
 * 云端 /v1/models（网关未运行时回退，主要为社区 P2P）。
 * 仅接受 cloud_config API Key，不能用登录 JWT。
 */
async function fetchCloudV1ModelsJson() {
  try {
    const cfg = await getLocalConfig().get().catch(() => null);
    const base = normalizeServerBase(cfg?.cloud_config?.url || getServerUrl());
    const apiKey = cfg?.cloud_config?.token;
    if (!base || !apiKey) return null;

    if (typeof window !== 'undefined' && window.electronAPI?.auth?.request) {
      const r = await window.electronAPI.auth.request({
        base, method: 'GET', path: '/v1/models', token: apiKey,
      });
      if (r.status < 200 || r.status >= 300 || !r.body) return null;
      return JSON.parse(r.body);
    }

    return await fetchV1ModelsJson(base, { Authorization: `Bearer ${apiKey}` });
  } catch {
    return null;
  }
}

async function fetchCloudV1Models(provById) {
  const json = await fetchCloudV1ModelsJson();
  return json ? parseV1ModelsResponse(json, provById) : [];
}

/** 按 tier:id 合并条目，同名模型在不同层可并存；保留已有 type */
function mergeModelEntriesByTier(existing, additions) {
  const byKey = new Map(existing.map(m => [`${m.tier}:${m.id}`, m]));
  for (const m of additions) {
    const key = `${m.tier}:${m.id}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, ...m, type: m.type || prev.type } : m);
  }
  return [...byKey.values()];
}

/** 补全供给源登记的个人模型（与 /v1/models 并存，不覆盖同 id 的社区层） */
function mergePersonalModelsFromAccounts(models, cfg, acc) {
  const mergedAccounts = mergeAccountsForGateway(cfg || {}, acc || {});
  const personal = collectPersonalAvailableModels(cfg || {}, mergedAccounts)
    .filter(m => m.tier !== 'p2p');
  return mergeModelEntriesByTier(models, personal);
}

/** 与网关下拉同源：优先本地 /v1/models，否则云端 */
export async function fetchGatewayV1ModelsJson() {
  await refreshPeerModelsCache();
  const local = await fetchLocalGatewayV1ModelsJson();
  if (local?.data?.length) return local;
  return fetchCloudV1ModelsJson();
}

/**
 * 网关下拉可选模型：优先本地网关 /v1/models，与 OpenAI 列表接口一致。
 * @param {{ includeCommunity?: boolean }} [opts] includeCommunity=false 时排除社区 P2P 层（未登录）
 * @returns {Promise<Array<{ id: string, tier: 'free'|'p2p'|'paid' }>>}
 */
export async function loadGatewayAvailableModels(opts = {}) {
  const { includeCommunity = true } = opts;
  let cfg = null;
  let acc = null;
  let provById = {};
  try {
    [cfg, acc] = await Promise.all([
      getConfig().read().catch(() => null),
      loadUserAccounts({ localOnly: true }).catch(() => null),
    ]);
    provById = Object.fromEntries((cfg?.providers || []).map(p => [p.id, p]));
  } catch {}

  await refreshPeerModelsCache();
  const local = await fetchLocalGatewayV1Models(provById);
  let models = local?.length ? local : [];

  if (!models.length) {
    try {
      models = await fetchCloudV1Models(provById);
    } catch (e) {
      console.error('loadGatewayAvailableModels', e);
      models = [];
    }
  }

  // 补全 /v1/models 未覆盖的个人登记模型（如仅写在刊例价覆盖里、或与社区同名）
  models = mergePersonalModelsFromAccounts(models, cfg, acc);

  // 社区层与云端 /v1/models 一致（worker 可见性由服务端处理）；个人层仍来自本地 /v1/models
  if (includeCommunity) {
    try {
      const { entries } = await fetchServerCommunityModels();
      models = mergeModelEntriesByTier(models.filter(m => m.tier !== 'p2p'), entries);
    } catch { /* 离线时保留本地解析的 p2p */ }
  } else {
    models = models.filter(m => m.tier !== 'p2p');
  }
  return enrichModelsWithType(models, cfg, acc);
}

/** 模型名启发式推断模态（账户/供给源未标注时兜底） */
export function inferModelTypeFromName(id) {
  const n = String(id || '').toLowerCase();
  if (/(?:^|[\-_/])image(?:[\-_/]|$|\d)|gpt-image|dall-e|stable-diffusion|flux-|midjourney/.test(n)) {
    return 'image';
  }
  if (/embed|text-embedding|bge-|e5-/.test(n)) return 'embedding';
  return 'chat';
}

function ingestModelType(map, m) {
  const id = modelId(m);
  if (!id) return;
  const t = typeof m === 'string' ? null : (m.type || m.modality);
  if (t && t !== 'chat') map[id] = t;
}

/** 供给源 models 列表 → id → type 映射（含账户登记模型） */
export function buildModelTypeMap(providers = [], accounts = null) {
  const map = {};
  for (const p of providers) {
    for (const m of p.models || []) ingestModelType(map, m);
  }
  if (accounts) {
    for (const p of accounts.user_payg_providers || []) {
      for (const m of p.models || []) ingestModelType(map, m);
    }
    for (const s of accounts.user_subscriptions || []) {
      for (const m of s.models || []) ingestModelType(map, m);
    }
    for (const d of Object.values(accounts.direct_source_billing || {})) {
      for (const m of d.models || []) ingestModelType(map, m);
    }
  }
  return map;
}

/** 个人源页 / 路由下拉共用的 type 映射 */
export function buildPersonalModelTypeMap(cfg, accounts) {
  const merged = mergeAccountsForGateway(cfg || {}, accounts || {});
  const providers = enrichProvidersForRouting(cfg?.providers || [], merged);
  return buildModelTypeMap(providers, merged);
}

/** 社区 P2P 模型（与云端 /v1/models 同源） */
export async function loadCommunityP2pModels(opts = {}) {
  const { includeCommunity = true } = opts;
  if (!includeCommunity) return [];
  const { entries } = await fetchServerCommunityModels();
  return entries;
}

/** 从供给源配置解析模型类型（chat / image / embedding） */
export function resolveGatewayModelType(id, cfg, accounts = null) {
  const typeMap = buildPersonalModelTypeMap(cfg, accounts);
  return typeMap[id] || inferModelTypeFromName(id);
}

/** 为下拉条目补全模态（供给源 + 账户 + 名称推断） */
export function enrichModelsWithType(models, cfg, accounts = null) {
  const typeMap = buildPersonalModelTypeMap(cfg, accounts);
  return (models || []).map(m => {
    const type = m.type || typeMap[m.id] || inferModelTypeFromName(m.id);
    if (type === 'chat') return m;
    return { ...m, type };
  });
}

// 本地网关可选模型（free / p2p / paid），网关页与调试页共用
import { getConfig, getGateway, getLocalConfig, isElectron } from './adapter';
import { getServerUrl, normalizeServerBase } from '../config';
import { loadUserAccounts } from './userAccounts';
import { collectPersonalAvailableModels, enrichProvidersForRouting, filterRoutablePersonalModels } from '../lib/personalAvailableModels';

function addAvailableModel(models, seen, id, tier) {
  if (!id || !tier) return;
  const k = `${tier}:${id}`;
  if (seen.has(k)) return;
  seen.add(k);
  models.push({ id, tier });
}

const modelId = (m) => (typeof m === 'string' ? m : (m?.name || m?.id || ''));

/** 本地 gateway HTTP 地址：Electron / Vite dev 固定 127.0.0.1，避免 file:// 或 localhost→::1 导致无效 URL */
export function resolveLocalGatewayHost() {
  if (isElectron()) return '127.0.0.1';
  const h = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
  if (!h || h === 'localhost' || h === '127.0.0.1') return '127.0.0.1';
  return h;
}

/**
 * 从 Token Bank 云端拉取当前在线 P2P 模型。
 * /v1/models 仅接受用户 API Key（cloud_config.token），不能用登录 JWT。
 */
async function fetchCloudPeerModelIds() {
  try {
    const cfg = await getLocalConfig().get().catch(() => null);
    const base = normalizeServerBase(cfg?.cloud_config?.url || getServerUrl());
    const apiKey = cfg?.cloud_config?.token;
    if (!base || !apiKey) return [];

    if (typeof window !== 'undefined' && window.electronAPI?.auth?.request) {
      const r = await window.electronAPI.auth.request({
        base, method: 'GET', path: '/v1/models', token: apiKey,
      });
      if (r.status < 200 || r.status >= 300 || !r.body) return [];
      const data = JSON.parse(r.body);
      return (data.data || []).map(m => m.id).filter(Boolean);
    }

    const res = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(m => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

/** 刷新本地 gateway 缓存的 peerModels（Electron IPC / Docker admin API） */
async function refreshGatewayPeerModelsCache() {
  try {
    if (isElectron() && window.electronAPI?.gateway?.refreshPeerModels) {
      const gw = await window.electronAPI.gateway.refreshPeerModels();
      return gw?.peerModels || [];
    }
    const r = await fetch('/api/gateway/refresh-peer-models', { method: 'POST' });
    if (!r.ok) return [];
    const gw = await getGateway().status();
    return gw?.peerModels || [];
  } catch {
    return [];
  }
}

/** @returns {Promise<Array<{ id: string, tier: 'free'|'p2p'|'paid' }>>} */
export async function loadGatewayAvailableModels() {
  const models = [];
  const seen = new Set();
  const add = (id, tier) => addAvailableModel(models, seen, id, tier);

  let cfg = null;
  let acc = null;
  try {
    [cfg, acc] = await Promise.all([
      getConfig().read().catch(() => null),
      loadUserAccounts({ localOnly: true }).catch(() => null),
    ]);
  } catch {}

  // 个人层：与供给源页一致，且须已启用供给源可路由
  try {
    const localMerged = {
      ...(acc || {}),
      provider_pricing_overrides: cfg?.provider_pricing_overrides || acc?.provider_pricing_overrides || {},
    };
    const providerPricing = cfg?.provider_pricing || {};
    const enrichedProviders = enrichProvidersForRouting(cfg?.providers || [], localMerged);
    const gwIds = new Set([
      ...(acc?.gateway_provider_ids || []),
      ...(acc?.user_payg_providers || []).map(p => p.gateway_id || p.provider_id).filter(Boolean),
      ...(acc?.user_subscriptions || []).map(s => s.gateway_id).filter(Boolean),
    ]);
    const personal = filterRoutablePersonalModels(
      collectPersonalAvailableModels(cfg || {}, acc || {}),
      enrichedProviders,
      gwIds,
    );
    for (const { id, tier } of personal) add(id, tier);
  } catch {}

  // 补充：已启用但未纳入账户实例的免费源（如独立 Ollama）
  try {
    for (const p of (cfg?.providers || [])) {
      if (!p.enabled || p.type !== 'free') continue;
      for (const m of (p.models || [])) add(modelId(m), 'free');
    }
  } catch {}

  try {
    const online = new Set();
    let gwPort = null;
    let gwRunning = false;
    try {
      const gw = await getGateway().status();
      gwPort = gw?.port || null;
      gwRunning = !!gw?.running;
      for (const id of (gw?.peerModels || [])) online.add(id);
    } catch {}

    // gateway 未运行时勿请求本地 /v1/models（避免 CONNECTION_REFUSED 刷屏）
    if (gwPort && gwRunning) {
      try {
        const host = resolveLocalGatewayHost();
        const lr = await fetch(`http://${host}:${gwPort}/v1/models`);
        if (lr.ok) {
          const lj = await lr.json();
          const provById = Object.fromEntries((cfg?.providers || []).map(p => [p.id, p]));
          for (const m of (lj.data || [])) {
            const id = m.id;
            if (!id) continue;
            const owned = m.owned_by || '';
            if (owned === 'p2p' || owned === 'tokenbank-p2p') {
              online.add(id);
              add(id, 'p2p');
            } else if (owned === 'anthropic') {
              // Claude 透明名，调试页不展示
            } else {
              const prov = provById[owned];
              const pt = prov?.type;
              const configured = new Set((prov?.models || []).map(modelId));
              const inList = !configured.size || configured.has(id);
              if (pt === 'free' && inList) add(id, 'free');
              else if (pt === 'paid' && inList) add(id, 'paid');
              else if (pt === 'p2p') { online.add(id); add(id, 'p2p'); }
            }
          }
        }
      } catch {}
    }

    if (online.size === 0) {
      // 先用 cloud_config API Key 刷新 gateway，再直连云端拉模型列表
      for (const id of await refreshGatewayPeerModelsCache()) online.add(id);
    }
    if (online.size === 0) {
      for (const id of await fetchCloudPeerModelIds()) online.add(id);
    }
    // P2P 下拉仅以当前在线模型为准（与供给源页 P2P 网络列表一致）
    for (const id of online) add(id, 'p2p');
  } catch (e) {
    console.error('loadGatewayAvailableModels', e);
  }

  return models;
}

/** 从供给源配置解析模型类型（chat / image） */
export function resolveGatewayModelType(id, cfg) {
  for (const p of (cfg?.providers || [])) {
    for (const m of (p.models || [])) {
      const mid = modelId(m);
      if (mid === id) return typeof m === 'string' ? 'chat' : (m.type || 'chat');
    }
  }
  return 'chat';
}

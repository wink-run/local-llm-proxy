// 本地网关可选模型（free / p2p / paid），网关页与调试页共用
import { getConfig, getGateway } from './adapter';
import { getOnlineModels } from './client';
import { loadUserAccounts } from './userAccounts';

function addAvailableModel(models, seen, id, tier) {
  if (!id || !tier) return;
  const k = `${tier}:${id}`;
  if (seen.has(k)) return;
  seen.add(k);
  models.push({ id, tier });
}

const modelId = (m) => (typeof m === 'string' ? m : (m?.name || m?.id || ''));

/** @returns {Promise<Array<{ id: string, tier: 'free'|'p2p'|'paid' }>>} */
export async function loadGatewayAvailableModels() {
  const models = [];
  const seen = new Set();
  const add = (id, tier) => addAvailableModel(models, seen, id, tier);

  let gatewayAllow = null;
  try {
    const acc = await loadUserAccounts();
    if (acc?.gateway_provider_ids) gatewayAllow = new Set(acc.gateway_provider_ids);
  } catch {}

  try {
    const cfg = await getConfig().read();
    for (const p of (cfg?.providers || [])) {
      if (!p.enabled || p.type === 'p2p') continue;
      if (p.type === 'paid' && gatewayAllow && !gatewayAllow.has(p.id)) continue;
      for (const m of (p.models || [])) add(modelId(m), p.type);
    }
  } catch {}

  try {
    const online = new Set();
    let gwPort = null;
    try {
      const gw = await getGateway().status();
      gwPort = gw?.port || null;
      for (const id of (gw?.peerModels || [])) online.add(id);
    } catch {}

    if (gwPort) {
      try {
        const host = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
        const lr = await fetch(`http://${host}:${gwPort}/v1/models`);
        if (lr.ok) {
          const lj = await lr.json();
          const cfgForTier = (await getConfig().read().catch(() => null)) || {};
          const provById = Object.fromEntries((cfgForTier.providers || []).map(p => [p.id, p]));
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
              const pt = provById[owned]?.type;
              if (pt === 'free') add(id, 'free');
              else if (pt === 'paid') add(id, 'paid');
              else if (pt === 'p2p') { online.add(id); add(id, 'p2p'); }
            }
          }
        }
      } catch {}
    }

    if (online.size === 0) {
      try { for (const m of ((await getOnlineModels()).data?.data || [])) online.add(m.id); } catch {}
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

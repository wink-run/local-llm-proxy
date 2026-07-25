// 前端 Hit-or-Exit 分层（与 electron/resource-hit-or-exit.js 阈值对齐）
const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

export const LIFECYCLE_THRESHOLDS = {
  nudgeHours: 48,
  dormantDays: 7,
  coldDays: 30,
};

/** Token Bank 内置智能体不参与 Hit-or-Exit 评估 */
export function isLifecycleExempt(resource) {
  if (!resource || resource.type !== 'assistant') return false;
  if (resource.source === 'builtin') return true;
  if (resource.metadata && resource.metadata.builtin) return true;
  const url = String(resource.source_url || '');
  if (url.startsWith('builtin:')) return true;
  const name = String(resource.name || '');
  if (name === 'resource-installer' || name === 'resource-finder') return true;
  return false;
}

function readHitMeta(resource) {
  const meta = resource?.metadata && typeof resource.metadata === 'object'
    ? resource.metadata
    : {};
  const useCount = Math.max(
    0,
    Number(resource?.use_count ?? meta.use_count ?? 0) || 0,
  );
  const lastUsedRaw = resource?.last_used_at ?? meta.last_used_at ?? null;
  const lastUsedAt = lastUsedRaw != null ? Number(lastUsedRaw) || 0 : 0;
  const createdAt = Number(resource?.created_at || 0) || 0;
  const projections = Array.isArray(resource?.projections) ? resource.projections : [];
  let enabledAt = 0;
  for (const p of projections) {
    const t = Number(p.createdAt || p.created_at || 0) || 0;
    if (t && (!enabledAt || t < enabledAt)) enabledAt = t;
  }
  if (!enabledAt) enabledAt = createdAt;
  return { useCount, lastUsedAt, enabledAt, projectionCount: projections.length };
}

/** @returns {{ layer: string, nudge: string|null, useCount: number, ageMs: number }} */
export function classifyLifecycle(resource, now = Date.now()) {
  if (isLifecycleExempt(resource)) {
    const meta = readHitMeta(resource);
    return {
      layer: 'exempt',
      nudge: null,
      useCount: meta.useCount,
      lastUsedAt: meta.lastUsedAt,
      ageMs: 0,
      projectionCount: meta.projectionCount,
    };
  }

  const { useCount, lastUsedAt, enabledAt, projectionCount } = readHitMeta(resource);
  const ageMs = Math.max(0, Number(now) - (enabledAt || Number(now)));

  if (useCount > 0) {
    return { layer: 'active', nudge: null, useCount, lastUsedAt, ageMs, projectionCount };
  }
  if (projectionCount === 0) {
    return { layer: 'shelf', nudge: null, useCount, lastUsedAt, ageMs, projectionCount };
  }
  if (ageMs >= LIFECYCLE_THRESHOLDS.coldDays * MS_DAY) {
    return { layer: 'cold', nudge: 'cold_letter', useCount, lastUsedAt, ageMs, projectionCount };
  }
  if (ageMs >= LIFECYCLE_THRESHOLDS.dormantDays * MS_DAY) {
    return { layer: 'dormant', nudge: 'unproject', useCount, lastUsedAt, ageMs, projectionCount };
  }
  if (ageMs >= LIFECYCLE_THRESHOLDS.nudgeHours * MS_HOUR) {
    return { layer: 'pending', nudge: 'invoke', useCount, lastUsedAt, ageMs, projectionCount };
  }
  return { layer: 'pending', nudge: null, useCount, lastUsedAt, ageMs, projectionCount };
}

export function lifecycleSortRank(layer) {
  switch (layer) {
    case 'exempt': return 0;
    case 'active': return 0;
    case 'pending': return 1;
    case 'dormant': return 2;
    case 'cold': return 3;
    case 'shelf': return 4;
    default: return 5;
  }
}

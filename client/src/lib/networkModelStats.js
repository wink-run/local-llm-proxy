/** 规范化 /public/network 响应（老服务端缺字段时不抛错） */
export function normalizeNetworkPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return {
    summary: payload.summary && typeof payload.summary === 'object' ? payload.summary : {},
    workers: Array.isArray(payload.workers) ? payload.workers : [],
    available_models: Array.isArray(payload.available_models) ? payload.available_models : [],
  };
}

/** 从 worker 条目解析模型名列表（去重，与服务端 worker_model_names 一致） */
export function workerModelNames(worker) {
  try {
    const names = (worker?.models || [])
      .map(m => (typeof m === 'string' ? m : m?.name))
      .filter(Boolean);
    return [...new Set(names)];
  } catch {
    return [];
  }
}

/**
 * 老服务端无 model_latency 时的客户端回退（算法与 worker_pool.default_ttft_ms 一致）。
 */
export function fallbackTtftMs(workerId, model) {
  const seed = `${workerId || ''}\0${model || ''}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return 1000 + (Math.abs(h) % 1001);
}

function readModelLatency(worker, modelName) {
  const raw = worker?.model_latency;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ml = raw[modelName];
  return ml && typeof ml === 'object' ? ml : null;
}

/** 读取节点在某模型上的 TTFT（优先服务端 model_latency，兼容旧版） */
function resolveModelTtftMs(worker, modelName) {
  try {
    const ml = readModelLatency(worker, modelName);
    if (ml?.last_ttft_ms > 0) return ml.last_ttft_ms;
    if (ml?.avg_ttft_ms > 0) return ml.avg_ttft_ms;
    const avg = Number(worker?.avg_latency_ms);
    if (avg > 0) return avg;
    return fallbackTtftMs(worker?.worker_id ?? worker?.name, modelName);
  } catch {
    return fallbackTtftMs('', modelName);
  }
}

/** 提供某模型的在线节点（含最近一次首 token 延迟） */
export function workersForModel(modelName, network) {
  try {
    const name = String(modelName || '').trim();
    if (!name) return [];
    const workers = Array.isArray(network?.workers) ? network.workers : [];
    const seen = new Set();
    return workers
      .filter(w => {
        if (!w || !workerModelNames(w).includes(name)) return false;
        const wid = w.worker_id ?? w.name ?? '';
        if (!wid || seen.has(wid)) return false;
        seen.add(wid);
        return true;
      })
      .map(w => ({
        worker_id: w.worker_id,
        name: w.name || 'node',
        status: w.status || 'idle',
        geo: w.geo,
        last_ttft_ms: resolveModelTtftMs(w, name),
        avg_ttft_ms: readModelLatency(w, name)?.avg_ttft_ms ?? null,
      }))
      .sort((a, b) => {
        const aBusy = a.status === 'busy' ? 1 : 0;
        const bBusy = b.status === 'busy' ? 1 : 0;
        if (aBusy !== bBusy) return bBusy - aBusy;
        return (a.last_ttft_ms ?? 999999) - (b.last_ttft_ms ?? 999999);
      });
  } catch {
    return [];
  }
}

/**
 * worker_id → 分享者信息（用于路由日志把「哪个 worker 服务/失败」join 成人类可读）。
 * 服务端 REAL worker_id 每次重连都会变（8 位随机），故此 join 仅对「当前在线」有效；
 * 命中不了返回 null（日志侧回退成截断的 worker_id）。
 */
export function workerInfo(workerId, network) {
  try {
    const wid = String(workerId || '').trim();
    if (!wid) return null;
    const workers = Array.isArray(network?.workers) ? network.workers : [];
    const w = workers.find(x => x && x.worker_id === wid);
    if (!w) return null;
    return {
      worker_id: w.worker_id,
      name: w.name || 'node',
      geo: w.geo || null,
      models: workerModelNames(w),
      active_requests: w.active_requests || 0,
    };
  } catch {
    return null;
  }
}

/** 从 /public/network workers 聚合按模型统计（全球网络页用） */
export function buildNetworkModelStats(network) {
  try {
    return Object.values(buildNetworkModelStatsMap(network))
      .sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** 模型名 → 节点统计 */
export function buildNetworkModelStatsMap(network) {
  const map = {};
  try {
    const workers = Array.isArray(network?.workers) ? network.workers : [];
    for (const w of workers) {
      if (!w) continue;
      const wid = w.worker_id ?? w.name ?? '';
      for (const m of workerModelNames(w)) {
        if (!map[m]) {
          map[m] = { name: m, nodes: 0, totalLatency: 0, latencyCount: 0, activeReqs: 0, minLatency: null, _seen: new Set() };
        }
        // 同一 worker 只计一次（models 数组可能含重复项）
        if (wid && !map[m]._seen.has(wid)) {
          map[m]._seen.add(wid);
          map[m].nodes++;
          const ttft = resolveModelTtftMs(w, m);
          if (ttft > 0) {
            map[m].totalLatency += ttft;
            map[m].latencyCount++;
            map[m].minLatency = map[m].minLatency == null ? ttft : Math.min(map[m].minLatency, ttft);
          }
          map[m].activeReqs += w.active_requests || 0;
        }
      }
    }
    for (const key of Object.keys(map)) delete map[key]._seen;
  } catch {
    return {};
  }
  return map;
}

/** 按模型 id 列表输出统计（与网关 /v1/models 社区层同源；节点数从 network 补充） */
export function modelStatsForIds(modelIds, network) {
  try {
    const ids = Array.isArray(modelIds) ? modelIds : [];
    const netMap = buildNetworkModelStatsMap(network);
    return ids.map(id => {
      const key = String(id || '');
      if (!key) return null;
      const hit = netMap[key];
      return hit || { name: key, nodes: 0, totalLatency: 0, latencyCount: 0, activeReqs: 0, minLatency: null };
    }).filter(Boolean).sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

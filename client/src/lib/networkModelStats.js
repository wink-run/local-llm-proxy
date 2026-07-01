/** 从 /public/network workers 聚合按模型统计（全球网络页用） */
export function buildNetworkModelStats(network) {
  return Object.values(buildNetworkModelStatsMap(network))
    .sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name));
}

/** 模型名 → 节点统计 */
export function buildNetworkModelStatsMap(network) {
  const map = {};
  for (const w of (network?.workers || [])) {
    for (const m of (w.models || [])) {
      if (!map[m]) {
        map[m] = { name: m, nodes: 0, totalLatency: 0, latencyCount: 0, activeReqs: 0 };
      }
      map[m].nodes++;
      if (w.avg_latency_ms > 0) {
        map[m].totalLatency += w.avg_latency_ms;
        map[m].latencyCount++;
      }
      map[m].activeReqs += w.active_requests || 0;
    }
  }
  return map;
}

/** 按模型 id 列表输出统计（与网关 /v1/models 社区层同源；节点数从 network 补充） */
export function modelStatsForIds(modelIds, network) {
  const netMap = buildNetworkModelStatsMap(network);
  return (modelIds || []).map(id => {
    const hit = netMap[id];
    return hit || { name: id, nodes: 0, totalLatency: 0, latencyCount: 0, activeReqs: 0 };
  }).sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name));
}

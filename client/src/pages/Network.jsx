import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getNetwork, getStats } from '../api/client';

// Extract param size from model name, e.g. "llama-3.3-70b" → "70B"
function parseSize(name) {
  const m = name.match(/[:\-_](\d+(?:\.\d+)?)[bB]\b/);
  if (m) return m[1].replace(/\.0$/, '') + 'B';
  const m2 = name.match(/(\d+(?:\.\d+)?)[bB](?:[:\-_]|$)/);
  if (m2) return m2[1].replace(/\.0$/, '') + 'B';
  return null;
}

// Animated ping dot for available models
function PingDot({ color = 'green' }) {
  const colors = {
    green:  { ring: 'bg-green-400',  dot: 'bg-green-500'  },
    amber:  { ring: 'bg-amber-400',  dot: 'bg-amber-500'  },
    gray:   { ring: 'bg-gray-500',   dot: 'bg-gray-600'   },
  };
  const c = colors[color] || colors.green;
  if (color === 'gray') {
    return <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />;
  }
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${c.ring} opacity-60`} />
      <span className={`relative inline-flex rounded-full h-2 w-2 ${c.dot}`} />
    </span>
  );
}

export default function Network() {
  const navigate  = useNavigate();
  const [network, setNetwork] = useState(null);
  const [myStats, setMyStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [netRes, statsRes] = await Promise.allSettled([getNetwork(), getStats()]);
        if (cancelled) return;
        if (netRes.status === 'fulfilled')   setNetwork(netRes.value.data);
        if (statsRes.status === 'fulfilled') setMyStats(statsRes.value.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Aggregate per-model stats ─────────────────────────────────────────────

  const modelStats = useMemo(() => {
    if (!network?.workers) return [];
    const map = {};
    for (const w of network.workers) {
      for (const m of (w.models || [])) {
        if (!map[m]) map[m] = { name: m, nodes: 0, totalLatency: 0, latencyCount: 0, activeReqs: 0 };
        map[m].nodes++;
        if (w.avg_latency_ms > 0) {
          map[m].totalLatency  += w.avg_latency_ms;
          map[m].latencyCount++;
        }
        map[m].activeReqs += w.active_requests || 0;
      }
    }
    return Object.values(map).sort((a, b) => b.nodes - a.nodes);
  }, [network]);

  // Sort workers by tokens as contributor ranking proxy
  const topWorkers = useMemo(() => {
    if (!network?.workers) return [];
    return [...network.workers].sort((a, b) => (b.period_tokens || 0) - (a.period_tokens || 0)).slice(0, 5);
  }, [network]);

  const totalNodes  = network?.summary?.online_workers ?? 0;
  const totalModels = modelStats.length;
  const totalTokens = network?.workers?.reduce((s, w) => s + (w.period_tokens || 0), 0) ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-1">
            <button onClick={() => navigate('/providers')}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors">
              ← 供给源
            </button>
          </div>
          <h1 className="text-xl font-semibold text-gray-100 flex items-center gap-2">
            🌐 全球 P2P 网络
            <span className="text-[10px] bg-blue-900/50 text-blue-400 border border-blue-800/50 px-1.5 py-0.5 rounded-full font-normal">
              ● 运行中
            </span>
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">由社区节点共同构成的分布式推理网络</p>
        </div>
        <button onClick={() => navigate('/contribute')}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2">
          <span>💪</span> 加入贡献
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">全球节点</div>
          <div className="text-2xl font-bold text-blue-400 mt-1">{loading ? '—' : totalNodes}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">在线 Worker</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">可用模型</div>
          <div className="text-2xl font-bold text-gray-100 mt-1">{loading ? '—' : totalModels}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">跨节点去重</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">贡献 Token</div>
          <div className="text-2xl font-bold text-gray-100 mt-1">
            {loading ? '—' : totalTokens > 999 ? (totalTokens / 1000).toFixed(1) + 'K' : totalTokens}
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">本周期</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">活跃用户</div>
          <div className="text-2xl font-bold text-green-400 mt-1">
            {loading ? '—' : network?.summary?.active_users ?? 0}
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">正在贡献</div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">加载中…</div>
      ) : !network ? (
        <div className="text-sm text-gray-500">无法连接到服务器，请检查网络或服务端状态。</div>
      ) : (
        <div className="grid grid-cols-2 gap-5">

          {/* Left: Model list */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-200">可用模型</h2>
              <span className="text-[10px] text-gray-600">按节点数排序</span>
            </div>
            <div className="divide-y divide-gray-800/50">
              {modelStats.length === 0 ? (
                <div className="px-5 py-6 text-xs text-gray-600">暂无在线模型</div>
              ) : modelStats.map(m => {
                const isBusy = m.nodes > 0 && m.activeReqs > m.nodes * 0.8;
                const dot    = m.nodes === 0 ? 'gray' : isBusy ? 'amber' : 'green';
                const avgS   = m.latencyCount > 0
                  ? (m.totalLatency / m.latencyCount / 1000).toFixed(1)
                  : null;
                const size   = parseSize(m.name);
                return (
                  <div key={m.name}
                    className={`flex items-center gap-3 px-5 py-3 ${m.nodes === 0 ? 'opacity-50' : ''}`}
                  >
                    <PingDot color={dot} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-mono font-medium ${m.nodes === 0 ? 'text-gray-500' : 'text-gray-200'}`}>
                          {m.name}
                        </span>
                        {size && (
                          <span className="text-[9px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{size}</span>
                        )}
                      </div>
                      {isBusy && m.nodes > 0 && (
                        <div className="text-[10px] text-amber-600 mt-0.5">繁忙 · 等待中</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {m.nodes > 0 ? (
                        <>
                          <div className="text-xs font-medium text-gray-300">{m.nodes} 节点</div>
                          <div className={`text-[10px] mt-0.5 ${isBusy ? 'text-amber-700' : 'text-gray-600'}`}>
                            {avgS ? `avg ${avgS}s` : '—'}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="text-xs text-gray-600">0 节点</div>
                          <div className="text-[10px] text-gray-600">暂不可用</div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-3">

            {/* Contributor ranking */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-200">贡献排行</h2>
                <span className="text-[10px] text-gray-600">按 Token 贡献量</span>
              </div>
              <div className="divide-y divide-gray-800/50">
                {topWorkers.length === 0 ? (
                  <div className="px-5 py-6 text-xs text-gray-600">暂无贡献数据</div>
                ) : topWorkers.map((w, i) => {
                  const rank     = i + 1;
                  const rankColor = rank === 1 ? 'text-amber-400' : rank === 2 ? 'text-gray-300' : rank === 3 ? 'text-amber-700' : 'text-gray-600';
                  const modelSummary = (w.models || []).slice(0, 3).join(' · ');
                  return (
                    <div key={w.worker_id || w.name} className="flex items-center gap-3 px-5 py-3">
                      <span className={`text-xs font-bold w-5 shrink-0 ${rankColor}`}>#{rank}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-gray-300 truncate">{w.name}</div>
                        {modelSummary && (
                          <div className="text-[10px] text-gray-600 mt-0.5 truncate">{modelSummary}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-medium text-gray-300">
                          {(w.period_tokens || 0).toLocaleString()} tok
                        </div>
                        <div className="text-[10px] text-gray-600">{w.avg_latency_ms ?? 0} ms</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* My node status */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-200">你的节点状态</h2>
                {myStats && myStats.active_workers > 0 ? (
                  <span className="text-[10px] bg-green-900/40 text-green-400 border border-green-800/30 px-1.5 py-0.5 rounded-full">
                    ● 在线
                  </span>
                ) : (
                  <span className="text-[10px] bg-gray-800 text-gray-500 border border-gray-700 px-1.5 py-0.5 rounded-full">
                    ○ 离线
                  </span>
                )}
              </div>
              {myStats ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-gray-800/50 rounded-lg p-3">
                      <div className="text-[10px] text-gray-500">活跃节点</div>
                      <div className="text-lg font-bold mt-0.5 text-gray-100">{myStats.active_workers ?? 0}</div>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-3">
                      <div className="text-[10px] text-gray-500">活跃请求</div>
                      <div className="text-lg font-bold mt-0.5 text-gray-100">{myStats.active_requests ?? 0}</div>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-3 col-span-2">
                      <div className="text-[10px] text-gray-500">贡献速率</div>
                      <div className="text-lg font-bold mt-0.5 text-blue-400">
                        {myStats.contribute_req_per_min ?? 0}
                        <span className="text-xs font-normal text-gray-500 ml-1">req/min</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => navigate('/contribute')}
                    className="flex items-center justify-center gap-2 w-full py-2 text-xs text-blue-400 hover:text-blue-300 border border-gray-700 hover:border-gray-600 rounded-lg transition-colors">
                    管理贡献设置 →
                  </button>
                </>
              ) : (
                <p className="text-xs text-gray-600">需要登录后查看</p>
              )}
            </div>

            {/* All workers list */}
            {network.workers.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-200">在线节点</h2>
                  <span className="text-[10px] text-gray-600">{network.workers.length} 个</span>
                </div>
                <div className="divide-y divide-gray-800/50 max-h-56 overflow-y-auto">
                  {network.workers.map(w => (
                    <div key={w.worker_id || w.name}
                      className="flex items-center gap-3 px-5 py-2.5">
                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-gray-300 truncate">{w.name}</span>
                        <div className="text-[10px] text-gray-600 truncate mt-0.5">
                          {(w.models || []).join(', ')}
                        </div>
                      </div>
                      <div className="text-right shrink-0 text-[10px] text-gray-600">
                        <div>{w.avg_latency_ms ?? 0} ms</div>
                        <div>{Math.round(w.online_mins ?? 0)} min</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

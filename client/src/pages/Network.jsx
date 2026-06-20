import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getNetwork, getStats } from '../api/client';
import { useLang } from '../store/lang';

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
    gray:   { ring: 'bg-zinc-800',   dot: 'bg-zinc-800'   },
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
  const { t } = useLang();
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
    <div className="px-5 py-5 space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-1">
            <button onClick={() => navigate('/providers')}
              className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors">
              {t('network.backProviders')}
            </button>
          </div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            {t('network.title')}
            <span className="text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 border border-blue-300 dark:border-blue-800/50 px-1.5 py-0.5 rounded-full font-normal">
              {t('network.running')}
            </span>
          </h1>
          <p className="text-sm text-zinc-400 mt-0.5">{t('network.subtitle')}</p>
        </div>
        <button onClick={() => navigate('/contribute')}
          className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2">
          <span>💪</span> {t('network.join')}
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.globalNodes')}</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{loading ? '—' : totalNodes}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.onlineWorkers')}</div>
        </div>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.availableModels')}</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{loading ? '—' : totalModels}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.dedupModels')}</div>
        </div>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.contribTokens')}</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">
            {loading ? '—' : totalTokens > 999 ? (totalTokens / 1000).toFixed(1) + 'K' : totalTokens}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.thisPeriod')}</div>
        </div>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.activeUsers')}</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">
            {loading ? '—' : network?.summary?.active_users ?? 0}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.contributing')}</div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-zinc-400">{t('common.loading')}</div>
      ) : !network ? (
        <div className="text-sm text-zinc-400">{t('network.loadFailed')}</div>
      ) : (
        <div className="grid grid-cols-2 gap-5">

          {/* Left: Model list */}
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('network.modelsTitle')}</h2>
              <span className="text-xs text-zinc-400">{t('network.sortByNodes')}</span>
            </div>
            <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
              {modelStats.length === 0 ? (
                <div className="px-5 py-6 text-xs text-zinc-400">{t('network.noOnlineModels')}</div>
              ) : modelStats.map(m => {
                const isBusy = false;
                const dot    = m.nodes === 0 ? 'gray' : 'green';
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
                        <span className={`text-xs font-mono font-medium ${m.nodes === 0 ? 'text-zinc-400' : 'text-zinc-800 dark:text-zinc-200'}`}>
                          {m.name}
                        </span>
                        {size && (
                          <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{size}</span>
                        )}
                      </div>
                      {m.nodes > 0 && !avgS && (
                        <div className="text-xs text-green-600 mt-0.5">{t('network.idle')}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {m.nodes > 0 ? (
                        <>
                          <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t('network.nodes', { n: m.nodes })}</div>
                          <div className="text-xs mt-0.5 text-zinc-400">
                            {avgS ? t('network.avgSeconds', { s: avgS }) : '—'}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="text-xs text-zinc-400">{t('network.nodesZero')}</div>
                          <div className="text-xs text-zinc-400">{t('network.unavailable')}</div>
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
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('network.leaderboard')}</h2>
                <span className="text-xs text-zinc-400">{t('network.leaderboardHint')}</span>
              </div>
              <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
                {topWorkers.length === 0 ? (
                  <div className="px-5 py-6 text-xs text-zinc-400">{t('network.noContribData')}</div>
                ) : topWorkers.map((w, i) => {
                  const rank     = i + 1;
                  const rankColor = rank === 1 ? 'text-amber-600 dark:text-amber-400' : rank === 2 ? 'text-zinc-700 dark:text-zinc-300' : rank === 3 ? 'text-amber-700' : 'text-zinc-400';
                  const modelSummary = (w.models || []).slice(0, 3).join(' · ');
                  return (
                    <div key={w.worker_id || w.name} className="flex items-center gap-3 px-5 py-3">
                      <span className={`text-xs font-bold w-5 shrink-0 ${rankColor}`}>#{rank}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">{w.name}</div>
                        {modelSummary && (
                          <div className="text-xs text-zinc-400 mt-0.5 truncate">{modelSummary}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          {(w.period_tokens || 0).toLocaleString()} tok
                        </div>
                        <div className="text-xs text-zinc-400">{w.avg_latency_ms ?? 0} ms</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* My node status */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('network.myNode')}</h2>
                {myStats && myStats.active_workers > 0 ? (
                  <span className="text-xs bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 border border-green-300 dark:border-green-800/30 px-1.5 py-0.5 rounded-full">
                    {t('network.online')}
                  </span>
                ) : (
                  <span className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-400 border border-zinc-200 dark:border-zinc-700 px-1.5 py-0.5 rounded-full">
                    {t('network.offline')}
                  </span>
                )}
              </div>
              {myStats ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-zinc-100 dark:bg-zinc-800/50 rounded-lg p-3">
                      <div className="text-xs text-zinc-400">{t('network.activeNodes')}</div>
                      <div className="text-lg font-bold mt-0.5 text-zinc-900 dark:text-zinc-100">{myStats.active_workers ?? 0}</div>
                    </div>
                    <div className="bg-zinc-100 dark:bg-zinc-800/50 rounded-lg p-3">
                      <div className="text-xs text-zinc-400">{t('network.activeRequests')}</div>
                      <div className="text-lg font-bold mt-0.5 text-zinc-900 dark:text-zinc-100">{myStats.active_requests ?? 0}</div>
                    </div>
                    <div className="bg-zinc-100 dark:bg-zinc-800/50 rounded-lg p-3 col-span-2">
                      <div className="text-xs text-zinc-400">{t('network.contribRate')}</div>
                      <div className="text-lg font-bold mt-0.5 text-blue-600 dark:text-blue-400">
                        {myStats.contribute_req_per_min ?? 0}
                        <span className="text-xs font-normal text-zinc-400 ml-1">req/min</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => navigate('/contribute')}
                    className="flex items-center justify-center gap-2 w-full py-2 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 border border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600 rounded-lg transition-colors">
                    {t('network.manageContrib')}
                  </button>
                </>
              ) : (
                <p className="text-xs text-zinc-400">{t('network.loginRequired')}</p>
              )}
            </div>

            {/* All workers list */}
            {network.workers.length > 0 && (
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('network.workersTitle')}</h2>
                  <span className="text-xs text-zinc-400">{t('network.workersCount', { n: network.workers.length })}</span>
                </div>
                <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50 max-h-56 overflow-y-auto">
                  {network.workers.map(w => (
                    <div key={w.worker_id || w.name}
                      className="flex items-center gap-3 px-5 py-2.5">
                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">{w.name}</span>
                        <div className="text-xs text-zinc-400 truncate mt-0.5">
                          {(w.models || []).join(', ')}
                        </div>
                      </div>
                      <div className="text-right shrink-0 text-xs text-zinc-400">
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

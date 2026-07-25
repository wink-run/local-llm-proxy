import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getNetwork, getStats } from '../api/client';
import { modelStatsForIds, normalizeNetworkPayload } from '../lib/networkModelStats';
import { fetchServerCommunityModels } from '../lib/communityModels';
import { useLang } from '../store/lang';
import P2pWorldMap from '../components/P2pWorldMap';

/** 贡献 Token 大数展示（M/K） */
function fmtContribTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

// Extract param size from model name
function parseSize(name) {
  const m = name.match(/[:\-_](\d+(?:\.\d+)?)[bB]\b/);
  if (m) return m[1].replace(/\.0$/, '') + 'B';
  const m2 = name.match(/(\d+(?:\.\d+)?)[bB](?:[:\-_]|$)/);
  if (m2) return m2[1].replace(/\.0$/, '') + 'B';
  return null;
}

// 可用模型指示：实心点（无 ping）
function PingDot({ color = 'green' }) {
  const colors = {
    green:  'bg-green-500',
    amber:  'bg-amber-500',
    gray:   'bg-zinc-800',
  };
  const dot = colors[color] || colors.green;
  return <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />;
}

/**
 * 展示用被雇人数 = 真实 hire_count + [10,50] 稳定偏移（同一智能体刷新不变）。
 */
function displayHiredCount(agent) {
  const real = Math.max(0, Number(agent?.hire_count) || 0);
  const seed = `${agent?.id || ''}@${agent?.worker_id || ''}`;
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  const boost = 10 + (Math.abs(h) % 41); // 10..50
  return real + boost;
}

export default function Network() {
  const { t } = useLang();
  const navigate  = useNavigate();
  const [network,        setNetwork]        = useState(null);
  const [myStats,        setMyStats]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [circleModelMap, setCircleModelMap] = useState({});
  const [communityIds,   setCommunityIds]   = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [netRes, statsRes, communityRes] = await Promise.allSettled([
          getNetwork(), getStats(), fetchServerCommunityModels(),
        ]);
        if (cancelled) return;
        if (netRes.status === 'fulfilled') {
          const payload = netRes.value?.data ?? netRes.value;
          setNetwork(normalizeNetworkPayload(payload));
        }
        if (statsRes.status === 'fulfilled') setMyStats(statsRes.value?.data ?? null);
        if (communityRes.status === 'fulfilled') {
          const v = communityRes.value;
          setCommunityIds(Array.isArray(v?.ids) ? v.ids : []);
          setCircleModelMap(v?.circleMap && typeof v.circleMap === 'object' ? v.circleMap : {});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // 模型列表与 /v1/models 一致；节点数从 workers 聚合补充
  const modelStats = useMemo(() => {
    try {
      return modelStatsForIds(communityIds, network);
    } catch {
      return [];
    }
  }, [communityIds, network]);

  // Sort workers by tokens as contributor ranking proxy
  const topWorkers = useMemo(() => {
    const workers = Array.isArray(network?.workers) ? network.workers : [];
    return [...workers].sort((a, b) => (b.period_tokens || 0) - (a.period_tokens || 0)).slice(0, 5);
  }, [network]);

  const totalNodes  = network?.summary?.online_workers ?? 0;
  const totalModels = modelStats.length;
  const agentList   = Array.isArray(network?.available_agents) ? network.available_agents : [];
  const totalAgents = agentList.length;
  const totalTokens = network?.summary?.contrib_tokens
    ?? network?.workers?.reduce((s, w) => s + (w.period_tokens || 0), 0)
    ?? 0;

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
          className="text-xs bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2">
          <span>💪</span> {t('network.join')}
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.globalNodes')}</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{loading ? '—' : totalNodes}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.onlineWorkers')}</div>
        </div>
        <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.availableModels')}</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{loading ? '—' : totalModels}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.dedupModels')}</div>
        </div>
        <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.availableAgents')}</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">{loading ? '—' : totalAgents}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.availableAgentsHint')}</div>
        </div>
        <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.contribTokens')}</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">
            {loading ? '—' : fmtContribTokens(totalTokens)}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.thisPeriod')}</div>
        </div>
        <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.activeUsers')}</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">
            {loading ? '—' : network?.summary?.active_users ?? 0}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.contributing')}</div>
        </div>
      </div>

      {/* 全球节点地图 */}
      {!loading && network && (
        <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 overflow-hidden">
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('network.mapTitle')}</h2>
            <span className="text-xs text-zinc-400">{t('network.mapHint')}</span>
          </div>
          <P2pWorldMap
            workers={network.workers || []}
            labels={{
              idle: t('network.idle'),
              busy: t('network.busy'),
              agent: t('network.mapAgent'),
              country: code => t('network.countryCode', { code }),
              mapped: ({ mapped, total }) => t('network.mapMapped', { mapped, total }),
              unmapped: n => t('network.mapUnmapped', { n }),
            }}
          />
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-400">{t('common.loading')}</div>
      ) : !network ? (
        <div className="text-sm text-zinc-400">{t('network.loadFailed')}</div>
      ) : (
        <div className="grid grid-cols-2 gap-5">

          {/* Left: Model list + Agents list */}
          <div className="space-y-5">
          <div className="tb-table-shell rounded-2xl">
            <div className="tb-table-head px-5 py-3.5 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.modelsTitle')}</h2>
              <span className="tb-table-cell-meta">{t('network.sortByNodes')}</span>
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
                        {circleModelMap?.[m.name] && (
                          <span
                            title={circleModelMap[m.name]?.circle_name || '圈子'}
                            className="text-[10px] leading-none px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 cursor-default"
                          >⊙</span>
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

          {/* 可用智能体：公开在线名片 */}
          <div className="tb-table-shell rounded-2xl">
            <div className="tb-table-head px-5 py-3.5 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.agentsTitle')}</h2>
              <span className="tb-table-cell-meta">{t('network.agentsCount', { n: totalAgents })}</span>
            </div>
            <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50 max-h-80 overflow-y-auto">
              {agentList.length === 0 ? (
                <div className="px-5 py-6 text-xs text-zinc-400">{t('network.noOnlineAgents')}</div>
              ) : agentList.map((a) => {
                const title = a.display_name || a.name || a.id;
                const blurb = String(a.description || '').trim();
                const key = `${a.worker_id || ''}:${a.id}`;
                return (
                  <div key={key} className="flex items-start gap-3 px-5 py-3">
                    <PingDot color="green" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                          {title}
                        </span>
                        {a.runtime && (
                          <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">
                            {a.runtime}
                          </span>
                        )}
                      </div>
                      {blurb ? (
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-2 leading-relaxed">
                          {blurb}
                        </p>
                      ) : (
                        <p className="text-[11px] text-zinc-400 mt-0.5 italic">{t('network.agentNoDesc')}</p>
                      )}
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className="text-[10px] text-zinc-400 tabular-nums">
                        {t('network.hiredCount', { n: displayHiredCount(a) })}
                      </span>
                      <button
                        type="button"
                        onClick={() => navigate('/contribute')}
                        className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {t('network.hireOnContribute')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          </div>

          {/* Right column */}
          <div className="space-y-3">

            {/* Contributor ranking */}
            <div className="tb-table-shell rounded-2xl">
              <div className="tb-table-head px-5 py-3.5 flex items-center justify-between">
                <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.leaderboard')}</h2>
                <span className="tb-table-cell-meta">{t('network.leaderboardHint')}</span>
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
                          {fmtContribTokens(w.period_tokens || 0)} tok
                        </div>
                        <div className="text-xs text-zinc-400">{w.avg_latency_ms ?? 0} ms</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* My node status */}
            <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 space-y-3">
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
            {(network?.workers?.length ?? 0) > 0 && (
              <div className="tb-table-shell rounded-2xl">
                <div className="tb-table-head px-5 py-3.5 flex items-center justify-between">
                  <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.workersTitle')}</h2>
                  <span className="tb-table-cell-meta">{t('network.workersCount', { n: network.workers.length })}</span>
                </div>
                <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50 max-h-56 overflow-y-auto">
                  {network.workers.map(w => (
                    <div key={w.worker_id || w.name}
                      className="flex items-center gap-3 px-5 py-2.5">
                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                        {w.status === 'busy' ? (
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
                        ) : (
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">{w.name}</span>
                        <div className="text-xs text-zinc-400 truncate mt-0.5">
                          {(w.models || []).join(', ')}
                          {w.geo?.city ? ` · ${w.geo.city}` : (w.geo?.country ? ` · ${w.geo.country}` : '')}
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

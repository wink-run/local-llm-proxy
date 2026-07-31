import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getNetwork, getStats, browseCircles, applyJoinCircle } from '../api/client';
import { modelStatsForIds, normalizeNetworkPayload } from '../lib/networkModelStats';
import { fetchServerCommunityModels } from '../lib/communityModels';
import { useLang } from '../store/lang';
import P2pWorldMap from '../components/P2pWorldMap';
import TruncTip from '../components/TruncTip';

/** 贡献 Token 大数展示（M/K） */
function fmtContribTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

/** 模型/智能体条目的去重键 */
function offerItemKey(item) {
  if (typeof item === 'string') return item;
  return item?.display_name || item?.name || item?.id || '';
}

/**
 * 按分享者聚合供给排行：同用户多真实节点 / 多虚拟 Agent 合并为一条，
 * Token 与接单量累加，模型与智能体去重合并。
 */
function aggregateWorkersBySharer(workers) {
  const map = new Map();
  for (const w of workers || []) {
    const key = w.sharer || w.worker_id || w.name || '';
    if (!key) continue;
    const toks = Number(w.period_tokens) || 0;
    const jobs = Number(w.period_agent_jobs) || 0;
    const lat = Number(w.avg_latency_ms) || 0;
    const models = Array.isArray(w.models) ? w.models : [];
    const agents = Array.isArray(w.agents) ? w.agents : [];
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...w,
        period_tokens: toks,
        period_agent_jobs: jobs,
        models: [...models],
        agents: [...agents],
        agent_count: Number(w.agent_count) || agents.length || 0,
        _latSum: lat,
        _latN: lat > 0 ? 1 : 0,
        _nameToks: toks,
      });
      continue;
    }
    prev.period_tokens += toks;
    prev.period_agent_jobs += jobs;
    if (lat > 0) {
      prev._latSum += lat;
      prev._latN += 1;
    }
    prev.agent_count = (Number(prev.agent_count) || 0)
      + (Number(w.agent_count) || agents.length || 0);
    const modelKeys = new Set(prev.models.map(offerItemKey).filter(Boolean));
    for (const m of models) {
      const id = offerItemKey(m);
      if (id && !modelKeys.has(id)) {
        modelKeys.add(id);
        prev.models.push(m);
      }
    }
    const agentKeys = new Set(prev.agents.map(offerItemKey).filter(Boolean));
    for (const a of agents) {
      const id = offerItemKey(a);
      if (id && !agentKeys.has(id)) {
        agentKeys.add(id);
        prev.agents.push(a);
      }
    }
    // 展示名：避开 *.local 主机名；否则取用量更高的
    const candHost = /\.local$/i.test(String(w.name || ''));
    const prevHost = /\.local$/i.test(String(prev.name || ''));
    if (prevHost && !candHost) {
      prev.name = w.name;
      prev._nameToks = toks;
    } else if (!candHost && toks > (Number(prev._nameToks) || 0)) {
      prev.name = w.name;
      prev._nameToks = toks;
    } else if (candHost && prevHost && toks > (Number(prev._nameToks) || 0)) {
      prev.name = w.name;
      prev._nameToks = toks;
    }
  }
  return [...map.values()].map((r) => ({
    ...r,
    avg_latency_ms: r._latN ? Math.round(r._latSum / r._latN) : (Number(r.avg_latency_ms) || 0),
  }));
}

/** 节点上架：完整列表（悬浮用）与短摘要（列表展示） */
function workerOfferTexts(w, t) {
  const models = (Array.isArray(w?.models) ? w.models : [])
    .map((m) => (typeof m === 'string' ? m : m?.name))
    .filter(Boolean);
  const agents = Array.isArray(w?.agents)
    ? w.agents.map((a) => (typeof a === 'string' ? a : a?.display_name || a?.name || a?.id)).filter(Boolean)
    : [];
  const fullParts = [...models, ...agents];
  if (!fullParts.length && (w?.agent_count || 0) > 0) {
    const only = t('network.agentOnly', { n: w.agent_count });
    return { short: only, full: only };
  }
  if (!fullParts.length) {
    const empty = t('network.noOffers');
    return { short: empty, full: empty };
  }
  const full = fullParts.join(' · ');
  const shortParts = [...models.slice(0, 3), ...agents.slice(0, 3)];
  const more = Math.max(0, fullParts.length - shortParts.length);
  const short = more > 0 ? `${shortParts.join(' · ')} · +${more}` : shortParts.join(' · ');
  return { short, full };
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
 * 展示用被雇人数 = 真实 hire_count + [10,50] 稳定偏移（同一聚合键刷新不变）。
 */
function displayHiredCount(realCount, seedKey) {
  const real = Math.max(0, Number(realCount) || 0);
  const seed = String(seedKey || '');
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  const boost = 10 + (Math.abs(h) % 41); // 10..50
  return real + boost;
}

/** 拆分智能体名称与所有者（去掉「昵称的」历史前缀） */
function parseAgentDisplay(a) {
  let owner = String(a?.owner_nickname || '').trim();
  const raw = String(a?.display_name || a?.name || '').trim();
  let name = raw;
  if (owner) {
    const prefix = `${owner}的`;
    if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  } else {
    const m = raw.match(/^(.+?)的(.+)$/);
    if (m && m[2]) {
      owner = m[1].trim();
      name = m[2].trim();
    }
  }
  return {
    name: name || String(a?.name || '').trim() || a?.id || '智能体',
    owner,
  };
}

/**
 * 按智能体名聚合（同模型列表：多节点 → 多提供者）。
 * providerCount = 不同所有者数（无所有者时按 worker 计）。
 */
function aggregateAgentsByName(list) {
  const map = new Map();
  for (const a of list || []) {
    const { name, owner } = parseAgentDisplay(a);
    let g = map.get(name);
    if (!g) {
      g = {
        name,
        owners: new Set(),
        providerKeys: new Set(),
        hire_count: 0,
      };
      map.set(name, g);
    }
    if (owner) g.owners.add(owner);
    // 无昵称时用 worker_id 区分提供者，避免多人被压成 1
    g.providerKeys.add(owner || String(a.worker_id || a.id || ''));
    g.hire_count += Math.max(0, Number(a.hire_count) || 0);
  }
  return [...map.values()]
    .map((g) => ({
      name: g.name,
      providers: g.providerKeys.size || 1,
      hire_count: g.hire_count,
      // 完整所有者列表供悬浮；展示侧仍只显示「n 人提供」
      ownersFull: [...g.owners],
    }))
    .sort((a, b) => b.providers - a.providers || a.name.localeCompare(b.name, 'zh'));
}

export default function Network() {
  const { t } = useLang();
  const navigate  = useNavigate();
  const [network,        setNetwork]        = useState(null);
  const [myStats,        setMyStats]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [circleModelMap, setCircleModelMap] = useState({});
  const [communityIds,   setCommunityIds]   = useState([]);
  const [circles,        setCircles]        = useState([]);
  const [circleBusyId,   setCircleBusyId]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [netRes, statsRes, communityRes, circlesRes] = await Promise.allSettled([
          getNetwork(), getStats(), fetchServerCommunityModels(), browseCircles(),
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
        if (circlesRes.status === 'fulfilled') {
          const list = circlesRes.value?.data?.circles;
          setCircles(Array.isArray(list) ? list : []);
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

  // 排行：先按用户聚合，再按 Token / 接单量排序（避免同用户多节点占满榜单）
  const topWorkers = useMemo(() => {
    return aggregateWorkersBySharer(network?.workers)
      .sort((a, b) => {
        const tok = (b.period_tokens || 0) - (a.period_tokens || 0);
        if (tok !== 0) return tok;
        return (b.period_agent_jobs || 0) - (a.period_agent_jobs || 0);
      })
      .slice(0, 20);
  }, [network]);

  const totalNodes  = network?.summary?.online_workers ?? 0;
  const totalModels = modelStats.length;
  // 按智能体名聚合：同名多人提供 → 一行 +「n 人提供」
  const agentGroups = useMemo(
    () => aggregateAgentsByName(network?.available_agents),
    [network?.available_agents],
  );
  const totalAgents = agentGroups.length;
  const totalTokens = network?.summary?.contrib_tokens
    ?? network?.workers?.reduce((s, w) => s + (w.period_tokens || 0), 0)
    ?? 0;

  /** 已入圈 → 主页；否则确认后申请加入 */
  async function onCircleClick(c) {
    if (!c?.id) return;
    if (c.join_status === 'member') {
      navigate(`/circles/${c.id}`);
      return;
    }
    if (c.join_status === 'pending') {
      window.alert(t('network.circlePending'));
      return;
    }
    if (c.full) {
      window.alert(t('circles.browse.full'));
      return;
    }
    const name = c.name || '';
    if (!window.confirm(t('network.circleApplyConfirm').replace('{name}', name))) return;
    setCircleBusyId(c.id);
    try {
      const r = await applyJoinCircle(c.id);
      const d = r?.data || {};
      if (d.already_member) {
        setCircles((prev) => prev.map((x) => (x.id === c.id ? { ...x, join_status: 'member' } : x)));
        navigate(`/circles/${c.id}`);
        return;
      }
      if (d.full) {
        window.alert(t('circles.browse.full'));
        setCircles((prev) => prev.map((x) => (x.id === c.id ? { ...x, full: true } : x)));
        return;
      }
      window.alert(t('network.circleApplySent').replace('{name}', name));
      setCircles((prev) => prev.map((x) => (x.id === c.id ? { ...x, join_status: 'pending' } : x)));
    } catch (err) {
      window.alert(err?.response?.data?.detail || t('circles.browse.applyFailed'));
    } finally {
      setCircleBusyId(null);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="px-4 py-4 space-y-4">

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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="tb-soft-card rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.globalNodes')}</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{loading ? '—' : totalNodes}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.onlineWorkers')}</div>
        </div>
        <div className="tb-soft-card rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.availableModels')}</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{loading ? '—' : totalModels}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.dedupModels')}</div>
        </div>
        <div className="tb-soft-card rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.availableAgents')}</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">{loading ? '—' : totalAgents}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.availableAgentsHint')}</div>
        </div>
        <div className="tb-soft-card rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.circlesStat')}</div>
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400 mt-1">
            {loading ? '—' : (network?.summary?.circle_count ?? circles.length)}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.circlesStatHint')}</div>
        </div>
        <div className="tb-soft-card rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.contribTokens')}</div>
          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">
            {loading ? '—' : fmtContribTokens(totalTokens)}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.thisPeriod')}</div>
        </div>
        <div className="tb-soft-card rounded-xl p-3">
          <div className="text-xs text-zinc-400">{t('network.activeUsers')}</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">
            {loading ? '—' : network?.summary?.active_users ?? 0}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">{t('network.contributing')}</div>
        </div>
      </div>

      {/* 全球节点地图 */}
      {!loading && network && (
        <div className="tb-soft-card rounded-2xl p-4 overflow-hidden">
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
          <div className="space-y-2">
            <div className="px-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.modelsTitle')}</h2>
              <span className="tb-table-cell-meta">{t('network.sortByNodes')}</span>
            </div>
            <div className="space-y-2">
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
                    className={`tb-soft-tile flex items-center gap-3 px-4 py-3 rounded-xl ${m.nodes === 0 ? 'opacity-50' : ''}`}
                  >
                    <PingDot color={dot} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <TruncTip
                          as="span"
                          title={m.name}
                          className={`text-xs font-mono font-medium min-w-0 ${m.nodes === 0 ? 'text-zinc-400' : 'text-zinc-800 dark:text-zinc-200'}`}
                        >
                          {m.name}
                        </TruncTip>
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
          <div className="space-y-2">
            <div className="px-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.agentsTitle')}</h2>
              <span className="tb-table-cell-meta">{t('network.agentsCount', { n: totalAgents })}</span>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {agentGroups.length === 0 ? (
                <div className="px-5 py-6 text-xs text-zinc-400">{t('network.noOnlineAgents')}</div>
              ) : agentGroups.map((g) => {
                const ownersHint = g.ownersFull.length
                  ? g.ownersFull.join('、')
                  : '';
                return (
                  <div key={g.name} className="tb-soft-tile flex items-center gap-3 px-4 py-3 rounded-xl">
                    <PingDot color="green" />
                    <div className="flex-1 min-w-0">
                      {/* 聚合行不展示运行时/简介：不同提供者可能不一致 */}
                      <TruncTip
                        as="span"
                        title={g.name}
                        className="text-xs font-mono font-medium text-zinc-800 dark:text-zinc-200 block"
                      >
                        {g.name}
                      </TruncTip>
                    </div>
                    <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                      {/* 对齐模型「n 节点」：同名智能体的提供者数量；悬浮看提供者样例 */}
                      <TruncTip
                        className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
                        title={ownersHint || t('network.agentProviders', { n: g.providers })}
                      >
                        {t('network.agentProviders', { n: g.providers })}
                      </TruncTip>
                      <div className="text-[10px] text-zinc-400 tabular-nums">
                        {t('network.hiredCount', { n: displayHiredCount(g.hire_count, g.name) })}
                      </div>
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

          {/* 公开圈子列表 */}
          <div className="space-y-2">
            <div className="px-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.circlesTitle')}</h2>
              <button
                type="button"
                onClick={() => navigate('/circles/browse')}
                className="tb-table-cell-meta text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('network.circlesMore')}
              </button>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {circles.length === 0 ? (
                <div className="px-5 py-6 text-xs text-zinc-400">{t('network.noCircles')}</div>
              ) : circles.slice(0, 20).map((c) => {
                const isMember = c.join_status === 'member';
                const isPending = c.join_status === 'pending';
                const desc = String(c.description || '').trim();
                const busy = circleBusyId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={busy}
                    onClick={() => onCircleClick(c)}
                    className="tb-soft-tile w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors disabled:opacity-60"
                  >
                    <span className="w-7 h-7 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 text-xs font-semibold flex items-center justify-center shrink-0">
                      {(c.name || '?')[0]}
                    </span>
                    <div className="flex-1 min-w-0">
                      <TruncTip
                        as="span"
                        title={c.name}
                        className="text-xs font-medium text-zinc-800 dark:text-zinc-200 block"
                      >
                        {c.name}
                      </TruncTip>
                      <TruncTip
                        className="text-xs text-zinc-400 mt-0.5"
                        title={desc || t('network.circleNoDesc')}
                      >
                        {desc || t('network.circleNoDesc')}
                      </TruncTip>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        {t('circles.members', { n: c.member_count ?? 0 })}
                      </div>
                      <div className="text-[10px] text-zinc-400 mt-0.5">
                        {busy
                          ? t('circles.browse.applying')
                          : isMember
                            ? t('network.circleJoined')
                            : isPending
                              ? t('circles.browse.pending')
                              : c.full
                                ? t('circles.browse.full')
                                : t('network.circleOpen')}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          </div>

          {/* Right column */}
          <div className="space-y-3">

            {/* Contributor ranking */}
            <div className="space-y-2">
              <div className="px-1 flex items-center justify-between">
                <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.leaderboard')}</h2>
                <span className="tb-table-cell-meta">{t('network.leaderboardHint')}</span>
              </div>
              <div className="space-y-2 max-h-[28rem] overflow-y-auto">
                {topWorkers.length === 0 ? (
                  <div className="px-5 py-6 text-xs text-zinc-400">{t('network.noContribData')}</div>
                ) : topWorkers.map((w, i) => {
                  const rank     = i + 1;
                  const rankColor = rank === 1 ? 'text-amber-600 dark:text-amber-400' : rank === 2 ? 'text-zinc-700 dark:text-zinc-300' : rank === 3 ? 'text-amber-700' : 'text-zinc-400';
                  const { short: offerShort, full: offerFull } = workerOfferTexts(w, t);
                  const jobs = Number(w.period_agent_jobs) || 0;
                  const toks = Number(w.period_tokens) || 0;
                  return (
                    <div key={w.sharer || w.worker_id || w.name} className="tb-soft-tile flex items-center gap-3 px-4 py-3 rounded-xl">
                      <span className={`text-xs font-bold w-5 shrink-0 ${rankColor}`}>#{rank}</span>
                      <div className="flex-1 min-w-0">
                        <TruncTip className="text-xs font-medium text-zinc-700 dark:text-zinc-300" title={w.name}>
                          {w.name}
                        </TruncTip>
                        <TruncTip className="text-xs text-zinc-400 mt-0.5" title={offerFull}>
                          {offerShort}
                        </TruncTip>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          {toks > 0 || jobs === 0
                            ? `${fmtContribTokens(toks)} tok`
                            : t('network.agentJobs', { n: jobs })}
                        </div>
                        <div className="text-xs text-zinc-400">
                          {toks > 0 && jobs > 0
                            ? t('network.agentJobs', { n: jobs })
                            : `${w.avg_latency_ms ?? 0} ms`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* My node status */}
            <div className="tb-soft-card rounded-2xl p-4 space-y-3">
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
                    <div className="tb-soft-card rounded-lg p-3">
                      <div className="text-xs text-zinc-400">{t('network.activeNodes')}</div>
                      <div className="text-lg font-bold mt-0.5 text-zinc-900 dark:text-zinc-100">{myStats.active_workers ?? 0}</div>
                    </div>
                    <div className="tb-soft-card rounded-lg p-3">
                      <div className="text-xs text-zinc-400">{t('network.activeRequests')}</div>
                      <div className="text-lg font-bold mt-0.5 text-zinc-900 dark:text-zinc-100">{myStats.active_requests ?? 0}</div>
                    </div>
                    <div className="tb-soft-card rounded-lg p-3 col-span-2">
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
              <div className="space-y-2">
                <div className="px-1 flex items-center justify-between">
                  <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{t('network.workersTitle')}</h2>
                  <span className="tb-table-cell-meta">{t('network.workersCount', { n: network.workers.length })}</span>
                </div>
                <div className="space-y-2 max-h-56 overflow-y-auto">
                  {network.workers.map(w => {
                    const { short: offerShort, full: offerFull } = workerOfferTexts(w, t);
                    const geo = w.geo?.city || w.geo?.country || '';
                    const lineShort = geo ? `${offerShort} · ${geo}` : offerShort;
                    const lineFull = geo ? `${offerFull} · ${geo}` : offerFull;
                    return (
                    <div key={w.worker_id || w.name}
                      className="tb-soft-tile flex items-center gap-3 px-4 py-2.5 rounded-xl">
                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                        {w.status === 'busy' ? (
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
                        ) : w.has_agents && !(w.models || []).length ? (
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-400" title={t('network.mapAgent')} />
                        ) : (
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <TruncTip as="span" className="text-xs font-medium text-zinc-700 dark:text-zinc-300" title={w.name}>
                          {w.name}
                        </TruncTip>
                        <TruncTip className="text-xs text-zinc-400 mt-0.5" title={lineFull}>
                          {lineShort}
                        </TruncTip>
                      </div>
                      <div className="text-right shrink-0 text-xs text-zinc-400">
                        <div>{w.avg_latency_ms ?? 0} ms</div>
                        <div>{Math.round(w.online_mins ?? 0)} min</div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';

const RANGES = ['今日', '7 天', '30 天'];
const RANGE_DAYS = { '今日': 1, '7 天': 7, '30 天': 30 };

const PAID_PROVIDERS = ['openai', 'anthropic-paid', 'openrouter', 'anthropic'];
const P2P_PROVIDERS  = ['tokenbank-p2p'];

const fmtN    = n => n >= 1_000_000 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);
const fmtCost = n => (n != null && n > 0) ? ('$' + n.toFixed(n < 0.01 ? 4 : 3)) : '—';

function linkMethodLabel(method) {
  return method === 'manual' ? 'API' : '应用';
}

const APP_USAGE_COLORS = [
  'bg-indigo-500', 'bg-purple-500', 'bg-violet-500', 'bg-pink-500',
  'bg-amber-500', 'bg-emerald-500', 'bg-blue-500', 'bg-teal-500',
];

/** 来源构成：网关实时 vs 会话补录 */
function SourceMixBar({ proxy, session, total, className = 'h-2' }) {
  const t = total || proxy + session || 1;
  const pPct = Math.round((proxy / t) * 100);
  const sPct = Math.max(0, 100 - pPct);
  if (!proxy && !session) {
    return <div className={`flex-1 bg-gray-100 dark:bg-gray-800 rounded-full ${className}`} />;
  }
  return (
    <div className={`flex-1 flex rounded-full overflow-hidden ${className}`} title={`网关 ${proxy} · 会话 ${session}`}>
      {pPct > 0 && <div className="bg-blue-500 h-full" style={{ width: `${pPct}%` }} />}
      {sPct > 0 && <div className="bg-violet-400/80 h-full" style={{ width: `${sPct}%` }} />}
    </div>
  );
}

/** 应用占比总览条（参考 tokentelemetry agent share） */
function AppShareStrip({ rows, metric = 'tokens' }) {
  if (!rows?.length) return null;
  const total = rows.reduce((s, r) => s + (r[metric] || 0), 0) || 1;
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800">
        {rows.map((r, i) => {
          const v = r[metric] || 0;
          if (!v) return null;
          const pct = Math.max((v / total) * 100, 0.5);
          return (
            <div
              key={r.id}
              className={`h-full ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`}
              style={{ width: `${pct}%` }}
              title={`${r.name} · ${fmtN(v)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {rows.slice(0, 8).map((r, i) => (
          <span key={r.id} className="inline-flex items-center gap-1.5 text-[10px] text-gray-500">
            <span className={`w-2 h-2 rounded-full shrink-0 ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`} />
            <span className="truncate max-w-[8rem]">{r.icon} {r.name}</span>
            <span className="text-gray-400">{Math.round(((r[metric] || 0) / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function AppUsageSection({ rows, range, loading, sortBy, onSortBy }) {
  const maxCalls = Math.max(...(rows || []).map(r => r.calls), 1);
  const maxTokens = Math.max(...(rows || []).map(r => r.tokens), 1);
  const sorted = [...(rows || [])].sort((a, b) =>
    sortBy === 'tokens' ? (b.tokens - a.tokens) : (b.calls - a.calls));

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">应用用量</h2>
            <p className="text-xs text-gray-500 mt-0.5">与网关应用一致 · 网关实时 + 会话补录</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{range}</span>
            <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
              {[['calls', '按请求'], ['tokens', '按 Token']].map(([k, label]) => (
                <button key={k} type="button" onClick={() => onSortBy(k)}
                  className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                    sortBy === k ? 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 shadow-sm' : 'text-gray-500'
                  }`}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        {!loading && sorted.length > 0 && <AppShareStrip rows={sorted} metric={sortBy} />}
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" />网关实时</span>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-400" />会话补录</span>
        </div>
      </div>
      {loading ? (
        <div className="px-5 py-8 text-xs text-gray-600 text-center">加载中…</div>
      ) : sorted.length === 0 ? (
        <div className="px-5 py-8 text-xs text-gray-600 text-center">
          暂无用量。请先在「网关」纳管应用，或等待会话补录完成。
        </div>
      ) : (
        <>
          <div className="hidden sm:grid grid-cols-[minmax(0,1.4fr)_4.5rem_4.5rem_4rem_minmax(0,1fr)] gap-3 px-5 py-2 text-[10px] font-medium text-gray-400 uppercase tracking-wide border-b border-gray-100 dark:border-gray-800">
            <span>应用</span>
            <span className="text-right">请求</span>
            <span className="text-right">Token</span>
            <span className="text-right">费用</span>
            <span>来源构成</span>
          </div>
          <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
            {sorted.map((r, i) => (
              <div key={r.id} className="px-5 py-3.5 hover:bg-gray-50/50 dark:hover:bg-gray-800/20">
                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1.4fr)_4.5rem_4.5rem_4rem_minmax(0,1fr)] gap-3 items-center">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-1 h-8 rounded-full shrink-0 ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`} />
                    <span className="text-base shrink-0">{r.icon}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{r.name}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {linkMethodLabel(r.link_method)}
                        {r.proxyCalls > 0 && r.sessionCalls > 0 ? ' · 混合来源' : r.proxyCalls > 0 ? ' · 网关' : ' · 会话'}
                      </div>
                    </div>
                  </div>
                  <div className="sm:text-right">
                    <div className="text-sm font-semibold tabular-nums">{r.calls.toLocaleString()}</div>
                    <div className="mt-1 h-1 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden hidden sm:block">
                      <div className={`h-full rounded-full ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`}
                        style={{ width: `${Math.round(r.calls / maxCalls * 100)}%` }} />
                    </div>
                  </div>
                  <div className="sm:text-right">
                    <div className="text-sm font-semibold tabular-nums text-purple-600 dark:text-purple-400">{fmtN(r.tokens)}</div>
                    <div className="mt-1 h-1 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden hidden sm:block">
                      <div className="h-full rounded-full bg-purple-500"
                        style={{ width: `${Math.round((r.tokens || 0) / maxTokens * 100)}%` }} />
                    </div>
                  </div>
                  <div className="sm:text-right text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtCost(r.cost)}</div>
                  <SourceMixBar
                    proxy={sortBy === 'tokens' ? r.proxyTokens : r.proxyCalls}
                    session={sortBy === 'tokens' ? r.sessionTokens : r.sessionCalls}
                    total={sortBy === 'tokens' ? r.tokens : r.calls}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function tierFromProvider(id = '') {
  if (P2P_PROVIDERS.includes(id))  return 'p2p';
  if (PAID_PROVIDERS.includes(id)) return 'paid';
  return 'free';
}

function TierDonut({ byProvider = {} }) {
  let free = 0, p2p = 0, paid = 0, total = 0;
  for (const [id, v] of Object.entries(byProvider)) {
    const t = v.tier || tierFromProvider(id);
    const n = v.calls || 0;
    if (t === 'free') free += n;
    else if (t === 'p2p') p2p += n;
    else paid += n;
    total += n;
  }
  if (!total) return (
    <div className="flex items-center justify-center h-full text-xs text-gray-600">无数据</div>
  );

  const r = 36, circ = 2 * Math.PI * r;
  const fPct = free / total, pPct = p2p / total, aPct = paid / total;
  const fLen = fPct * circ, p2pLen = pPct * circ, aLen = aPct * circ;
  const fOff = circ * 0.25;
  const p2pOff = fOff - fLen;
  const aOff = p2pOff - p2pLen;

  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0">
        <svg width="100" height="100" viewBox="0 0 100 100" className="-rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#1f2937" strokeWidth="12"/>
          {fLen > 0 && <circle cx="50" cy="50" r={r} fill="none" stroke="#22c55e" strokeWidth="12"
            strokeDasharray={`${fLen} ${circ}`} strokeDashoffset={fOff}/>}
          {p2pLen > 0 && <circle cx="50" cy="50" r={r} fill="none" stroke="#3b82f6" strokeWidth="12"
            strokeDasharray={`${p2pLen} ${circ}`} strokeDashoffset={p2pOff}/>}
          {aLen > 0 && <circle cx="50" cy="50" r={r} fill="none" stroke="#f59e0b" strokeWidth="12"
            strokeDasharray={`${aLen} ${circ}`} strokeDashoffset={aOff}/>}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-base font-bold text-green-600 dark:text-green-400">{Math.round(fPct * 100)}%</div>
          <div className="text-[9px] text-gray-600">免费</div>
        </div>
      </div>
      <div className="space-y-2.5 flex-1">
        {[
          { color: 'bg-green-500', label: '免费层', count: free },
          { color: 'bg-blue-500',  label: 'P2P 层',  count: p2p  },
          { color: 'bg-amber-500', label: '付费层', count: paid  },
        ].map(row => (
          <div key={row.label} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${row.color} shrink-0`}/>
              <span className="text-xs text-gray-700 dark:text-gray-300">{row.label}</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{row.count}</div>
              <div className="text-[10px] text-gray-600">{total ? Math.round(row.count / total * 100) : 0}%</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendBars({ data = [] }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(...data, 1);
  const H = 96;
  return (
    <div className="space-y-1">
      <div className="relative flex items-end gap-1 h-24">
        {data.map((v, i) => {
          const px = Math.max(Math.round((v / max) * H), v > 0 ? 4 : 2);
          const now = new Date().getHours();
          return (
            <div key={i} className="flex-1 cursor-default relative"
              onMouseEnter={e => setTip({ i, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setTip(null)}>
              {tip?.i === i && (
                <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-10
                  bg-gray-800 dark:bg-gray-700 text-white text-[10px] rounded px-1.5 py-0.5
                  whitespace-nowrap pointer-events-none shadow">
                  {i}:00 · {v} 次
                </div>
              )}
              <div className={`w-full rounded-sm transition-all duration-300 ${i === now ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-400 dark:hover:bg-gray-500'}`}
                style={{ height: `${px}px` }} />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between px-0.5">
        {['0h','6h','12h','18h','24h'].map(l => (
          <span key={l} className="text-[9px] text-gray-700">{l}</span>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange]         = useState('今日');
  const [localData, setLocalData] = useState(null);
  const [appsUsage, setAppsUsage] = useState([]);
  const [usageSort, setUsageSort] = useState('calls');
  const [gwStatus, setGwStatus]   = useState(null);
  const [loading, setLoading]     = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const days = RANGE_DAYS[range];
      let data;
      if (window.electronAPI?.localStats) {
        data = await window.electronAPI.localStats.query(days);
        if (window.electronAPI.localStats.appsUsage) {
          const usage = await window.electronAPI.localStats.appsUsage(days);
          setAppsUsage(usage || []);
        } else {
          setAppsUsage([]);
        }
      } else {
        const r = await fetch(`/api/local-stats?days=${days}`);
        if (!r.ok) throw new Error(`local-stats ${r.status}`);
        data = await r.json();
        setAppsUsage([]);
      }
      setLocalData(data);

      const fetchStatus = window.electronAPI?.gateway
        ? () => window.electronAPI.gateway.status().then(setGwStatus).catch(() => {})
        : () => fetch('/api/gateway/status').then(r => r.json()).then(setGwStatus).catch(() => {});
      fetchStatus();
    } catch (e) {
      console.error('dashboard load', e);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const totalCalls  = localData?.total_calls  ?? 0;
  const totalTokens = localData?.total_tokens ?? 0;
  const totalCost   = localData?.total_cost   ?? 0;

  const freeCalls  = localData?.tiers?.free  ?? 0;
  const p2pCalls   = localData?.tiers?.p2p   ?? 0;
  const paidCalls  = localData?.tiers?.paid  ?? 0;
  const freeRatio  = totalCalls > 0 ? Math.round(freeCalls / totalCalls * 100) : 0;

  const trendData  = localData?.hourly ?? Array(24).fill(0);
  const byProvider = Object.fromEntries(
    (localData?.providers ?? []).map(p => [p.id, { calls: p.calls, tier: p.tier }])
  );

  const modelStats    = localData?.models ?? [];
  const maxModel      = modelStats[0]?.calls || 1;
  const modelByTokens = [...modelStats].filter(m => m.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const maxModelTokens = modelByTokens[0]?.tokens || 1;
  const modelByCost   = [...modelStats].filter(m => (m.cost_usd || 0) > 0).sort((a, b) => b.cost_usd - a.cost_usd);
  const maxModelCost  = modelByCost[0]?.cost_usd || 1;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-screen">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">盘点</h1>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-sm text-gray-500">按网关应用汇总用量与费用</p>
            <span className="flex items-center gap-1 text-xs text-gray-500 border border-gray-200 dark:border-gray-700 rounded-full px-2 py-0.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${gwStatus?.running !== false ? 'bg-green-500' : 'bg-gray-400'}`}/>
              {window.electronAPI ? '💻 桌面版' : '🖥 命令行版'}
              {gwStatus?.port ? ` · :${gwStatus.port}` : ''}
            </span>
          </div>
        </div>
        <div className="flex gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-1">
          {RANGES.map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                range === r ? 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 font-medium' : 'text-gray-500 hover:text-gray-700 dark:text-gray-300'
              }`}>{r}</button>
          ))}
        </div>
      </div>

      {/* Summary cards — 5列 */}
      <div className="grid grid-cols-5 gap-3">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">总请求数</div>
          <div className="text-2xl font-bold mt-1">{totalCalls}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{range} 本设备全部请求</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">免费命中率</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{freeRatio}%</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{freeCalls} 免费 · {p2pCalls} P2P · {paidCalls} 付费</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">Token 消耗</div>
          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400 mt-1">{fmtN(totalTokens)}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{range} 合计</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">付费调用</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">{paidCalls + p2pCalls}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{paidCalls} 付费层 · {p2pCalls} P2P 层</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">估算费用</div>
          <div className={`text-2xl font-bold mt-1 ${totalCost > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}`}>
            {fmtCost(totalCost)}
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">API 刊例价估算；订阅接入非实际账单</div>
        </div>
      </div>

      {/* Row: tier donut + trend bars */}
      <div className="grid grid-cols-5 gap-4">
        <div className="col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 flex flex-col gap-4">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">路由层分布</div>
          <TierDonut byProvider={byProvider} />
        </div>
        <div className="col-span-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">今日请求趋势</div>
          <TrendBars data={trendData} />
        </div>
      </div>

      <AppUsageSection
        rows={appsUsage}
        range={range}
        loading={loading}
        sortBy={usageSort}
        onSortBy={setUsageSort}
      />

      {/* Model rankings — 3 columns */}
      <div className="grid grid-cols-3 gap-4">
        {/* Call count */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">模型调用排行</div>
          {modelStats.length === 0 ? (
            <p className="text-xs text-gray-600">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {modelStats.map(m => (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate max-w-[140px]" title={m.model}>{m.model}</span>
                    <span className="text-xs text-gray-600 dark:text-gray-400 shrink-0 ml-2">{m.calls} 次</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500 bg-green-500"
                      style={{ width: `${Math.round(m.calls / maxModel * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Token consumption */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">模型 Token 消耗排行</div>
          {modelByTokens.length === 0 ? (
            <p className="text-xs text-gray-600">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {modelByTokens.map(m => (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate max-w-[140px]" title={m.model}>{m.model}</span>
                    <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0 ml-2">{fmtN(m.tokens)} tok</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500 bg-purple-500"
                      style={{ width: `${Math.round((m.tokens||0) / maxModelTokens * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cost ranking */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">模型费用排行</div>
          {modelByCost.length === 0 ? (
            <p className="text-xs text-gray-600 dark:text-gray-500">暂无费用数据（仅含 API Key 调用）</p>
          ) : (
            <div className="space-y-3">
              {modelByCost.map(m => (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate max-w-[140px]" title={m.model}>{m.model}</span>
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 shrink-0 ml-2">{fmtCost(m.cost_usd)}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500 bg-emerald-500"
                      style={{ width: `${Math.round((m.cost_usd||0) / maxModelCost * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

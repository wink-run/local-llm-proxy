import { useState, useEffect, useCallback } from 'react';
import { getDashboardStats, getModelStats, listKeys, deleteKey } from '../api/client';

const RANGES = ['今日', '7 天', '30 天'];
const RANGE_DAYS = { '今日': 1, '7 天': 7, '30 天': 30 };

// Provider → tier mapping (same logic as Gateway)
const PAID_PROVIDERS = ['openai', 'anthropic-paid', 'openrouter', 'anthropic'];
const P2P_PROVIDERS  = ['tokenbank-p2p'];

function tierFromProvider(id = '') {
  if (P2P_PROVIDERS.includes(id))  return 'p2p';
  if (PAID_PROVIDERS.includes(id)) return 'paid';
  return 'free';
}

function TierDonut({ byProvider = {} }) {
  let free = 0, p2p = 0, paid = 0, total = 0;
  for (const [id, v] of Object.entries(byProvider)) {
    // Use stored tier if available (set by gateway at record time), else infer from id
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

  const r = 36, circ = 2 * Math.PI * r; // 226.2
  const fPct = free / total, pPct = p2p / total, aPct = paid / total;
  // offsets: start from top (-90deg = offset = circ/4)
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
  const max = Math.max(...data, 1);
  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1 h-24">
        {data.map((v, i) => {
          const h = Math.max(Math.round((v / max) * 100), v > 0 ? 4 : 2);
          const now = new Date().getHours();
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end group cursor-default" title={`${i}:00 — ${v} 次`}>
              <div
                className={`w-full rounded-sm transition-all duration-300 ${i === now ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700 group-hover:bg-gray-500'}`}
                style={{ height: `${h}%` }}
              />
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
  const [keyStats, setKeyStats]   = useState([]);
  const [modelStats, setModelStats] = useState([]);
  const [hourly, setHourly]       = useState(Array(24).fill(0));
  const [gatewayStats, setGatewayStats] = useState(null);
  const [gwStatus, setGwStatus]   = useState(null);
  const [loading, setLoading]     = useState(true);

  const days = RANGE_DAYS[range];

  const fetchGateway = useCallback(() => {
    if (window.electronAPI?.gateway) {
      window.electronAPI.gateway.getDailyStats().then(setGatewayStats).catch(() => {});
      window.electronAPI.gateway.status().then(setGwStatus).catch(() => {});
    } else {
      fetch('/api/gateway/status').then(r => r.json()).then(setGwStatus).catch(() => {});
      fetch('/api/gateway/stats').then(r => r.json()).then(setGatewayStats).catch(() => {});
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    fetchGateway(); // refresh gateway stats (hourly trend, tier counts) on every load
    try {
      const [dashRes, modelRes] = await Promise.all([
        getDashboardStats(days),
        getModelStats(days),
      ]);
      setKeyStats(dashRes.data?.stats || []);
      setModelStats(modelRes.data?.models || []);
      setHourly(modelRes.data?.hourly || Array(24).fill(0));
    } catch (e) {
      console.error('dashboard load', e);
    } finally {
      setLoading(false);
    }
  }, [days, fetchGateway]);

  useEffect(() => {
    load();
    // Poll gateway stats every 15s so trend chart and tier counts stay current
    const id = setInterval(fetchGateway, 15_000);
    return () => clearInterval(id);
  }, [load, fetchGateway]);

const handleDeleteKey = async (keyId) => {
    if (!confirm('删除此 API Key？')) return;
    try {
      await deleteKey(keyId);
      await load();
    } catch (e) {
      alert('删除失败');
    }
  };

  const isToday    = range === '今日';
  const gCalls     = gatewayStats?.calls ?? 0;
  const byProvider = gatewayStats?.by_provider ?? {};
  // Hourly trend: prefer gateway (covers all calls) over backend (incomplete without reportUsage)
  const gwHourly   = gatewayStats?.hourly;
  const trendData  = gwHourly?.length === 24 ? gwHourly : hourly;
  // Gateway tier breakdown — use stored tier when available, fall back to id-based inference
  const gwFree = Object.entries(byProvider).filter(([id, v]) => (v.tier || tierFromProvider(id)) === 'free').reduce((s, [, v]) => s + (v.calls || 0), 0);
  const gwP2P  = Object.entries(byProvider).filter(([id, v]) => (v.tier || tierFromProvider(id)) === 'p2p' ).reduce((s, [, v]) => s + (v.calls || 0), 0);
  const gwPaid = Object.entries(byProvider).filter(([id, v]) => (v.tier || tierFromProvider(id)) === 'paid').reduce((s, [, v]) => s + (v.calls || 0), 0);

  // For "今日": merge gateway per-key stats so scene table shows all calls, not just P2P
  const gwByKey = gatewayStats?.by_key ?? {};
  const mergedKeyStats = isToday && Object.keys(gwByKey).length > 0
    ? keyStats.map(s => {
        const gk = gwByKey[s.api_key] || {};
        return {
          ...s,
          request_count: Math.max(s.request_count || 0, gk.calls || 0),
          total_tokens:  Math.max(s.total_tokens  || 0, gk.tokens || 0),
        };
      })
    : keyStats;

  const totalReqs    = mergedKeyStats.reduce((a, s) => a + (s.request_count || 0), 0);
  const totalCredits = mergedKeyStats.reduce((a, s) => a + (s.total_credits || 0), 0);
  const totalTokens  = mergedKeyStats.reduce((a, s) => a + (s.total_tokens  || 0), 0);
  const fmtTokens    = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : String(totalTokens);
  // Tier counts from backend (persistent, multi-session)
  const bkFree  = keyStats.reduce((a, s) => a + (s.free_count  || 0), 0);
  const bkP2P   = keyStats.reduce((a, s) => a + (s.p2p_count   || 0), 0);
  const bkPaid  = keyStats.reduce((a, s) => a + (s.paid_count  || 0), 0);
  // Gateway is more authoritative ONLY when it has counted MORE calls than backend
  // (means non-scene-route calls exist in this session).
  // When backend has ≥ gateway calls (e.g. after restart, gateway counter reset),
  // use backend data so the percentages aren't distorted by a partial session.
  const gatewayHasMore = isToday && gCalls > totalReqs;
  const displayTotal   = gatewayHasMore ? gCalls : totalReqs;
  const untracked      = gatewayHasMore ? gCalls - totalReqs : 0;
  // Tier breakdown: only trust gateway counts when gateway is the larger source
  const hasBkTiers = bkFree > 0 || bkP2P > 0 || bkPaid > 0;
  const freeCalls  = gatewayHasMore ? gwFree : (hasBkTiers ? bkFree  : gwFree);
  const p2pDisplay = gatewayHasMore ? gwP2P  : (hasBkTiers ? bkP2P   : gwP2P);
  const paidDisplay= gatewayHasMore ? gwPaid : (hasBkTiers ? bkPaid  : gwPaid);
  const freeRatio  = displayTotal > 0 ? Math.round(freeCalls / displayTotal * 100) : 0;
  // For "今日": merge gateway by_model (covers all calls incl. non-scene-route) with backend
  const gwModelMap = gatewayStats?.by_model ?? {};
  const mergedModelStats = isToday && Object.keys(gwModelMap).length > 0
    ? (() => {
        const map = {};
        for (const m of modelStats) map[m.model_name] = { ...m };
        for (const [name, v] of Object.entries(gwModelMap)) {
          if (!map[name]) map[name] = { model_name: name, request_count: 0, total_tokens: 0, total_credits: 0 };
          // Gateway call count is authoritative for today (includes non-scene-route)
          map[name].request_count = Math.max(map[name].request_count, v.calls || 0);
          // Gateway tokens supplement backend when backend hasn't recorded the call yet
          if ((v.tokens || 0) > (map[name].total_tokens || 0)) map[name].total_tokens = v.tokens;
        }
        return Object.values(map).sort((a, b) => b.request_count - a.request_count);
      })()
    : modelStats;

  const maxModel        = mergedModelStats[0]?.request_count || 1;
  // Token ranking: only models that actually have token data (exclude gateway-only models with 0 tokens)
  const modelByTokens   = [...mergedModelStats]
    .filter(m => (m.total_tokens || 0) > 0)
    .sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0));
  const maxModelTokens  = modelByTokens[0]?.total_tokens || 1;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-screen">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">盘点</h1>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-sm text-gray-500">基于场景应用的用量与费用分析</p>
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

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">总请求数</div>
          <div className="text-2xl font-bold mt-1">{displayTotal}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">
            {range} 全部请求{untracked > 0 ? ` · 含 ${untracked} 非场景路由` : ''}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">免费命中率</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{freeRatio}%</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{freeCalls} 免费 · {p2pDisplay} P2P · {paidDisplay} 付费</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">消耗积分</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{totalCredits.toFixed(1)}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{range} 合计</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">Token 消耗</div>
          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400 mt-1">{fmtTokens}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{range} 合计</div>
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

      {/* Scene app breakdown */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">场景应用用量</h2>
            <p className="text-xs text-gray-500 mt-0.5">按场景应用实例拆分请求量与积分</p>
          </div>
          <span className="text-xs text-gray-600">{range}</span>
        </div>
        {loading ? (
          <div className="px-5 py-8 text-xs text-gray-600 text-center">加载中…</div>
        ) : mergedKeyStats.length === 0 ? (
          <div className="px-5 py-8 text-xs text-gray-600 text-center">
            暂无消费记录。先在下方创建 API Key，再去「网关」绑定场景路由。
          </div>
        ) : (
          <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
            {mergedKeyStats.map(s => (
              <div key={s.key_id} className="px-5 py-4 hover:bg-gray-100/20 dark:bg-gray-800/20">
                <div className="flex items-center gap-4">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0 mt-0.5"/>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        {s.app_name || s.note || '未命名'}
                      </span>
                      {s.scene_name && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-300 dark:border-blue-800/40">
                          {s.icon} {s.scene_name}
                        </span>
                      )}
                      <code className="text-[10px] font-mono text-gray-600">{s.api_key?.slice(0, 12)}…</code>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-right shrink-0">
                    <div>
                      <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{s.request_count}</div>
                      <div className="text-[10px] text-gray-600">次请求</div>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                        {s.total_tokens >= 1000 ? `${(s.total_tokens / 1000).toFixed(1)}K` : s.total_tokens}
                      </div>
                      <div className="text-[10px] text-gray-600">tokens</div>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-blue-600 dark:text-blue-400">-{s.total_credits.toFixed(1)}</div>
                      <div className="text-[10px] text-gray-600">积分</div>
                    </div>
                    <button
                      onClick={() => handleDeleteKey(s.key_id)}
                      className="text-[10px] text-gray-700 hover:text-red-600 dark:text-red-400 transition-colors"
                    >删除</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Model rankings */}
      <div className="grid grid-cols-2 gap-4">
        {/* Call count ranking */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">模型调用排行</div>
          {mergedModelStats.length === 0 ? (
            <p className="text-xs text-gray-600">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {mergedModelStats.map(m => (
                <div key={m.model_name}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate max-w-[160px]" title={m.model_name}>
                      {m.model_name}
                    </span>
                    <span className="text-xs text-gray-600 dark:text-gray-400 shrink-0 ml-2">{m.request_count} 次</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500 bg-green-500"
                      style={{ width: `${Math.round(m.request_count / maxModel * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Token consumption ranking */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">模型 Token 消耗排行</div>
          {modelByTokens.length === 0 ? (
            <p className="text-xs text-gray-600">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {modelByTokens.map(m => {
                const tok = m.total_tokens || 0;
                const fmt = tok >= 1000 ? `${(tok / 1000).toFixed(1)}K` : String(tok);
                return (
                  <div key={m.model_name}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate max-w-[160px]" title={m.model_name}>
                        {m.model_name}
                      </span>
                      <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0 ml-2">{fmt} tok</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500 bg-purple-500"
                        style={{ width: `${Math.round(tok / maxModelTokens * 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

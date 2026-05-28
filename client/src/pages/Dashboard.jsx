import { useState, useEffect, useCallback } from 'react';

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
  const [tip, setTip] = useState(null); // { i, x }
  const max = Math.max(...data, 1);
  const H = 96; // px — matches h-24
  return (
    <div className="space-y-1">
      <div className="relative flex items-end gap-1 h-24">
        {data.map((v, i) => {
          const px = Math.max(Math.round((v / max) * H), v > 0 ? 4 : 2);
          const now = new Date().getHours();
          return (
            <div
              key={i}
              className="flex-1 cursor-default relative"
              onMouseEnter={e => setTip({ i, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setTip(null)}
            >
              {tip?.i === i && (
                <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-10
                  bg-gray-800 dark:bg-gray-700 text-white text-[10px] rounded px-1.5 py-0.5
                  whitespace-nowrap pointer-events-none shadow">
                  {i}:00 · {v} 次
                </div>
              )}
              <div
                className={`w-full rounded-sm transition-all duration-300 ${i === now ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-400 dark:hover:bg-gray-500'}`}
                style={{ height: `${px}px` }}
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
  const [localKeys, setLocalKeys] = useState([]);
  const [localData, setLocalData] = useState(null);   // queryDashboard result
  const [gwStatus, setGwStatus]   = useState(null);
  const [loading, setLoading]     = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const days = RANGE_DAYS[range];
      let data;
      if (window.electronAPI?.localStats) {
        data = await window.electronAPI.localStats.query(days);
      } else {
        const r = await fetch(`/api/local-stats?days=${days}`);
        if (!r.ok) throw new Error(`local-stats ${r.status}`);
        data = await r.json();
      }
      setLocalData(data);

      // Key notes come from localConfig (Electron) or we skip enrichment (CLI)
      if (window.electronAPI?.localConfig) {
        const cfg = await window.electronAPI.localConfig.get();
        setLocalKeys(cfg.local_keys || []);
      }

      // Gateway running status (port display)
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

  const handleDeleteKey = async (localKeyId) => {
    if (!confirm('删除此 API Key？')) return;
    try {
      if (window.electronAPI?.localConfig) {
        await window.electronAPI.localConfig.deleteKey(localKeyId);
      }
      await load();
    } catch {
      alert('删除失败');
    }
  };

  // ── Derived from local SQLite ──────────────────────────────────────────────
  const totalCalls  = localData?.total_calls  ?? 0;
  const totalTokens = localData?.total_tokens ?? 0;
  const fmtTokens   = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : String(totalTokens);

  const freeCalls  = localData?.tiers?.free  ?? 0;
  const p2pCalls   = localData?.tiers?.p2p   ?? 0;
  const paidCalls  = localData?.tiers?.paid  ?? 0;
  const freeRatio  = totalCalls > 0 ? Math.round(freeCalls / totalCalls * 100) : 0;

  const trendData  = localData?.hourly ?? Array(24).fill(0);

  // byProvider for donut chart: { [provider_id]: { calls, tier } }
  const byProvider = Object.fromEntries(
    (localData?.providers ?? []).map(p => [p.id, { calls: p.calls, tier: p.tier }])
  );

  // Scene table: enrich local key stats with notes from localConfig
  const keyNoteMap = new Map(localKeys.map(k => [k.key, k]));
  const enrichedKeys = (localData?.keys ?? []).map(k => {
    const lk = keyNoteMap.get(k.api_key);
    return {
      _local_key_id: lk?.id   || null,
      api_key:       k.api_key,
      app_name:      lk?.note || null,
      scene_name:    null,
      request_count: k.calls,
      total_tokens:  k.tokens,
      total_credits: 0,
    };
  });

  // Model rankings
  const modelStats     = localData?.models ?? [];
  const maxModel       = modelStats[0]?.calls || 1;
  const modelByTokens  = [...modelStats].filter(m => m.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const maxModelTokens = modelByTokens[0]?.tokens || 1;

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
          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400 mt-1">{fmtTokens}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{range} 合计</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">付费调用</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1">{paidCalls + p2pCalls}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{paidCalls} 付费层 · {p2pCalls} P2P 层</div>
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
        ) : enrichedKeys.length === 0 ? (
          <div className="px-5 py-8 text-xs text-gray-600 text-center">
            暂无消费记录。先在下方创建 API Key，再去「网关」绑定场景路由。
          </div>
        ) : (
          <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
            {enrichedKeys.map(s => (
              <div key={s.api_key} className="px-5 py-4 hover:bg-gray-100/20 dark:bg-gray-800/20">
                <div className="flex items-center gap-4">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0 mt-0.5"/>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        {s.app_name || '未命名'}
                      </span>
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
                    {s._local_key_id && (
                      <button
                        onClick={() => handleDeleteKey(s._local_key_id)}
                        className="text-[10px] text-gray-700 hover:text-red-600 dark:text-red-400 transition-colors"
                      >删除</button>
                    )}
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
          {modelStats.length === 0 ? (
            <p className="text-xs text-gray-600">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {modelStats.map(m => (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate max-w-[160px]" title={m.model}>
                      {m.model}
                    </span>
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

        {/* Token consumption ranking */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">模型 Token 消耗排行</div>
          {modelByTokens.length === 0 ? (
            <p className="text-xs text-gray-600">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {modelByTokens.map(m => {
                const tok = m.tokens || 0;
                const fmt = tok >= 1000 ? `${(tok / 1000).toFixed(1)}K` : String(tok);
                return (
                  <div key={m.model}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate max-w-[160px]" title={m.model}>
                        {m.model}
                      </span>
                      <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0 ml-2">{fmt} tok</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500 bg-purple-500"
                        style={{ width: `${Math.round(tok / maxModelTokens * 100)}%` }} />
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

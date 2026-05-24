import { useState, useEffect, useCallback } from 'react';
import { getDashboardStats, getModelStats, listKeys, createKey, deleteKey } from '../api/client';

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
    const t = tierFromProvider(id);
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
  const [loading, setLoading]     = useState(true);
  const [newKeyNote, setNewKeyNote] = useState('');
  const [creating, setCreating]   = useState(false);

  const days = RANGE_DAYS[range];

  const load = useCallback(async () => {
    setLoading(true);
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
  }, [days]);

  useEffect(() => {
    load();
    if (window.electronAPI?.gateway) {
      window.electronAPI.gateway.getDailyStats().then(setGatewayStats).catch(() => {});
    }
  }, [load]);

  const handleCreateKey = async () => {
    if (!newKeyNote.trim()) return;
    setCreating(true);
    try {
      await createKey(newKeyNote.trim());
      setNewKeyNote('');
      await load();
    } catch (e) {
      alert('创建失败: ' + (e.response?.data?.detail || e.message));
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteKey = async (keyId) => {
    if (!confirm('删除此 API Key？')) return;
    try {
      await deleteKey(keyId);
      await load();
    } catch (e) {
      alert('删除失败');
    }
  };

  const totalReqs    = keyStats.reduce((a, s) => a + (s.request_count || 0), 0);
  const totalCredits = keyStats.reduce((a, s) => a + (s.total_credits || 0), 0);
  const gCalls       = gatewayStats?.calls ?? 0;
  const byProvider   = gatewayStats?.by_provider ?? {};
  const freeCalls    = Object.entries(byProvider)
    .filter(([id]) => tierFromProvider(id) === 'free')
    .reduce((s, [, v]) => s + (v.calls || 0), 0);
  const freeRatio    = gCalls > 0 ? Math.round(freeCalls / gCalls * 100) : 0;
  const maxModel     = modelStats[0]?.request_count || 1;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-screen">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">盘点</h1>
          <p className="text-sm text-gray-500 mt-0.5">基于场景应用的用量与费用分析</p>
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
          <div className="text-2xl font-bold mt-1">{range === '今日' ? gCalls || totalReqs : totalReqs}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{range} 消费请求</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">免费命中率</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{freeRatio}%</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{freeCalls} 次走免费层</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">消耗积分</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{totalCredits.toFixed(0)}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">{range} 合计</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500">场景应用数</div>
          <div className="text-2xl font-bold mt-1">{keyStats.length}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">已配置接入点</div>
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
          <TrendBars data={hourly} />
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
        ) : keyStats.length === 0 ? (
          <div className="px-5 py-8 text-xs text-gray-600 text-center">
            暂无消费记录。先在下方创建 API Key，再去「网关」绑定场景路由。
          </div>
        ) : (
          <div className="divide-y divide-gray-200/50 dark:divide-gray-800/50">
            {keyStats.map(s => (
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

      {/* Model hit ranking */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">模型命中排行</div>
          {modelStats.length === 0 ? (
            <p className="text-xs text-gray-600">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {modelStats.map(m => (
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

        {/* Create new key */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 flex flex-col">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">新建 API Key</div>
          <p className="text-xs text-gray-500 mb-4">创建后在「网关」→「场景应用」中绑定路由</p>
          <div className="flex gap-2 mb-3">
            <input
              value={newKeyNote}
              onChange={e => setNewKeyNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
              placeholder="备注，如 Claude Code 主机"
              className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-400 dark:placeholder-gray-600"
            />
            <button
              onClick={handleCreateKey}
              disabled={creating || !newKeyNote.trim()}
              className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >{creating ? '…' : '创建'}</button>
          </div>

          {/* existing keys list */}
          <div className="flex-1 overflow-y-auto space-y-1.5">
            {keyStats.map(s => (
              <div key={s.key_id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-100/50 dark:bg-gray-800/50">
                <code className="text-[10px] font-mono text-gray-600 dark:text-gray-400 flex-1 truncate">{s.api_key?.slice(0, 18)}…</code>
                <span className="text-[10px] text-gray-500 truncate max-w-[80px]">{s.app_name || s.note || '—'}</span>
              </div>
            ))}
            {keyStats.length === 0 && (
              <p className="text-xs text-gray-600 text-center py-4">还没有 API Key</p>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

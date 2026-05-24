/**
 * 网关 Tab 1 · 📊 总览
 *
 * 5 KPI 卡 + 消耗趋势 (recharts AreaChart 堆叠) + 应用归因横条
 */
import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';

const LOCAL_GATEWAY_URL =
  typeof window !== 'undefined' && window.localStorage?.getItem('llp.gatewayUrl')
    ? window.localStorage.getItem('llp.gatewayUrl')
    : 'http://127.0.0.1:11435';

async function api(path) {
  const res = await fetch(LOCAL_GATEWAY_URL + path);
  const text = await res.text();
  try { return { ok: res.ok, body: JSON.parse(text) }; }
  catch { return { ok: res.ok, body: text }; }
}

function copy(s) { try { navigator.clipboard?.writeText(s || ''); } catch {} }

function Kpi({ label, value, subtitle, color = 'text-gray-900 dark:text-gray-100' }) {
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${color}`}>{value}</p>
      {subtitle && <p className="text-[10px] text-gray-400 mt-0.5 truncate">{subtitle}</p>}
    </div>
  );
}

const TIER_COLORS = {
  free:   '#10b981',  // green
  cache:  '#f59e0b',  // amber
  shared: '#a855f7',  // purple
  paid:   '#3b82f6',  // blue
};

const ATTRIB_BAR_COLOR = '#3b82f6';

export default function Overview({ health, onConfigureClaude }) {
  const [kpis, setKpis] = useState(null);
  const [trend, setTrend] = useState(null);
  const [attribution, setAttribution] = useState([]);
  const [trendWindow, setTrendWindow] = useState('7d');

  useEffect(() => {
    (async () => {
      const [k, a] = await Promise.all([
        api('/__local__/gateway/kpis?window=today'),
        api('/__local__/dashboard/attribution?window=today'),
      ]);
      if (k.ok) setKpis(k.body);
      if (a.ok) setAttribution(a.body.items || []);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const t = await api(`/__local__/dashboard/trend?window=${trendWindow}`);
      if (t.ok) setTrend(t.body);
    })();
  }, [trendWindow]);

  const maxTokens = Math.max(1, ...attribution.map((a) => a.tokens || 0));

  return (
    <div className="space-y-4">
      {/* KPI 行 */}
      <div className="flex gap-3 flex-wrap">
        <Kpi label="今日请求" value={kpis?.total_calls ?? '—'} />
        <Kpi label="免费命中率" value={kpis ? `${kpis.free_hit_rate}%` : '—'}
             color="text-green-600 dark:text-green-400"
             subtitle={kpis ? `tier=free + cache` : ''} />
        <Kpi label="错误率" value={kpis ? `${kpis.error_rate}%` : '—'}
             color={(kpis?.error_rate || 0) > 5 ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'}
             subtitle="含 fallback 后失败" />
        <Kpi label="平均延迟" value={kpis ? `${kpis.avg_latency_ms}ms` : '—'} />
        <Kpi label="今日节省 vs 全 paid" value={kpis ? `$${(kpis.saved_usd || 0).toFixed(2)}` : '—'}
             color="text-emerald-600 dark:text-emerald-400"
             subtitle={kpis ? `${kpis.saved_pct}% off (paid eq $${(kpis.paid_equivalent_usd || 0).toFixed(2)})` : ''} />
      </div>

      {/* 消耗趋势 */}
      <section className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm">消耗趋势（按 tier 着色）</h3>
          <div className="flex rounded overflow-hidden border border-gray-200 dark:border-gray-700">
            {['24h', '7d', '30d'].map((w) => (
              <button key={w} onClick={() => setTrendWindow(w)}
                      className={`px-2.5 py-1 text-xs font-medium ${trendWindow === w ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                {w}
              </button>
            ))}
          </div>
        </div>
        {!trend || trend.buckets?.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-sm text-gray-400">还没有数据，等等再来看</div>
        ) : (
          <div style={{ width: '100%', height: 200 }}>
            <ResponsiveContainer>
              <AreaChart data={trend.buckets} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.2} />
                <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} />
                <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} />
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 4, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="free"   stackId="1" stroke={TIER_COLORS.free}   fill={TIER_COLORS.free}   fillOpacity={0.7} />
                <Area type="monotone" dataKey="cache"  stackId="1" stroke={TIER_COLORS.cache}  fill={TIER_COLORS.cache}  fillOpacity={0.7} />
                <Area type="monotone" dataKey="shared" stackId="1" stroke={TIER_COLORS.shared} fill={TIER_COLORS.shared} fillOpacity={0.7} />
                <Area type="monotone" dataKey="paid"   stackId="1" stroke={TIER_COLORS.paid}   fill={TIER_COLORS.paid}   fillOpacity={0.7} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* 应用归因 */}
      <section className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
        <h3 className="font-semibold text-sm mb-3">应用归因（今日 Top {attribution.length || '0'} by tokens）</h3>
        {attribution.length === 0 ? (
          <p className="text-xs text-gray-400 italic">还没有调用，在 Claude Code / Cursor 里发一条试试</p>
        ) : (
          <div className="space-y-1.5">
            {attribution.map((a) => {
              const widthPct = Math.round((a.tokens / maxTokens) * 100);
              return (
                <div key={a.app} className="flex items-center gap-3 text-xs">
                  <span className="w-32 shrink-0 truncate font-medium">{a.app}</span>
                  <div className="flex-1 h-6 bg-gray-100 dark:bg-gray-950 rounded relative overflow-hidden">
                    <div className="absolute inset-y-0 left-0 rounded transition-all"
                         style={{ width: `${widthPct}%`, backgroundColor: ATTRIB_BAR_COLOR, opacity: 0.7 }} />
                  </div>
                  <span className="w-20 text-right font-mono">{(a.tokens || 0).toLocaleString()}</span>
                  <span className="w-12 text-right text-gray-500">{a.calls}次</span>
                  <span className="w-20 text-right text-emerald-600 dark:text-emerald-400">${(a.saved_usd || 0).toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 接入端点 */}
      <section className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
        <p className="text-xs text-gray-500 mb-2">接入端点</p>
        <div className="flex items-center gap-2 flex-wrap">
          <code className="flex-1 min-w-0 font-mono text-sm bg-gray-100 dark:bg-gray-800 rounded px-3 py-2 truncate">{health?.gateway_url}/v1</code>
          <button onClick={() => copy(`${health?.gateway_url}/v1`)} className="text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800">复制</button>
          <button onClick={onConfigureClaude} className="text-xs px-2 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">⚙ 配置到 Claude Code</button>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">不同应用使用独立的 API Key（场景）区分调用</p>
      </section>
    </div>
  );
}

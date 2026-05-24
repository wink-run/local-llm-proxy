/**
 * Dashboard —— v2.1 默认首屏。
 *
 * 设计文档：DESIGN_v2.md §8.1
 *
 *   ┌─────────── Tier 1 (free) ─────────── Tier 2 (paid) ─── Tier 3 (shared) ──┐
 *   │                                                                          │
 *   │  Providers / Models / 今日调用 / 今日 token / cache hit                    │
 *   │                                                                          │
 *   ├──────────────────── 应用接入状态 ─────────────────────────────────────────┤
 *   │ Claude Code → cost-first @ Tier 1 · 今日 N 调用                            │
 *   ├──────────────────── 最近 10 条调用（脱敏） ────────────────────────────────┤
 *   │ 18:42  Claude Code → tier1 / groq / llama-3.3 · 421 tok · 312ms           │
 *   └──────────────────────────────────────────────────────────────────────────┘
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const LOCAL_GATEWAY_URL =
  typeof window !== 'undefined' && window.localStorage?.getItem('llp.gatewayUrl')
    ? window.localStorage.getItem('llp.gatewayUrl')
    : 'http://127.0.0.1:11435';

async function api(path, opts = {}) {
  const res = await fetch(LOCAL_GATEWAY_URL + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

const TIER_META = {
  free:   { icon: '🎁', label: '免费层', desc: 'Ollama / Groq / Cerebras / Gemini / OpenRouter', color: 'green' },
  paid:   { icon: '💳', label: '付费层', desc: '你的自有 API key 余额',                       color: 'blue' },
  shared: { icon: '🤝', label: '共享层', desc: '贡献积分换购（板块③）',                       color: 'purple' },
};

function num(v) { return (v ?? 0).toLocaleString(); }

function TierCard({ tier, capacity, usage, isMax }) {
  const meta = TIER_META[tier];
  const colorBg = { green: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-900',
                    blue:  'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-900',
                    purple:'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-900' }[meta.color];
  const used = usage?.total_tokens || 0;
  return (
    <div className={`flex-1 min-w-0 rounded-lg border ${colorBg} p-4`}>
      <div className="flex items-center gap-2">
        <span className="text-2xl">{meta.icon}</span>
        <div>
          <h3 className="font-semibold text-sm">{meta.label}</h3>
          <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight">{meta.desc}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-gray-500">Providers</p>
          <p className="text-lg font-semibold">{capacity?.providers ?? 0}</p>
        </div>
        <div>
          <p className="text-gray-500">Models</p>
          <p className="text-lg font-semibold">{capacity?.model_count ?? 0}</p>
        </div>
        <div>
          <p className="text-gray-500">调用</p>
          <p className="text-lg font-semibold">{num(usage?.calls)}</p>
        </div>
        <div>
          <p className="text-gray-500">Tokens</p>
          <p className="text-lg font-semibold">{num(used)}</p>
        </div>
      </div>
      {usage?.cache_hits > 0 && (
        <div className="mt-2 text-[10px] text-gray-500">含 {usage.cache_hits} 次 prompt-cache 命中</div>
      )}
      {isMax && used > 0 && (
        <div className="mt-2 text-[10px] text-gray-600 dark:text-gray-300 font-medium">今日主力 ⭐</div>
      )}
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  // 后端给的是 UTC 'YYYY-MM-DD HH:MM:SS'，加 Z 当 ISO
  const t = Date.parse(iso.replace(' ', 'T') + 'Z');
  if (!t) return iso;
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(t).toLocaleString();
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [window_, setWindow] = useState('today');
  const [data, setData] = useState(null);
  const [recent, setRecent] = useState([]);
  const [needsQuickstart, setNeedsQuickstart] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await api(`/__local__/dashboard/summary?window=${window_}`);
      if (!alive) return;
      if (!s.ok) { setData(false); return; }
      setData(s.body);
      // 零接入 → 提示去 QuickStart
      const empty = (s.body.provider_count === 0) && (s.body.bindings.length === 0);
      setNeedsQuickstart(empty);
      const r = await api('/__local__/dashboard/recent?limit=15');
      if (r.ok) setRecent(r.body.calls || []);
    })();
    return () => { alive = false; };
  }, [window_, refreshKey]);

  if (data === false) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold mb-3">本地网关未启动</h1>
        <button onClick={() => setRefreshKey((k) => k + 1)} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white">
          重试
        </button>
      </div>
    );
  }

  if (data === null) {
    return <div className="p-8 text-sm text-gray-500">加载中…</div>;
  }

  // 找出 today 最大 tier
  const tierUsage = data.tier_usage || {};
  const maxTier = ['free', 'paid', 'shared'].reduce(
    (acc, t) => ((tierUsage[t]?.total_tokens || 0) > (tierUsage[acc]?.total_tokens || 0) ? t : acc),
    'free',
  );

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">我的 Token</h1>
          <p className="text-xs text-gray-500 mt-1">
            三级 token 供给 + 应用接入状态 + 最近调用流水
          </p>
        </div>
        <div className="flex rounded overflow-hidden border border-gray-200 dark:border-gray-700">
          {['today', 'month', 'all'].map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-3 py-1 text-xs font-medium ${window_ === w ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-900 text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
            >
              {w === 'today' ? '今日' : w === 'month' ? '本月' : '累计'}
            </button>
          ))}
        </div>
      </header>

      {needsQuickstart && (
        <div className="mb-4 flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 rounded-lg p-4">
          <div>
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">还没接入任何 Provider</p>
            <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">点右边按钮 60 秒完成初始化</p>
          </div>
          <button onClick={() => navigate('/quickstart')} className="text-sm px-4 py-2 rounded bg-blue-600 text-white font-medium hover:bg-blue-700">
            ⚡ Quick Start
          </button>
        </div>
      )}

      {/* 三层卡片 */}
      <div className="flex gap-3 mb-6 flex-wrap">
        {['free', 'paid', 'shared'].map((tier) => (
          <TierCard
            key={tier}
            tier={tier}
            capacity={data.tier_capacity[tier]}
            usage={data.tier_usage[tier]}
            isMax={maxTier === tier}
          />
        ))}
      </div>

      {/* 应用接入状态 */}
      <section className="mb-6 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-sm">应用接入状态</h3>
          <button onClick={() => navigate('/apps')} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            管理 →
          </button>
        </div>
        {data.bindings.length === 0 ? (
          <p className="text-xs text-gray-400 italic">还没有工具接入。去 📝 写入应用 添加。</p>
        ) : (
          <div className="space-y-1.5">
            {data.bindings.map((b) => {
              const appStats = (data.by_app || []).find((a) => a.app === b.app_name);
              return (
                <div key={b.app_name} className="flex items-center justify-between text-xs px-3 py-1.5 rounded bg-gray-50 dark:bg-gray-950">
                  <span className="font-medium">{b.app_name}</span>
                  <span className="text-gray-500">
                    {b.policy_name ? <code className="px-1 bg-blue-100 dark:bg-blue-900/40 rounded">{b.policy_name}</code> : <em className="text-gray-400">无 policy</em>}
                    {appStats && <> · {appStats.calls} 调用 · {num(appStats.total_tokens)} tok</>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 最近调用 */}
      <section className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 p-4">
        <h3 className="font-semibold text-sm mb-3">最近调用（脱敏，无 prompt 内容）</h3>
        {recent.length === 0 ? (
          <p className="text-xs text-gray-400 italic">还没有调用。在 Claude Code / Cursor 等工具里发一条试试。</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-gray-500 border-b border-gray-100 dark:border-gray-800">
              <tr>
                <th className="text-left py-1.5 font-medium">时间</th>
                <th className="text-left font-medium">应用</th>
                <th className="text-left font-medium">Tier</th>
                <th className="text-left font-medium">Provider</th>
                <th className="text-left font-medium">Model</th>
                <th className="text-right font-medium">Token</th>
                <th className="text-right font-medium">延迟</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id} className="border-b border-gray-50 dark:border-gray-900">
                  <td className="py-1 text-gray-500">{timeAgo(c.timestamp)}</td>
                  <td className="text-gray-700 dark:text-gray-300">{c.app_source || '—'}</td>
                  <td>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      c.tier === 'free' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                      : c.tier === 'paid' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                      : c.tier === 'shared' ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                      : c.cached ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600'
                    }`}>{c.cached ? 'cache' : c.tier}</span>
                  </td>
                  <td className="text-gray-600 dark:text-gray-400">{c.routed_to}</td>
                  <td className="text-gray-600 dark:text-gray-400 truncate max-w-[160px]">{c.model}</td>
                  <td className="text-right font-mono">{c.input_tokens + c.output_tokens || '—'}</td>
                  <td className="text-right font-mono text-gray-500">{c.latency_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

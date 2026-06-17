// client/src/pages/TokenDashboard.jsx
import React, { useEffect, useState } from 'react';
import { useAuth } from '../store/index';
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder, spin, getSpinStatus, getUserDevices, deleteDevice } from '../api/client';

/** Query local stats via Electron IPC or HTTP gateway */
async function fetchLocalStats(days) {
  if (window.electronAPI?.localStats) {
    return window.electronAPI.localStats.query(days);
  }
  const r = await fetch(`/api/local-stats?days=${days}`);
  if (!r.ok) throw new Error(`local-stats ${r.status}`);
  return r.json();
}

const PROVIDER_COLORS = {
  ollama:         { bg: 'bg-green-500',  label: 'Ollama（本地）',   type: 'free' },
  groq:           { bg: 'bg-emerald-500',label: 'Groq',             type: 'free' },
  'github-models':{ bg: 'bg-teal-500',   label: 'GitHub Models',    type: 'free' },
  'tokenbank-p2p':{ bg: 'bg-blue-500',   label: 'P2P 网络',         type: 'p2p'  },
  openai:         { bg: 'bg-orange-500', label: 'OpenAI',           type: 'paid' },
  'anthropic-paid':{ bg: 'bg-red-500',   label: 'Anthropic',        type: 'paid' },
};

const TX_LABEL = { contribute: '贡献', consume: '消耗', referral: '推荐', purchase: '充值', adjust: '调整', spin: '转盘' };
const ORDER_STATUS = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };

const RANGES    = ['今日', '7 天', '30 天'];
const RANGE_DAYS = { '今日': 1, '7 天': 7, '30 天': 30 };

const DATA_SOURCE_LABELS = {
  'proxy':            '🛰️ 网关实时',
  'session-claude':   '🔷 Claude Code',
  'session-codex':    '⚡ Codex',
  'session-gemini':   '♊ Gemini CLI',
  'session-cursor':   '🖱️ Cursor',
  'session-opencode': '📝 OpenCode',
  'session-copilot':  '🤖 Copilot CLI',
};

const SUB_PLAN_LABELS = {
  'claude-pro':       'Claude Pro',
  'max5x':            'Claude Max 5×',
  'max20x':           'Claude Max 20×',
  'chatgpt-plus':     'ChatGPT Plus',
  'chatgpt-team':     'ChatGPT Team',
  'chatgpt-pro':      'ChatGPT Pro',
  'gemini-advanced':  'Gemini Advanced',
  'copilot-pro':      'Copilot Pro',
  'copilot-business': 'Copilot Business',
  'cursor-pro':       'Cursor Pro',
  'cursor-ultra':     'Cursor Ultra',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ProviderBar({ id, calls, totalCalls }) {
  const meta  = PROVIDER_COLORS[id] || { bg: 'bg-gray-400', label: id };
  const pct   = totalCalls > 0 ? (calls / totalCalls) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-28 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate">{meta.label}</div>
      <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full ${meta.bg}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-16 shrink-0 text-right">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{calls} 次</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">{Math.round(pct)}%</span>
      </div>
      <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full ${
        meta.type === 'free' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
        meta.type === 'p2p'  ? 'bg-blue-100  dark:bg-blue-900/30  text-blue-700  dark:text-blue-400'  :
                               'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400'
      }`}>
        {meta.type === 'free' ? '免费' : meta.type === 'p2p' ? '积分' : '付费'}
      </span>
    </div>
  );
}

function CheckinCard({ onSuccess }) {
  const [status,   setStatus]   = useState(null);
  const [checking, setChecking] = useState(false);
  const [msg,      setMsg]      = useState('');

  useEffect(() => { getCheckinStatus().then(r => setStatus(r.data)).catch(() => {}); }, []);

  async function handleCheckin() {
    setChecking(true); setMsg('');
    try {
      const r = await checkin();
      setMsg(`+${r.data.credits} 积分`);
      setStatus(s => ({ ...s, checked_in_today: true }));
      onSuccess?.();
    } catch (e) { setMsg(e.response?.data?.detail || '签到失败'); }
    finally { setChecking(false); }
  }

  const done = status?.checked_in_today;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xl select-none">📅</span>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日签到</p>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {status === null ? '加载中…' : done ? `今日已签到 +${status.credits_today} 积分` : `签到得 ${status.reward} 积分`}
      </p>
      {msg && <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</span>}
      <button onClick={handleCheckin} disabled={checking || done}
        className={`py-1.5 rounded-lg text-sm font-medium transition-colors ${done ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 cursor-default' : 'bg-blue-600 hover:bg-blue-500 text-white'} disabled:opacity-60`}>
        {checking ? '签到中…' : done ? '已签到 ✓' : '签到'}
      </button>
    </div>
  );
}

function SpinCard({ onSuccess }) {
  const [status,  setStatus]  = useState(null);
  const [spinning,setSpinning]= useState(false);
  const [msg,     setMsg]     = useState('');

  useEffect(() => { getSpinStatus().then(r => setStatus(r.data)).catch(() => {}); }, []);

  async function handleSpin() {
    if (spinning || status?.spins_left === 0) return;
    setSpinning(true); setMsg('');
    try {
      const r = await spin();
      setMsg(`+${r.data.credits} 积分`);
      setStatus(s => ({ ...s, spins_left: r.data.spins_left }));
      onSuccess?.();
    } catch (e) { setMsg(e.response?.data?.detail || '抽奖失败'); }
    finally { setSpinning(false); }
  }

  const exhausted = status?.spins_left === 0;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xl select-none">🎡</span>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日转盘</p>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {status === null ? '加载中…' : exhausted ? '今日次数已用完' : `今日剩余 ${status.spins_left} 次`}
      </p>
      {msg && <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</span>}
      <button onClick={handleSpin} disabled={spinning || exhausted || !status}
        className={`py-1.5 rounded-lg text-sm font-medium transition-colors ${exhausted ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 cursor-default' : 'bg-blue-600 hover:bg-blue-500 text-white'} disabled:opacity-60`}>
        {spinning ? '抽奖中…' : exhausted ? '明日再来' : '抽奖'}
      </button>
    </div>
  );
}

// ── Agent source chart ────────────────────────────────────────────────────────
function AgentSourceChart({ sources }) {
  if (!sources?.length) return null;
  const maxCalls = Math.max(...sources.map(s => s.calls), 1);
  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">工具来源分布</h2>
      <div className="space-y-2.5">
        {sources.map(s => {
          const label = DATA_SOURCE_LABELS[s.source] || s.source;
          const pct   = Math.round(s.calls / maxCalls * 100);
          return (
            <div key={s.source} className="flex items-center gap-3 text-sm">
              <div className="w-32 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate">{label}</div>
              <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                <div className="h-2 rounded-full bg-emerald-400 transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-10 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">{s.calls}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Subscription bar ──────────────────────────────────────────────────────────
function SubscriptionBar({ providers }) {
  const subs = (providers || []).filter(p => p.billing_type === 'subscription' && p.enabled);
  if (!subs.length) return null;
  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">订阅接入</h2>
      <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
        {subs.map(p => (
          <div key={p.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
            <span className="text-xs text-gray-700 dark:text-gray-300 w-28 shrink-0 font-medium">{p.label || p.id}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40">
              {SUB_PLAN_LABELS[p.subscription_plan] || '订阅'}
            </span>
            <span className="text-[11px] text-gray-400">{p.sub_mode === 'api-proxy' ? '订阅转 API' : '仅记账'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Devices section ───────────────────────────────────────────────────────────

const DEVICE_ICON = { desktop: '💻', cli: '🖥' };

function DevicesSection() {
  const [devices, setDevices] = useState(null);

  useEffect(() => {
    getUserDevices()
      .then(r => {
        const raw = r.data?.devices || [];
        // normalise: ensure every entry has device_id (backend may return id instead)
        const normalised = raw.map(d => ({ ...d, device_id: d.device_id || d.id || null }));
        // deduplicate by device_id, drop entries with no identifier at all
        const seen = new Set();
        const clean = normalised.filter(d => {
          if (!d.device_id) return false;
          if (seen.has(d.device_id)) return false;
          seen.add(d.device_id);
          return true;
        });
        setDevices(clean);
      })
      .catch(() => setDevices([]));
  }, []);

  async function handleRemove(deviceId) {
    try {
      await deleteDevice(deviceId);
      setDevices(prev => prev.filter(d => d.device_id !== deviceId));
    } catch {}
  }

  if (devices === null) return null; // loading — don't flash empty
  if (devices.length === 0) return null;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">我的设备</h2>
      <div className="space-y-2">
        {devices.map((d, i) => (
          <div key={`${d.device_id ?? d.id ?? ''}-${i}`}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-900">
            <span className="text-base select-none shrink-0">{DEVICE_ICON[d.type] || '🖥'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.online ? 'bg-green-500' : 'bg-gray-400'}`} />
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{d.name}</span>
                {d.version && <span className="text-xs text-gray-400 shrink-0">v{d.version}</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-gray-400 truncate">{d.platform}</span>
                {(d.today_calls > 0 || d.today_errors > 0) && (
                  <span className="text-xs text-gray-400 shrink-0">
                    今日 {d.today_calls} 次
                    {d.today_errors > 0 && <span className="text-red-400 ml-1">{d.today_errors} 错</span>}
                  </span>
                )}
              </div>
            </div>
            <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
              d.online
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
            }`}>
              {d.online ? '在线' : '离线'}
            </span>
            {!d.online && (
              <button onClick={() => handleRemove(d.device_id)}
                className="shrink-0 text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors px-1">
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TokenDashboard() {
  const { user, refreshUser } = useAuth();
  const [txs,      setTxs]      = useState([]);
  const [orders,   setOrders]   = useState([]);
  const [adminInfo,setAdminInfo]= useState('');
  const [contact,  setContact]  = useState('');
  const [note,     setNote]     = useState('');
  const [submitting,setSubmitting]=useState(false);
  const [orderMsg, setOrderMsg] = useState('');
  const [orderMsgOk,setOrderMsgOk]=useState(false);
  const [creditsOpen,setCreditsOpen]=useState(false);
  const [range,       setRange]      = useState('今日');
  const [rangeStats,  setRangeStats] = useState({ calls: 0, tokens: 0, free: 0, p2p: 0, paid: 0 });
  const [rangeModels, setRangeModels]= useState([]);
  const [localData,   setLocalData]  = useState(null);
  const [cfgProviders, setCfgProviders] = useState([]);

  useEffect(() => {
    refreshUser();
    getTransactions().then(r => setTxs(r.data.transactions || [])).catch(() => {});
    getPurchaseOrders().then(r => { setOrders(r.data.orders || []); if (r.data.contact_info) setAdminInfo(String(r.data.contact_info)); }).catch(() => {});
    if (window.electronAPI?.config?.read) {
      window.electronAPI.config.read().then(cfg => { if (cfg?.providers?.length) setCfgProviders(cfg.providers); }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const days = RANGE_DAYS[range];
    fetchLocalStats(days).then(data => {
      setLocalData(data);
      setRangeStats({
        calls:  data.total_calls  || 0,
        tokens: data.total_tokens || 0,
        free:   data.tiers?.free  || 0,
        p2p:    data.tiers?.p2p   || 0,
        paid:   data.tiers?.paid  || 0,
      });
      setRangeModels(data.models || []);
    }).catch(() => {});
  }, [range]);

  if (!user) return null;

  const heroTotal   = rangeStats.calls;
  const heroFree    = rangeStats.free;
  const heroNonFree = heroTotal - heroFree;

  const providerEntries = [...(localData?.providers ?? [])]
    .sort((a, b) => b.calls - a.calls)
    .map(p => [p.id, { calls: p.calls, tier: p.tier }]);
  const localTotalCalls = localData?.total_calls ?? 0;

  const isToday = range === '今日';

  const fmtRangeCalls  = heroTotal >= 1000 ? `${(heroTotal / 1000).toFixed(1)}K` : String(heroTotal);
  const fmtRangeTokens = rangeStats.tokens >= 1000 ? `${(rangeStats.tokens / 1000).toFixed(1)}K` : String(rangeStats.tokens);

  async function handleOrder(e) {
    e.preventDefault();
    if (submitting || !contact.trim()) return;
    setSubmitting(true); setOrderMsg('');
    try {
      const r = await createPurchaseOrder(0, `联系方式：${contact.trim()}${note.trim() ? `；${note.trim()}` : ''}`);
      setOrderMsgOk(true); setOrderMsg('申请已提交，管理员将与你联系。');
      if (r.data.contact_info) setAdminInfo(String(r.data.contact_info));
      setOrders(prev => [r.data.order, ...prev]); setContact(''); setNote('');
    } catch (err) {
      setOrderMsgOk(false); setOrderMsg(err.response?.data?.detail || '提交失败');
    } finally { setSubmitting(false); }
  }

  return (
    <div className="p-8 space-y-8">

      {/* Hero */}
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-blue-700 flex items-center justify-center text-xl font-bold text-white shrink-0">
          {(user.nickname || user.email || '?')[0].toUpperCase()}
        </div>
        <div>
          <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{user.nickname}</p>
          <p className="text-sm text-gray-400 truncate">{user.email}</p>
        </div>
      </div>

      {/* Usage card with range selector */}
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 rounded-2xl p-6">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-blue-300">{range} 总览</p>
          <div className="flex gap-1 bg-blue-800/50 rounded-lg p-0.5">
            {RANGES.map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  range === r ? 'bg-white/20 text-white font-medium' : 'text-blue-300 hover:text-white'
                }`}>{r}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {/* Left: calls */}
          <div>
            <p className="text-xs text-blue-300 mb-1">调用次数</p>
            <p className="text-4xl font-bold text-white">{fmtRangeCalls}</p>
            {isToday && heroTotal > 0 && (
              <p className="text-xs text-blue-300 mt-2">
                {heroFree} 免费（{Math.round(heroFree / heroTotal * 100)}%）·{' '}
                {heroNonFree} 积分/付费
              </p>
            )}
          </div>
          {/* Right: tokens + cost */}
          <div className="border-l border-blue-500/40 pl-4">
            <p className="text-xs text-blue-300 mb-1">Token 消耗</p>
            <p className="text-4xl font-bold text-white">{fmtRangeTokens}</p>
            {localData?.total_cost > 0 && (
              <p className="text-sm font-mono text-blue-200 mt-1">${localData.total_cost.toFixed(localData.total_cost < 0.01 ? 4 : 3)} 估算</p>
            )}
            <p className="text-xs text-blue-300 mt-1">各设备 {range} 合计</p>
          </div>
        </div>
      </div>

      {/* Credits (collapsible) */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl overflow-hidden">
        <button onClick={() => setCreditsOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold text-gray-700 dark:text-gray-200">积分账户</span>
            <span className="text-sm font-bold text-blue-600 dark:text-blue-400">💎 {Math.floor(user.credits_balance ?? 0).toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-gray-400">
              <span className="text-green-600 dark:text-green-400">+{Math.floor(user.credits_earned ?? 0).toLocaleString()}</span>
              <span className="mx-1">/</span>
              <span className="text-red-500 dark:text-red-400">-{Math.floor(user.credits_spent ?? 0).toLocaleString()}</span>
            </div>
            <span className="text-gray-400 text-sm">{creditsOpen ? '▲' : '▼'}</span>
          </div>
        </button>

        {creditsOpen && (
          <div className="px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700">
            {/* Recent transactions */}
            <div className="pt-4 space-y-2">
              <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">积分流水</h3>
              {txs.length === 0 ? (
                <p className="text-sm text-gray-400">暂无记录</p>
              ) : txs.slice(0, 8).map(tx => (
                <div key={tx.id} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="text-gray-700 dark:text-gray-300">{TX_LABEL[tx.type] || tx.type}{tx.model_name ? ` · ${tx.model_name}` : ''}</span>
                    <span className="text-xs text-gray-400 ml-2">{tx.created_at?.slice(0, 16)}</span>
                  </div>
                  <span className={`font-medium ${(tx.delta ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                    {(tx.delta ?? 0) >= 0 ? '+' : ''}{(tx.delta ?? 0).toFixed(1)}
                  </span>
                </div>
              ))}
            </div>

            {/* Purchase */}
            <div className="border-t border-gray-100 dark:border-gray-700 pt-4 space-y-3">
              <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">申领积分</h3>
              <form onSubmit={handleOrder} className="space-y-2">
                <input value={contact} onChange={e => setContact(e.target.value)} placeholder="联系方式（手机/微信/邮箱）" required
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400" />
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="备注（可选）"
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400" />
                <button type="submit" disabled={submitting || !contact.trim()}
                  className="w-full py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white">
                  {submitting ? '提交中…' : '提交申领'}
                </button>
              </form>
              {orderMsg && <p className={`text-sm ${orderMsgOk ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{orderMsg}</p>}
              {adminInfo && <div className="text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded-lg px-3 py-2 whitespace-pre-wrap">{adminInfo}</div>}
            </div>
          </div>
        )}
      </section>

      {/* Daily rewards */}
      <div className="grid grid-cols-2 gap-4">
        <CheckinCard onSuccess={refreshUser} />
        <SpinCard    onSuccess={refreshUser} />
      </div>

      {/* Devices */}
      <DevicesSection />

      {/* Agent/tool source chart */}
      <AgentSourceChart sources={localData?.agent_sources} />

      {/* Subscription providers */}
      <SubscriptionBar providers={cfgProviders} />

      {/* Provider breakdown — local stats */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">供给来源分布</h2>
          <span className="text-xs text-gray-400">{range}</span>
        </div>
        {providerEntries.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">暂无数据</p>
        ) : (
          <div className="space-y-2.5">
            {providerEntries.map(([id, { calls }]) => (
              <ProviderBar key={id} id={id} calls={calls} totalCalls={localTotalCalls} />
            ))}
          </div>
        )}
      </section>

      {/* Model breakdown — historical backend data */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">模型使用分布</h2>
          <span className="text-xs text-gray-400">{range}</span>
        </div>
        {rangeModels.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">暂无数据</p>
        ) : (
          <div className="space-y-2.5">
            {rangeModels.slice(0, 6).map(m => {
              const maxCalls = rangeModels[0]?.calls || 1;
              return (
                <div key={m.model} className="flex items-center gap-3 text-sm">
                  <div className="w-36 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate font-mono" title={m.model}>{m.model}</div>
                  <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                    <div className="h-2 rounded-full bg-blue-400 transition-all duration-500"
                      style={{ width: `${Math.round(m.calls / maxCalls * 100)}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">{m.calls} 次</span>
                </div>
              );
            })}
          </div>
        )}
      </section>


    </div>
  );
}

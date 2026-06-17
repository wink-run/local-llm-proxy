import React, { useEffect, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { useAuth } from '../store/index';
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder, spin, getSpinStatus, getUserDevices, deleteDevice, getInventoryStats } from '../api/client';
import UserAccountsPanel from '../components/UserAccountsPanel';

/** 从云端拉取各设备聚合盘点；失败时回退本机数据 */
async function fetchDashboardStats(days) {
  try {
    const r = await getInventoryStats(days);
    const data = r.data;
    if (data) return { ...data, source: 'cloud' };
  } catch {
    // 未登录或云端不可用时回退
  }
  if (window.electronAPI?.localStats) {
    const local = await window.electronAPI.localStats.query(days);
    return { ...local, source: 'local', devices: [] };
  }
  const r = await fetch(`/api/local-stats?days=${days}`);
  if (!r.ok) throw new Error(`local-stats ${r.status}`);
  const local = await r.json();
  return { ...local, source: 'local', devices: [] };
}

const PROVIDER_COLORS = {
  ollama:         { bg: 'bg-green-500',  label: 'Ollama（本地）',   type: 'free' },
  groq:           { bg: 'bg-emerald-500',label: 'Groq',             type: 'free' },
  'github-models':{ bg: 'bg-teal-500',   label: 'GitHub Models',    type: 'free' },
  'tokenbank-p2p':{ bg: 'bg-blue-500',   label: 'P2P 网络',         type: 'p2p'  },
  openai:         { bg: 'bg-orange-500', label: 'OpenAI',           type: 'paid' },
  'anthropic-paid':{ bg: 'bg-red-500',   label: 'Anthropic',        type: 'paid' },
};

const ORDER_STATUS = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };

const RANGES    = ['今日', '7 天', '30 天'];
const RANGE_DAYS = { '今日': 1, '7 天': 7, '30 天': 30 };

const DATA_SOURCE_LABELS = {
  'proxy':                  '🛰️ 网关实时',
  'session-claude':         '🔷 Claude Code',
  'session-claude-desktop': '🔷 Claude Desktop',
  'session-codex':          '⚡ Codex',
  'session-gemini':         '♊ Gemini CLI',
  'session-cursor':         '🖱️ Cursor',
  'session-opencode':       '📝 OpenCode',
  'session-copilot':        '🤖 Copilot CLI',
  'session-qwen':           '🐉 Qwen Code',
  'session-antigravity':    '🚀 Antigravity',
  'session-grok':           '𝕏 Grok',
};

/** 工具来源展示名 */
function sourceLabel(source) {
  if (!source) return '未知';
  if (DATA_SOURCE_LABELS[source]) return DATA_SOURCE_LABELS[source];
  if (source.startsWith('session-')) {
    const name = source.slice('session-'.length).replace(/-/g, ' ');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return source;
}

/** 供给源展示名 */
function providerLabel(id) {
  if (!id) return '未知';
  const known = PROVIDER_COLORS[id];
  if (known?.label) return known.label;
  if (id === 'cursor') return 'Cursor';
  if (id === 'claude-cli') return 'Claude CLI';
  if (id === 'codex-cli') return 'Codex CLI';
  if (id.startsWith('custom-')) return `自定义 ${id.slice(7, 15)}…`;
  return id;
}

/** 按筛选端取分布数据（全部 / 单端） */
function pickDistData(localData, devices, filterId) {
  if (!filterId || filterId === 'all') {
    return {
      agent_sources: localData?.agent_sources || [],
      providers: localData?.providers || [],
      models: localData?.models || [],
      total_calls: localData?.total_calls || 0,
      scopeLabel: '全端合计',
    };
  }
  const dev = (devices || []).find(d => d.device_id === filterId);
  if (!dev) {
    return { agent_sources: [], providers: [], models: [], total_calls: 0, scopeLabel: '' };
  }
  return {
    agent_sources: dev.agent_sources || dev.top_sources || [],
    providers: dev.providers || dev.top_providers || [],
    models: dev.models || dev.top_models || [],
    total_calls: dev.calls || 0,
    scopeLabel: dev.name || filterId,
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ProviderBar({ id, calls, totalCalls, tier }) {
  const meta  = PROVIDER_COLORS[id] || { bg: 'bg-gray-400', label: providerLabel(id), type: tier || 'paid' };
  const pct   = totalCalls > 0 ? (calls / totalCalls) * 100 : 0;
  const type  = tier || meta.type || 'paid';
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-28 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate" title={id}>{meta.label}</div>
      <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full ${meta.bg}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-16 shrink-0 text-right">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{calls} 次</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">{Math.round(pct)}%</span>
      </div>
      <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full ${
        type === 'free' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
        type === 'p2p'  ? 'bg-blue-100  dark:bg-blue-900/30  text-blue-700  dark:text-blue-400'  :
                           'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400'
      }`}>
        {type === 'free' ? '免费' : type === 'p2p' ? '积分' : '付费'}
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

const DEVICE_ICON = { desktop: '💻', cli: '🖥' };
const DEVICE_PIE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4'];

function fmtNum(n) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** 全部设备：各端调用 / Token / 费用占比饼图 */
function DeviceSharePies({ devices, range }) {
  const list = devices || [];
  const hasAny = list.some(d => (d.calls || 0) > 0 || (d.tokens || 0) > 0 || (d.cost || 0) > 0);
  if (!hasAny) return null;

  function PieBlock({ title, dataKey, formatValue }) {
    const data = list
      .filter(d => (d[dataKey] || 0) > 0)
      .map(d => ({ name: d.name || d.device_id, value: d[dataKey] }));
    if (data.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[200px] text-xs text-gray-400">
          <p className="font-medium text-gray-500 dark:text-gray-400 mb-1">{title}</p>
          <p>暂无数据</p>
        </div>
      );
    }
    const total = data.reduce((s, x) => s + x.value, 0);

    return (
      <div className="flex flex-col">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2 text-center">{title}</p>
        <ResponsiveContainer width="100%" height={160}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={36}
              outerRadius={64}
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
            >
              {data.map((entry, i) => (
                <Cell key={entry.name} fill={DEVICE_PIE_COLORS[i % DEVICE_PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v, _n, props) => {
                const pct = total > 0 ? Math.round(v / total * 100) : 0;
                const val = formatValue ? formatValue(v) : v;
                return [`${val} (${pct}%)`, props.payload.name];
              }}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-1 mt-1">
          {data.map((d, i) => (
            <div key={d.name} className="flex items-center justify-between gap-2 text-[10px] text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: DEVICE_PIE_COLORS[i % DEVICE_PIE_COLORS.length] }} />
                <span className="truncate" title={d.name}>{d.name}</span>
              </span>
              <span className="shrink-0 tabular-nums">{Math.round(d.value / total * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">各端占比</h2>
        <span className="text-xs text-gray-400">全端合计 · {range}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <PieBlock title="调用次数" dataKey="calls" formatValue={fmtNum} />
        <PieBlock title="Token 消耗" dataKey="tokens" formatValue={fmtNum} />
        <PieBlock
          title="费用估算"
          dataKey="cost"
          formatValue={v => `$${Number(v).toFixed(v < 0.01 ? 4 : 3)}`}
        />
      </div>
    </section>
  );
}

// ── 用量分布（工具 / 供给 / 模型），支持按端筛选 ─────────────────────────────
function UsageDistributionPanel({ localData, devices, range, filterId, onFilterChange }) {
  const dist = pickDistData(localData, devices, filterId);
  const { agent_sources, providers, models, total_calls, scopeLabel } = dist;

  const providerEntries = [...providers].sort((a, b) => b.calls - a.calls);
  const modelList = [...models].sort((a, b) => b.calls - a.calls);
  const hasDevices = (devices || []).length > 0;

  return (
    <div className="space-y-4">
      {/* 按端筛选 */}
      {hasDevices && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => onFilterChange('all')}
            className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
              filterId === 'all'
                ? 'bg-blue-600 text-white font-medium'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}>
            全部设备
          </button>
          {(devices || []).map(d => (
            <button key={d.device_id} type="button" onClick={() => onFilterChange(d.device_id)}
              className={`px-2.5 py-1 text-xs rounded-lg transition-colors truncate max-w-[140px] ${
                filterId === d.device_id
                  ? 'bg-blue-600 text-white font-medium'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              title={d.name}>
              {DEVICE_ICON[d.type] || '🖥'} {d.name}
            </button>
          ))}
        </div>
      )}

      {/* 全部设备：各端占比饼图 */}
      {filterId === 'all' && hasDevices && (
        <DeviceSharePies devices={devices} range={range} />
      )}

      {/* 工具来源 */}
      {agent_sources?.length > 0 && (
        <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">应用用量分布</h2>
            <span className="text-xs text-gray-400">{scopeLabel} · {range}</span>
          </div>
          <DistBarList
            items={agent_sources.map(s => ({
              key: s.source,
              label: sourceLabel(s.source),
              title: s.source,
              calls: s.calls,
            }))}
            total={total_calls}
            barClass="bg-emerald-400"
          />
        </section>
      )}

      {/* 供给来源 */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">供给来源分布</h2>
          <span className="text-xs text-gray-400">{scopeLabel} · {range}</span>
        </div>
        {providerEntries.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">暂无数据</p>
        ) : (
          <div className="space-y-2.5">
            {providerEntries.map(p => (
              <ProviderBar key={p.id} id={p.id} calls={p.calls} totalCalls={total_calls} tier={p.tier} />
            ))}
          </div>
        )}
      </section>

      {/* 模型使用 */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">模型使用分布</h2>
          <span className="text-xs text-gray-400">{scopeLabel} · {range}</span>
        </div>
        {modelList.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">暂无数据</p>
        ) : (
          <DistBarList
            items={modelList.slice(0, 8).map(m => ({
              key: m.model,
              label: m.model,
              title: m.model,
              calls: m.calls,
              mono: true,
            }))}
            total={total_calls}
            barClass="bg-blue-400"
          />
        )}
      </section>
    </div>
  );
}

/** 通用横向分布条 */
function DistBarList({ items, total, barClass }) {
  const maxCalls = Math.max(...items.map(i => i.calls), 1);
  return (
    <div className="space-y-2.5">
      {items.map(item => {
        const barPct = Math.round(item.calls / maxCalls * 100);
        const share  = total > 0 ? Math.round(item.calls / total * 100) : 0;
        return (
          <div key={item.key} className="flex items-center gap-3 text-sm">
            <div
              className={`w-36 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate ${item.mono ? 'font-mono' : ''}`}
              title={item.title || item.label}
            >
              {item.label}
            </div>
            <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
              <div className={`h-2 rounded-full ${barClass} transition-all duration-500`} style={{ width: `${barPct}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
              {item.calls} <span className="text-gray-400">({share}%)</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── 我的设备（简洁列表）────────────────────────────────────────────────────
function DevicesSection() {
  const [devices, setDevices] = useState(null);

  useEffect(() => {
    getUserDevices()
      .then(r => {
        const raw = r.data?.devices || [];
        const normalised = raw.map(d => ({ ...d, device_id: d.device_id || d.id || null }));
        const seen = new Set();
        const clean = normalised.filter(d => {
          if (!d.device_id || seen.has(d.device_id)) return false;
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

  if (devices === null) return null;
  if (devices.length === 0) return null;

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">我的设备</h2>
      <div className="space-y-2">
        {devices.map((d, i) => (
          <div key={`${d.device_id ?? ''}-${i}`}
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
  const [localData,   setLocalData]  = useState(null);
  const [dataSource,  setDataSource]  = useState('cloud');
  const [deviceList,  setDeviceList]  = useState([]);
  const [distFilter,  setDistFilter]  = useState('all');
  useEffect(() => {
    refreshUser();
    getTransactions().then(r => setTxs(r.data.transactions || [])).catch(() => {});
    getPurchaseOrders().then(r => { setOrders(r.data.orders || []); if (r.data.contact_info) setAdminInfo(String(r.data.contact_info)); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const days = RANGE_DAYS[range];
    fetchDashboardStats(days).then(data => {
      setLocalData(data);
      setDataSource(data.source || 'cloud');
      setRangeStats({
        calls:  data.total_calls  || 0,
        tokens: data.total_tokens || 0,
        free:   data.tiers?.free  || 0,
        p2p:    data.tiers?.p2p   || 0,
        paid:   data.tiers?.paid  || 0,
      });
      setDeviceList(data.devices || []);
      setDistFilter('all');
    }).catch(() => {});
  }, [range]);

  if (!user) return null;

  const heroTotal   = rangeStats.calls;
  const heroFree    = rangeStats.free;

  const localTotalCalls = localData?.total_calls ?? 0;

  const fmtRangeCalls  = heroTotal >= 1000 ? `${(heroTotal / 1000).toFixed(1)}K` : String(heroTotal);
  const fmtRangeTokens = rangeStats.tokens >= 1000 ? `${(rangeStats.tokens / 1000).toFixed(1)}K` : String(rangeStats.tokens);
  const deviceCount    = localData?.device_count ?? localData?.devices?.length ?? 0;
  const onlineCount    = (localData?.devices || []).filter(d => d.online).length;

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
            {heroTotal > 0 && (
              <p className="text-xs text-blue-300 mt-2">
                {heroFree} 免费（{Math.round(heroFree / heroTotal * 100)}%）·{' '}
                {rangeStats.p2p} 积分 · {rangeStats.paid} 付费
              </p>
            )}
            {deviceCount > 0 && (
              <p className="text-[10px] text-blue-300/80 mt-1">
                {deviceCount} 台设备{onlineCount > 0 ? ` · ${onlineCount} 在线` : ''}
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
            {localData?.total_cost > 0 && (
              <p className="text-[10px] text-blue-300/80 mt-0.5">API 刊例价；订阅类为等效价，非实际账单</p>
            )}
            <p className="text-xs text-blue-300 mt-1">
              {dataSource === 'cloud'
                ? `各设备 ${range} 合计（云端）`
                : `本机 ${range}（云端暂无上报）`}
            </p>
          </div>
        </div>
      </div>

      {/* 我的设备 */}
      <DevicesSection />

      {/* 三类账户：积分 / 订阅 / 按量付费 */}
      <UserAccountsPanel
        user={user}
        txs={txs}
        creditsOpen={creditsOpen}
        onCreditsToggle={() => setCreditsOpen(v => !v)}
        onRefreshUser={refreshUser}
        CheckinCard={CheckinCard}
        SpinCard={SpinCard}
        purchaseForm={(
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
        )}
      />

      {/* 用量分布：工具 / 供给 / 模型（可按端筛选） */}
      <UsageDistributionPanel
        localData={localData}
        devices={deviceList.length ? deviceList : localData?.devices}
        range={range}
        filterId={distFilter}
        onFilterChange={setDistFilter}
      />


    </div>
  );
}

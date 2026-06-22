import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store/index';
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder, spin, getSpinStatus, getRates, getUserDevices, deleteDevice } from '../api/client';
import { getServerUrl } from '../config';
import BillingConfigSection from '../components/BillingConfigSection';
import { formatDeviceTitle, formatDeviceSubtitle } from '../lib/device-display';

const TX_LABEL = {
  contribute: '贡献',
  consume: '消耗',
  referral: '推荐',
  purchase: '充值',
  adjust: '调整',
  spin: '转盘抽奖',
};

const ORDER_STATUS = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
};

function StatCard({ label, value }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}


function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={handleCopy}
      className="shrink-0 text-xs px-3 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
      {copied ? '已复制 ✓' : '复制'}
    </button>
  );
}

function ReferralSection({ referralCode }) {
  const serverUrl = getServerUrl();
  const link = referralCode ? `${serverUrl}/app?ref=${referralCode}` : '';
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">推荐分享</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        分享推荐码给好友，好友注册后你们双方均可获得奖励积分。
      </p>
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">我的推荐码</p>
            <p className="font-mono text-xl font-bold text-gray-900 dark:text-gray-100 tracking-widest">
              {referralCode || '—'}
            </p>
          </div>
          {referralCode && <CopyButton text={referralCode} />}
        </div>
        {link && (
          <div className="flex items-center gap-3 pt-2 border-t border-gray-100 dark:border-gray-700">
            <p className="flex-1 text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{link}</p>
            <CopyButton text={link} />
          </div>
        )}
      </div>
    </section>
  );
}

function ContributeSection() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRates()
      .then((r) => setModels(r.data.models ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-5 py-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-2xl select-none">💡</span>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200">贡献得积分</h2>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
        在本机运行 Worker，接入网络后台自动结算。每生成 <span className="font-medium text-gray-700 dark:text-gray-300">1000 个输出 Token</span>，
        即可获得对应模型的贡献积分；积分可用于消耗其他模型的 API 调用。
      </p>

      {loading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">加载中…</p>
      ) : models.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">暂无已启用的模型</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-100 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400 text-xs">
                <th className="text-left px-4 py-2 font-medium">模型</th>
                <th className="text-right px-4 py-2 font-medium">贡献积分 / 千 tokens</th>
                <th className="text-right px-4 py-2 font-medium">消耗积分 / 千 tokens</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {models.map((m) => (
                <tr key={m.name} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                  <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 truncate max-w-[160px]">
                    {m.display_name || m.name}
                  </td>
                  <td className="px-4 py-2.5 text-right text-green-600 dark:text-green-400 font-medium">
                    +{m.contribute_rate}
                  </td>
                  <td className="px-4 py-2.5 text-right text-red-500 dark:text-red-400 font-medium">
                    -{m.consume_rate}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 与网页版 app.html「购买积分」一致：说明、联系方式、提交申请、历史记录 */
function PurchaseSection() {
  const [orders, setOrders] = useState([]);
  const [adminInfo, setAdminInfo] = useState('');
  const [loading, setLoading] = useState(true);
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);

  const load = () => {
    setLoading(true);
    getPurchaseOrders()
      .then((r) => {
        setOrders(r.data.orders || []);
        if (r.data.contact_info) setAdminInfo(String(r.data.contact_info));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!contact.trim()) return;
    setSubmitting(true);
    setMsg('');
    try {
      const r = await createPurchaseOrder(0, `联系方式：${contact.trim()}${note.trim() ? `；${note.trim()}` : ''}`);
      setMsgOk(true);
      setMsg('申请已提交，管理员将与你联系确定积分额度。');
      if (r.data.contact_info) setAdminInfo(String(r.data.contact_info));
      setOrders((prev) => [r.data.order, ...prev]);
      setContact('');
      setNote('');
    } catch (err) {
      setMsgOk(false);
      setMsg(err.response?.data?.detail || '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">直接申领积分</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        提交申请后，并填写联系方式，管理员将与你联系确定积分额度。
      </p>

      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4 space-y-3">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              联系方式 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="手机 / 微信 / 邮箱"
              required
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">备注（可选）</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="期望积分数量或其他说明"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !contact.trim()}
            className="w-full py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-50 text-white transition-colors"
          >
            {submitting ? '提交中…' : '提交申领'}
          </button>
        </form>

        {msg && (
          <p className={`text-sm ${msgOk ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
            {msg}
          </p>
        )}

        {adminInfo && (
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">管理员附加信息</p>
            <div className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap bg-gray-50 dark:bg-gray-900/50 border border-gray-100 dark:border-gray-700 rounded-lg px-3 py-2">
              {adminInfo}
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">我的申领记录</h3>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        {loading && orders.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">加载中…</p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">暂无申领记录</p>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <div
                key={o.id}
                className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="text-gray-500 dark:text-gray-400 text-xs">{o.created_at?.slice(0, 19)?.replace('T', ' ')}</span>
                  {o.amount_credits > 0 && (
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{o.amount_credits} 积分</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      o.status === 'approved'
                        ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                        : o.status === 'rejected'
                          ? 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                          : 'bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200'
                    }`}
                  >
                    {ORDER_STATUS[o.status] || o.status}
                  </span>
                </div>
                {(o.note || o.admin_note) && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 space-y-0.5">
                    {o.note ? <span className="block">{o.note}</span> : null}
                    {o.admin_note ? <span className="block text-blue-600 dark:text-blue-400">管理员：{o.admin_note}</span> : null}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// Fixed prize values — prob must sum to 1
const PRIZES = [
  { value: 1,  prob: 0.25, color: '#3b82f6', light: false },
  { value: 3,  prob: 0.25, color: '#60a5fa', light: false },
  { value: 5,  prob: 0.20, color: '#93c5fd', light: false },
  { value: 15, prob: 0.15, color: '#bfdbfe', light: true  },
  { value: 25, prob: 0.10, color: '#dbeafe', light: true  },
  { value: 50, prob: 0.05, color: '#eff6ff', light: true  },
];

// Precompute segment geometry once (static)
const WHEEL_SEGMENTS = (() => {
  let acc = 0;
  return PRIZES.map((p) => {
    const start = acc;
    acc += p.prob * 360;
    const end = acc;
    const midRad = ((start + end) / 2) * (Math.PI / 180);
    return { ...p, start, end, lx: 50 + 32 * Math.sin(midRad), ly: 50 - 32 * Math.cos(midRad) };
  });
})();
const WHEEL_BG = `conic-gradient(${WHEEL_SEGMENTS.map((s) => `${s.color} ${s.start}deg ${s.end}deg`).join(', ')})`;


function CheckinCard({ onSuccess }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getCheckinStatus().then((r) => setStatus(r.data)).catch(() => {});
  }, []);

  async function handleCheckin() {
    setChecking(true);
    setMsg('');
    try {
      const r = await checkin();
      setMsg(`+${r.data.credits} 积分`);
      setStatus((s) => ({ ...s, checked_in_today: true, credits_today: r.data.credits, total_checkins: (s?.total_checkins || 0) + 1 }));
      onSuccess?.();
    } catch (e) {
      setMsg(e.response?.data?.detail || '签到失败');
    } finally {
      setChecking(false);
    }
  }

  const done = status?.checked_in_today;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-2xl select-none">📅</span>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日签到</p>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500 min-h-[2.5rem]">
        {status === null ? '加载中…'
          : done ? `今日已签到\n+${status.credits_today} 积分`
          : `签到得 ${status.reward} 积分\n累计 ${status.total_checkins} 天`}
      </p>
      {msg && (
        <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
          {msg}
        </span>
      )}
      <button
        onClick={handleCheckin}
        disabled={checking || done}
        className={`w-full py-1.5 rounded-lg text-sm font-medium transition-colors ${
          done
            ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-default'
            : 'bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white'
        } disabled:opacity-60`}
      >
        {checking ? '签到中…' : done ? '已签到 ✓' : '签到'}
      </button>
    </div>
  );
}

function SpinCard({ onSuccess }) {
  const [status, setStatus] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState('');
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    getSpinStatus().then((r) => setStatus(r.data)).catch(() => {});
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  async function handleSpin() {
    if (spinning || status?.spins_left === 0) return;
    setExpanded(true);
    setSpinning(true);
    setMsg('');
    setResult(null);
    let credits = null;
    try {
      const r = await spin();
      credits = r.data.credits;
      setStatus((s) => ({ ...s, spins_used: r.data.spins_used, spins_left: r.data.spins_left }));
    } catch (e) {
      setMsg(e.response?.data?.detail || '抽奖失败');
      setSpinning(false);
      return;
    }
    // Find the winning segment and compute the rotation that places it under the pointer (top, 0°).
    // After rotating the wheel by R degrees, a segment at angle θ from origin appears at (θ+R)%360.
    // We want (mid + R) % 360 === 0  →  R_target = (360 - mid % 360) % 360.
    const seg = WHEEL_SEGMENTS.find((s) => s.value === credits) ?? WHEEL_SEGMENTS[0];
    const mid = (seg.start + seg.end) / 2;
    // Small random jitter within the segment so it doesn't always land dead-center.
    const jitter = (Math.random() - 0.5) * (seg.end - seg.start) * 0.6;
    const targetMod = (360 - ((mid + jitter) % 360) + 360) % 360;
    const extraSpins = 3 + Math.floor(Math.random() * 3);
    setRotation((prev) => {
      const currentMod = ((prev % 360) + 360) % 360;
      const delta = (targetMod - currentMod + 360) % 360;
      return prev + extraSpins * 360 + delta;
    });
    timerRef.current = setTimeout(() => {
      setResult(credits);
      setMsg(`+${credits} 积分`);
      setSpinning(false);
      onSuccess?.();
    }, 2600);
  }

  const exhausted = status?.spins_left === 0;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl select-none">🎡</span>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日转盘</p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors text-xs w-6 text-center select-none"
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500 min-h-[2.5rem]">
        {status === null ? '加载中…'
          : exhausted ? '今日次数已用完'
          : `今日剩余 ${status.spins_left} 次\n已用 ${status.spins_used}/${status.daily_limit ?? '?'} 次`}
      </p>
      {msg && (
        <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
          {msg}
        </span>
      )}
      <button
        onClick={handleSpin}
        disabled={spinning || exhausted || status === null}
        className={`w-full py-1.5 rounded-lg text-sm font-medium transition-colors ${
          exhausted
            ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-default'
            : spinning
            ? 'bg-blue-400 text-white cursor-wait'
            : 'bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white'
        } disabled:opacity-60`}
      >
        {spinning ? '抽奖中…' : exhausted ? '明日再来' : '抽奖'}
      </button>

      {expanded && (
        <div className="flex flex-col items-center gap-2 pt-1">
          <div className="relative w-36 h-36">
            {/* Fixed pointer */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 z-10 text-base select-none">▼</div>
            {/* Spinning wheel */}
            <div
              className="w-36 h-36 rounded-full border-4 border-blue-600 dark:border-blue-500"
              style={{
                transform: `rotate(${rotation}deg)`,
                transition: spinning ? 'transform 2.5s cubic-bezier(0.17,0.67,0.12,0.99)' : 'none',
                background: WHEEL_BG,
                position: 'relative',
              }}
            >
              {/* Labels positioned by x/y — rotate with wheel, staying in their sector */}
              {WHEEL_SEGMENTS.map((s) => (
                <span
                  key={s.value}
                  style={{
                    position: 'absolute',
                    left: `${s.lx}%`,
                    top: `${s.ly}%`,
                    transform: 'translate(-50%, -50%)',
                    fontSize: s.prob < 0.08 ? '8px' : '10px',
                    fontWeight: 'bold',
                    color: s.light ? '#1e3a8a' : 'white',
                    textShadow: s.light ? 'none' : '0 1px 2px rgba(0,0,0,0.35)',
                    userSelect: 'none',
                    pointerEvents: 'none',
                  }}
                >
                  {s.value}
                </span>
              ))}
            </div>
            {/* Center hub — non-rotating */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-white dark:bg-gray-900 flex items-center justify-center shadow">
                <span className="text-sm font-bold text-blue-700 dark:text-blue-300 select-none">
                  {result !== null ? result : '?'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DEVICE_ICON    = { desktop: '💻', cli: '🖥' };

function DeviceStatBar({ calls, errors }) {
  const total    = Math.max(calls, 1);
  const okPct    = Math.max(0, ((calls - errors) / total) * 100);
  const errPct   = Math.min(100, (errors / total) * 100);
  const errorRate = calls > 0 ? ((errors / calls) * 100).toFixed(1) : '0';
  return (
    <div className="space-y-1">
      <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700 w-full">
        <div className="bg-blue-400 h-full transition-all" style={{ width: `${okPct}%` }} />
        {errors > 0 && <div className="bg-red-400 h-full transition-all" style={{ width: `${errPct}%` }} />}
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block"/>成功 {calls - errors}</span>
        {errors > 0 && <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block"/>错误 {errors}（{errorRate}%）</span>}
      </div>
    </div>
  );
}

function DevicesSection() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(null);

  const load = () => {
    setLoading(true);
    getUserDevices()
      .then(r => {
        const raw = r.data?.devices || [];
        const normalised = raw.map(d => ({ ...d, device_id: d.device_id || d.id || null }));
        const seen = new Set();
        setDevices(normalised.filter(d => {
          if (!d.device_id) return false;
          if (seen.has(d.device_id)) return false;
          seen.add(d.device_id);
          return true;
        }));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  async function handleRemove(deviceId) {
    if (!confirm('移除此设备？')) return;
    setRemoving(deviceId);
    try {
      await deleteDevice(deviceId);
      setDevices(ds => ds.filter(d => d.device_id !== deviceId));
    } catch {
      alert('移除失败');
    } finally { setRemoving(null); }
  }

  // totals across all devices for the relative bar scale
  const maxCalls = Math.max(...devices.map(d => d.today_calls || 0), 1);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">设备统计</h2>
        <button onClick={load} disabled={loading}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {loading && devices.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">加载中…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">暂无设备记录</p>
      ) : (
        <div className="space-y-3">
          {devices.map((d, i) => {
            const calls  = d.today_calls  ?? 0;
            const errors = d.today_errors ?? 0;
            const providers = d.providers_active ?? d.today_providers ?? 0;
            const sharePct  = Math.round((calls / maxCalls) * 100);
            const lastSeen  = d.last_seen || d.last_heartbeat || null;

            return (
              <div key={`${d.device_id ?? ''}-${i}`}
                className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4 space-y-3">

                {/* Header row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-lg shrink-0 select-none">{DEVICE_ICON[d.type] || '🖥'}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{formatDeviceTitle(d)}</span>
                        <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
                          d.online
                            ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${d.online ? 'bg-green-500' : 'bg-gray-400'}`}/>
                          {d.online ? '在线' : '离线'}
                        </span>
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5 truncate">
                        {formatDeviceSubtitle(d, {
                          lastSeen: lastSeen
                            ? new Date(lastSeen).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
                            : '',
                        })}
                      </div>
                    </div>
                  </div>
                  {!d.online && (
                    <button onClick={() => handleRemove(d.device_id)} disabled={removing === d.device_id}
                      className="text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50 shrink-0 mt-0.5">
                      {removing === d.device_id ? '移除中…' : '移除'}
                    </button>
                  )}
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="bg-gray-50 dark:bg-gray-900 rounded-lg py-2">
                    <div className="text-base font-bold text-gray-800 dark:text-gray-100">{calls}</div>
                    <div className="text-xs text-gray-400 mt-0.5">今日调用</div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-900 rounded-lg py-2">
                    <div className={`text-base font-bold ${errors > 0 ? 'text-red-500' : 'text-gray-800 dark:text-gray-100'}`}>{errors}</div>
                    <div className="text-xs text-gray-400 mt-0.5">错误次数</div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-900 rounded-lg py-2">
                    <div className="text-base font-bold text-gray-800 dark:text-gray-100">{providers || '—'}</div>
                    <div className="text-xs text-gray-400 mt-0.5">活跃供应商</div>
                  </div>
                </div>

                {/* Call share bar across devices */}
                {calls > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-gray-400">
                      <span>今日占比</span>
                      <span>{sharePct}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-400 rounded-full transition-all" style={{ width: `${sharePct}%` }} />
                    </div>
                    <DeviceStatBar calls={calls} errors={errors} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function Profile() {
  const { user, refreshUser } = useAuth();
  const [txs, setTxs] = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(true);
  const [txError, setTxError] = useState(false);
  const [gatewayStats, setGatewayStats] = useState(null);

  useEffect(() => {
    refreshUser();
    getTransactions()
      .then((r) => setTxs(r.data.transactions || []))
      .catch(() => { setTxError(true); })
      .finally(() => setLoadingTxs(false));
    // Fetch today's gateway stats for accurate today totals
    if (window.electronAPI?.localStats) {
      window.electronAPI.localStats.query(1).then(setGatewayStats).catch(() => {});
    } else {
      fetch('/api/local-stats?days=1').then(r => r.json()).then(setGatewayStats).catch(() => {});
    }
  }, []);

  const totalTokensConsumed = txs
    .filter(t => t.type === 'consume')
    .reduce((a, t) => a + (t.tokens || 0), 0);
  const fmtTokensConsumed = totalTokensConsumed >= 1000
    ? `${(totalTokensConsumed / 1000).toFixed(1)}K`
    : String(totalTokensConsumed);

  // Today's gateway stats (covers all calls including non-scene-route)
  const gwCalls  = gatewayStats?.total_calls  ?? 0;
  const gwTokens = gatewayStats?.total_tokens ?? 0;
  const fmtGwTokens = gwTokens >= 1000 ? `${(gwTokens / 1000).toFixed(1)}K` : String(gwTokens);

  if (!user) return null;

  return (
    <div className="px-5 py-5 space-y-5">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-blue-700 flex items-center justify-center text-2xl font-bold text-white shrink-0">
          {(user.nickname || user.email || '?')[0].toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-xl font-bold text-gray-900 dark:text-gray-100 truncate">{user.nickname}</p>
          <p className="text-sm text-gray-400 dark:text-gray-400 truncate">{user.email}</p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-blue-700 to-blue-900 rounded-2xl p-6">
        <p className="text-sm text-blue-300 mb-1">积分余额</p>
        <p className="text-5xl font-bold text-white">
          {Math.floor(user.credits_balance ?? 0).toLocaleString()}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="累计贡献积分" value={Math.floor(user.credits_earned ?? 0).toLocaleString()} />
        <StatCard label="累计消耗积分" value={Math.floor(user.credits_spent ?? 0).toLocaleString()} />
        <StatCard label="累计消耗 Token" value={fmtTokensConsumed} />
      </div>

      {gwCalls > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4 flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-green-500 shrink-0"/>
            <div>
              <p className="text-xs text-gray-400 dark:text-gray-500">今日网关调用</p>
              <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{gwCalls} 次</p>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4 flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-purple-500 shrink-0"/>
            <div>
              <p className="text-xs text-gray-400 dark:text-gray-500">今日网关 Token</p>
              <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{fmtGwTokens}</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 items-start">
        <CheckinCard onSuccess={refreshUser} />
        <SpinCard onSuccess={refreshUser} />
      </div>

      <BillingConfigSection />

      <ContributeSection />

      <PurchaseSection />

      <ReferralSection referralCode={user.referral_code} />

      <DevicesSection />

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">积分流水</h2>
        {loadingTxs ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">加载中…</p>
        ) : txError ? (
          <p className="text-red-500 dark:text-red-400 text-sm">加载失败，请刷新重试</p>
        ) : txs.length === 0 ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">暂无记录</p>
        ) : (
          <div className="space-y-2">
            {txs.map((tx) => (
              <div key={tx.id}
                className="flex items-center justify-between bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {TX_LABEL[tx.type] || tx.type}
                    {tx.model_name ? ` · ${tx.model_name}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">{tx.created_at?.slice(0, 16)}</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-medium ${(tx.delta ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                    {(tx.delta ?? 0) >= 0 ? '+' : ''}{(tx.delta ?? 0).toFixed(1)}
                  </p>
                  {tx.type === 'consume' && tx.tokens > 0 && (
                    <p className="text-xs text-purple-500 dark:text-purple-400">
                      {tx.tokens >= 1000 ? `${(tx.tokens / 1000).toFixed(1)}K` : tx.tokens} tok
                    </p>
                  )}
                  <p className="text-xs text-gray-400 dark:text-gray-500">余额 {(tx.balance ?? 0).toFixed(1)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store/index';
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder, spin, getSpinStatus } from '../api/client';
import { getServerUrl } from '../config';

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

/** 与网页版 app.html「购买积分」一致：说明、联系方式、提交申请、历史记录 */
function PurchaseSection() {
  const [orders, setOrders] = useState([]);
  const [contactInfo, setContactInfo] = useState('');
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);

  const load = () => {
    setLoading(true);
    getPurchaseOrders()
      .then((r) => {
        setOrders(r.data.orders || []);
        if (r.data.contact_info) setContactInfo(String(r.data.contact_info));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    const n = Number(amount);
    if (!n || n <= 0) return;
    setSubmitting(true);
    setMsg('');
    try {
      const r = await createPurchaseOrder(n, note.trim());
      setMsgOk(true);
      setMsg('申请已提交，请按下方联系方式完成付款，管理员确认后自动充值。');
      if (r.data.contact_info) setContactInfo(String(r.data.contact_info));
      setOrders((prev) => [r.data.order, ...prev]);
      setAmount('');
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
      <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">购买积分</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        提交申请后，请按下方联系方式完成线下付款；管理员审核通过后会自动充值并视情况开通 API Key 创建权限。
      </p>

      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4 space-y-4">
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row sm:flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[120px]">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">积分数量</label>
            <input
              type="number"
              min={1}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="例如 500"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex-[2] min-w-[160px]">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">备注（可选）</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="支付方式 / 金额说明"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !amount || Number(amount) <= 0}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors whitespace-nowrap"
          >
            {submitting ? '提交中…' : '提交购买申请'}
          </button>
        </form>

        {msg && (
          <p className={`text-sm ${msgOk ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
            {msg}
          </p>
        )}

        <div>
          <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">联系方式（付款信息）</p>
          {contactInfo ? (
            <div className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap bg-gray-50 dark:bg-gray-900/50 border border-gray-100 dark:border-gray-700 rounded-lg px-3 py-2">
              {contactInfo}
            </div>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500">管理员暂未配置联系方式，请稍后再试或联系运营。</p>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">我的购买记录</h3>
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
          <p className="text-sm text-gray-400 dark:text-gray-500">暂无购买记录</p>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <div
                key={o.id}
                className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="text-gray-500 dark:text-gray-400 text-xs">{o.created_at?.slice(0, 19)?.replace('T', ' ')}</span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{o.amount_credits} 积分</span>
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
                    {o.note ? <span className="block">备注：{o.note}</span> : null}
                    {o.admin_note ? <span className="block">管理员：{o.admin_note}</span> : null}
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

const WHEEL_SEGMENTS = [
  { label: '0-5',   angle: 30,  light: false },
  { label: '6-10',  angle: 90,  light: false },
  { label: '11-20', angle: 150, light: true  },
  { label: '21-30', angle: 210, light: true  },
  { label: '31-40', angle: 270, light: true  },
  { label: '41-50', angle: 330, light: true  },
];

function DailyCard({ onSuccess }) {
  // checkin state
  const [checkinStatus, setCheckinStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkinMsg, setCheckinMsg] = useState('');
  // spin state
  const [spinStatus, setSpinStatus] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [result, setResult] = useState(null);
  const [spinMsg, setSpinMsg] = useState('');
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    getCheckinStatus().then((r) => setCheckinStatus(r.data)).catch(() => {});
    getSpinStatus().then((r) => setSpinStatus(r.data)).catch(() => {});
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  async function handleCheckin() {
    setChecking(true);
    setCheckinMsg('');
    try {
      const r = await checkin();
      setCheckinMsg(`+${r.data.credits} 积分`);
      setCheckinStatus((s) => ({ ...s, checked_in_today: true, credits_today: r.data.credits, total_checkins: (s?.total_checkins || 0) + 1 }));
      onSuccess?.();
    } catch (e) {
      setCheckinMsg(e.response?.data?.detail || '签到失败');
    } finally {
      setChecking(false);
    }
  }

  async function handleSpin() {
    if (spinning || spinStatus?.spins_left === 0) return;
    setExpanded(true);
    setSpinning(true);
    setSpinMsg('');
    setResult(null);
    let credits = null;
    try {
      const r = await spin();
      credits = r.data.credits;
      setSpinStatus((s) => ({ ...s, spins_used: r.data.spins_used, spins_left: r.data.spins_left }));
    } catch (e) {
      setSpinMsg(e.response?.data?.detail || '抽奖失败');
      setSpinning(false);
      return;
    }
    const extraSpins = 3 + Math.floor(Math.random() * 3);
    setRotation((prev) => prev + extraSpins * 360 + Math.floor(Math.random() * 360));
    timerRef.current = setTimeout(() => {
      setResult(credits);
      setSpinMsg(`+${credits} 积分`);
      setSpinning(false);
      onSuccess?.();
    }, 2600);
  }

  const checkinDone = checkinStatus?.checked_in_today;
  const spinExhausted = spinStatus?.spins_left === 0;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-5 py-4 space-y-3">
      {/* 签到行 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl select-none">📅</span>
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日签到</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {checkinStatus === null ? '加载中…'
                : checkinDone ? `今日已签到，+${checkinStatus.credits_today} 积分`
                : `签到得 ${checkinStatus.reward} 积分 · 累计 ${checkinStatus.total_checkins} 天`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {checkinMsg && (
            <span className={`text-xs font-medium ${checkinMsg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
              {checkinMsg}
            </span>
          )}
          <button
            onClick={handleCheckin}
            disabled={checking || checkinDone}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              checkinDone
                ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-default'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            } disabled:opacity-60`}
          >
            {checking ? '签到中…' : checkinDone ? '已签到 ✓' : '签到'}
          </button>
        </div>
      </div>

      <div className="border-t border-gray-100 dark:border-gray-700" />

      {/* 抽奖行 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl select-none">🎡</span>
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日转盘</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {spinStatus === null ? '加载中…'
                : spinExhausted ? '今日次数已用完'
                : `今日剩余 ${spinStatus.spins_left} 次`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {spinMsg && (
            <span className={`text-xs font-medium ${spinMsg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
              {spinMsg}
            </span>
          )}
          <button
            onClick={handleSpin}
            disabled={spinning || spinExhausted || spinStatus === null}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              spinExhausted
                ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-default'
                : spinning
                ? 'bg-blue-400 text-white cursor-wait'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            } disabled:opacity-60`}
          >
            {spinning ? '抽奖中…' : spinExhausted ? '明日再来' : '抽奖'}
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors text-xs w-6 text-center select-none"
            aria-label={expanded ? '收起' : '展开'}
          >
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* 可展开的转盘 */}
      {expanded && (
        <div className="flex flex-col items-center gap-3 pt-2">
          <div className="relative w-44 h-44">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 z-10 text-xl select-none">▼</div>
            <div
              className="relative w-44 h-44 rounded-full border-4 border-blue-600 dark:border-blue-500"
              style={{
                transform: `rotate(${rotation}deg)`,
                transition: spinning ? 'transform 2.5s cubic-bezier(0.17,0.67,0.12,0.99)' : 'none',
                background: 'conic-gradient(#3b82f6 0deg 60deg, #60a5fa 60deg 120deg, #93c5fd 120deg 180deg, #bfdbfe 180deg 240deg, #dbeafe 240deg 300deg, #eff6ff 300deg 360deg)',
              }}
            >
              {WHEEL_SEGMENTS.map(({ label, angle, light }) => (
                <div
                  key={label}
                  className="absolute inset-0 flex items-start justify-center pointer-events-none"
                  style={{ transform: `rotate(${angle}deg)` }}
                >
                  <span className={`text-[10px] font-bold select-none mt-7 ${light ? 'text-blue-800' : 'text-white drop-shadow'}`}>
                    {label}
                  </span>
                </div>
              ))}
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-14 h-14 rounded-full bg-white dark:bg-gray-900 flex items-center justify-center shadow">
                <span className="text-base font-bold text-blue-700 dark:text-blue-300 select-none">
                  {result !== null ? result : '?'}
                </span>
              </div>
            </div>
          </div>
          {spinStatus && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              已用 {spinStatus.spins_used}/{spinStatus.daily_limit ?? '?'} 次
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Profile() {
  const { user, refreshUser } = useAuth();
  const [txs, setTxs] = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(true);
  const [txError, setTxError] = useState(false);

  useEffect(() => {
    refreshUser();
    getTransactions()
      .then((r) => setTxs(r.data.transactions || []))
      .catch(() => { setTxError(true); })
      .finally(() => setLoadingTxs(false));
  }, []);

  if (!user) return null;

  return (
    <div className="p-8 space-y-8">
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

      <div className="grid grid-cols-2 gap-4">
        <StatCard label="累计贡献积分" value={Math.floor(user.credits_earned ?? 0).toLocaleString()} />
        <StatCard label="累计消耗积分" value={Math.floor(user.credits_spent ?? 0).toLocaleString()} />
      </div>

      <DailyCard onSuccess={refreshUser} />

      <PurchaseSection />

      <ReferralSection referralCode={user.referral_code} />

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

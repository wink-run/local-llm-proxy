import React, { useEffect, useState } from 'react';
import { useAuth } from '../store/index';
import { getTransactions, checkin, getCheckinStatus } from '../api/client';
import { getServerUrl } from '../config';

const TX_LABEL = {
  contribute: '贡献',
  consume: '消耗',
  referral: '推荐',
  purchase: '充值',
  adjust: '调整',
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

function CheckinCard({ onCheckinSuccess }) {
  const [status, setStatus] = useState(null);   // null while loading
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getCheckinStatus()
      .then((r) => setStatus(r.data))
      .catch(() => {});
  }, []);

  async function handleCheckin() {
    setChecking(true);
    setMsg('');
    try {
      const r = await checkin();
      setMsg(`+${r.data.credits} 积分`);
      setStatus((s) => ({ ...s, checked_in_today: true, credits_today: r.data.credits, total_checkins: (s?.total_checkins || 0) + 1 }));
      onCheckinSuccess?.();
    } catch (e) {
      setMsg(e.response?.data?.detail || '签到失败');
    } finally {
      setChecking(false);
    }
  }

  const done = status?.checked_in_today;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-5 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-2xl select-none">📅</span>
        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日签到</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {status === null ? '加载中…'
              : done ? `今日已签到，+${status.credits_today} 积分`
              : `签到得 ${status.reward} 积分 · 累计 ${status.total_checkins} 天`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {msg && (
          <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
            {msg}
          </span>
        )}
        <button
          onClick={handleCheckin}
          disabled={checking || done}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            done
              ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-default'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          } disabled:opacity-60`}
        >
          {checking ? '签到中…' : done ? '已签到 ✓' : '签到'}
        </button>
      </div>
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

      <CheckinCard onCheckinSuccess={refreshUser} />

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

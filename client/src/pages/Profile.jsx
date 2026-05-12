import React, { useEffect, useState } from 'react';
import { useAuth } from '../store/index';
import { getTransactions } from '../api/client';

const TX_LABEL = {
  contribute: '贡献',
  consume: '消耗',
  referral: '推荐',
  purchase: '充值',
  adjust: '调整',
};

function StatCard({ label, value }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-100">{value}</p>
    </div>
  );
}

export default function Profile() {
  const { user, refreshUser } = useAuth();
  const [txs, setTxs] = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(true);

  useEffect(() => {
    refreshUser();
    getTransactions()
      .then((r) => setTxs(r.data.transactions || []))
      .catch(() => {})
      .finally(() => setLoadingTxs(false));
  }, []);

  if (!user) return null;

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-blue-700 flex items-center justify-center text-2xl font-bold shrink-0">
          {(user.nickname || user.email)[0].toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-xl font-bold text-gray-100 truncate">{user.nickname}</p>
          <p className="text-sm text-gray-400 truncate">{user.email}</p>
        </div>
      </div>

      {/* Balance */}
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 rounded-2xl p-6">
        <p className="text-sm text-blue-300 mb-1">积分余额</p>
        <p className="text-5xl font-bold text-white">
          {Math.floor(user.credits_balance).toLocaleString()}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="累计贡献积分" value={Math.floor(user.credits_earned).toLocaleString()} />
        <StatCard label="累计消耗积分" value={Math.floor(user.credits_spent).toLocaleString()} />
      </div>

      {/* Transaction list */}
      <section>
        <h2 className="text-lg font-semibold text-gray-300 mb-3">积分流水</h2>
        {loadingTxs ? (
          <p className="text-gray-500 text-sm">加载中…</p>
        ) : txs.length === 0 ? (
          <p className="text-gray-500 text-sm">暂无记录</p>
        ) : (
          <div className="space-y-2">
            {txs.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-3"
              >
                <div>
                  <p className="text-sm text-gray-300">
                    {TX_LABEL[tx.type] || tx.type}
                    {tx.model_name ? ` · ${tx.model_name}` : ''}
                  </p>
                  <p className="text-xs text-gray-500">{tx.created_at?.slice(0, 16)}</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-medium ${tx.delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {tx.delta >= 0 ? '+' : ''}{tx.delta.toFixed(1)}
                  </p>
                  <p className="text-xs text-gray-500">余额 {tx.balance.toFixed(1)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

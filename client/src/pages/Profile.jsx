import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../store/index';
import { getTransactions, listKeys, createKey, toggleKey, deleteKey } from '../api/client';

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

function ApiKeysSection({ canCreate }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState('');

  const load = useCallback(() => {
    listKeys()
      .then((r) => setKeys(r.data.keys || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (canCreate) load(); else setLoading(false); }, [canCreate, load]);

  async function handleCreate() {
    setCreating(true);
    setNewKey('');
    try {
      const r = await createKey(note.trim());
      setNewKey(r.data.key);
      setNote('');
      load();
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(k) {
    await toggleKey(k.id, !k.is_active).catch(() => {});
    load();
  }

  async function handleDelete(k) {
    if (!window.confirm(`删除 Key ${k.key?.slice(0, 12)}…？`)) return;
    await deleteKey(k.id).catch(() => {});
    load();
  }

  if (!canCreate) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">API Key</h2>
        <p className="text-sm text-gray-400 dark:text-gray-500">尚未开通 API Key 权限，请先购买积分。</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">API Key</h2>

      {/* Create form */}
      <div className="flex gap-2">
        <input
          value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选）"
          className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
        />
        <button onClick={handleCreate} disabled={creating}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors whitespace-nowrap">
          {creating ? '创建中…' : '创建'}
        </button>
      </div>

      {/* Newly created key — show once */}
      {newKey && (
        <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-xl px-4 py-3">
          <p className="text-xs text-green-600 dark:text-green-400 mb-1">Key 已创建，请立即复制保存，之后不再显示</p>
          <p className="font-mono text-sm text-green-800 dark:text-green-300 break-all select-all">{newKey}</p>
        </div>
      )}

      {/* Key list */}
      {loading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">加载中…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">暂无 API Key</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id}
              className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-gray-700 dark:text-gray-300 truncate">{k.key}</p>
                {k.note && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{k.note}</p>}
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${k.is_active ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>
                {k.is_active ? '启用' : '禁用'}
              </span>
              <button onClick={() => handleToggle(k)}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors">
                {k.is_active ? '禁用' : '启用'}
              </button>
              <button onClick={() => handleDelete(k)}
                className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors">
                删除
              </button>
            </div>
          ))}
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

      <ApiKeysSection canCreate={!!user.can_create_apikey} />

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

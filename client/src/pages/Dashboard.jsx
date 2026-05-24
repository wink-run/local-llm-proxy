import { useState, useEffect, useCallback } from 'react';
import { getDashboardStats, listKeys, createKey, deleteKey } from '../api/client';

const PERIOD_OPTIONS = [7, 30, 90];

export default function Dashboard() {
  const [stats, setStats] = useState([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [newKeyNote, setNewKeyNote] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getDashboardStats(days);
      setStats(res.data?.stats || []);
    } catch (e) {
      console.error('dashboard load', e);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

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
    if (!confirm('删除此 API Key？删除后无法恢复。')) return;
    try {
      await deleteKey(keyId);
      await load();
    } catch (e) {
      alert('删除失败');
    }
  };

  const totalTokens = stats.reduce((a, s) => a + (s.total_tokens || 0), 0);
  const totalCredits = stats.reduce((a, s) => a + (s.total_credits || 0), 0);
  const totalRequests = stats.reduce((a, s) => a + (s.request_count || 0), 0);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">盘点</h1>
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                days === d
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >{d} 天</button>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">总请求</div>
          <div className="text-2xl font-bold mt-1 text-gray-900 dark:text-gray-100">{totalRequests.toLocaleString()}</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">总 Token</div>
          <div className="text-2xl font-bold mt-1 text-gray-900 dark:text-gray-100">
            {totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3">
          <div className="text-xs text-gray-500">消耗积分</div>
          <div className="text-2xl font-bold text-amber-500 mt-1">{totalCredits.toFixed(1)}</div>
        </div>
      </div>

      {/* Per-key breakdown */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-200">各接入点用量</h2>
          <p className="text-xs text-gray-500 mt-0.5">近 {days} 天，按 API Key 分组</p>
        </div>
        {loading ? (
          <div className="px-5 py-8 text-xs text-gray-400 text-center">加载中…</div>
        ) : stats.length === 0 ? (
          <div className="px-5 py-8 text-xs text-gray-400 text-center">
            最近 {days} 天没有消费记录
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
            {stats.map(s => (
              <div key={s.key_id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                      {s.scene_name ? `${s.icon || '🔀'} ${s.scene_name}` : '🔑'}{' '}
                      <span className="font-normal">{s.app_name || s.note || '未命名'}</span>
                    </span>
                  </div>
                  <code className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">
                    {s.api_key?.slice(0, 10)}…
                  </code>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-gray-700 dark:text-gray-300">{s.request_count} 次</div>
                  <div className="text-[10px] text-gray-400">
                    {s.total_tokens >= 1000 ? `${(s.total_tokens / 1000).toFixed(1)}K` : s.total_tokens} tokens
                  </div>
                </div>
                <div className="text-right shrink-0 w-16">
                  <div className="text-xs text-amber-500 font-mono">-{s.total_credits.toFixed(1)}</div>
                  <div className="text-[10px] text-gray-400">积分</div>
                </div>
                <button
                  onClick={() => handleDeleteKey(s.key_id)}
                  className="text-[10px] text-gray-300 dark:text-gray-700 hover:text-red-400 transition-colors shrink-0"
                >删除</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create new key */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-200 mb-3">新建 API Key</h2>
        <div className="flex gap-2">
          <input
            value={newKeyNote}
            onChange={e => setNewKeyNote(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
            placeholder="备注，如 Claude Code / Cursor"
            className="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-400"
          />
          <button
            onClick={handleCreateKey}
            disabled={creating || !newKeyNote.trim()}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >{creating ? '创建中…' : '创建'}</button>
        </div>
        <p className="text-[10px] text-gray-400 mt-2">
          创建后，在「网关」页的「场景应用」中绑定路由规则
        </p>
      </div>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { getNetwork } from '../api/client';

function starsStr(n) {
  const clamped = Math.max(0, Math.min(5, n ?? 0));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

export default function Network() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function fetch_() {
      getNetwork()
        .then((r) => setData(r.data))
        .catch(() => { setData(null); })
        .finally(() => setLoading(false));
    }
    fetch_();
    const id = setInterval(fetch_, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">全球网络</h1>

      {loading ? (
        <p className="text-gray-500 text-sm">加载中…</p>
      ) : !data ? (
        <p className="text-gray-500 text-sm">无法连接到服务器</p>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">在线节点</p>
              <p className="text-3xl font-bold text-green-400">{data.summary.online_workers}</p>
            </div>
            <div className="bg-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">活跃用户</p>
              <p className="text-3xl font-bold text-blue-400">{data.summary.active_users}</p>
            </div>
          </div>

          {/* Worker list */}
          <section>
            <h2 className="text-lg font-semibold text-gray-300 mb-3">在线节点</h2>
            {data.workers.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无在线节点</p>
            ) : (
              <div className="space-y-2">
                {data.workers.map((w) => (
                  <div
                    key={w.worker_id ?? w.name}
                    className="bg-gray-800 rounded-xl px-4 py-3 grid grid-cols-4 gap-3 items-center text-sm"
                  >
                    <div className="min-w-0">
                      <p className="text-gray-100 font-medium truncate">{w.name}</p>
                      <p className="text-gray-500 text-xs">{Math.round(w.online_mins ?? 0)} min</p>
                    </div>
                    <p className="text-gray-400 text-xs truncate">{(w.models ?? []).join(', ')}</p>
                    <p className="text-yellow-400 text-xs">{starsStr(w.stars ?? 3)}</p>
                    <div className="text-right">
                      <p className="text-gray-300">{(w.period_tokens ?? 0).toLocaleString()} tok</p>
                      <p className="text-gray-500 text-xs">{w.avg_latency_ms ?? 0} ms</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

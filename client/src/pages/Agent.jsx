import React, { useEffect, useState, useRef } from 'react';
import { getStats, getSettlements } from '../api/client';
import RateChart from '../components/RateChart';

function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export default function Agent() {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [logs, setLogs] = useState([]);
  const logRef = useRef(null);

  // Subscribe to agent status + log events from Electron main process
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.agent.getStatus().then(({ running: r }) => setRunning(r));
    const disposeStatus = window.electronAPI.agent.onStatus(({ running: r }) => setRunning(r));
    const disposeLog = window.electronAPI.agent.onLog((line) =>
      setLogs((prev) => [...prev.slice(-99), line.trimEnd()])
    );
    return () => {
      disposeStatus?.();
      disposeLog?.();
    };
  }, []);

  // Auto-scroll log tail
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Poll /user/stats every 15 s; append point to chart (keep last 30 points)
  useEffect(() => {
    function poll() {
      getStats()
        .then((r) => {
          setStats(r.data);
          const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          setChartData((prev) => [
            ...prev.slice(-29),
            { time: t, value: r.data.contribute_req_per_min ?? 0 },
          ]);
        })
        .catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  // Load recent settlements once
  useEffect(() => {
    getSettlements()
      .then((r) => setSettlements((r.data.settlements || []).slice(0, 10)))
      .catch(() => {});
  }, []);

  const handleStart = () => window.electronAPI?.agent.start();
  const handleStop = () => window.electronAPI?.agent.stop();

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Agent</h1>

      {/* Status + controls */}
      <div className="bg-gray-800 rounded-2xl p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${
              running ? 'bg-green-400 animate-pulse' : 'bg-gray-600'
            }`}
          />
          <span className="text-lg font-medium text-gray-200">
            {running ? '运行中' : '已停止'}
          </span>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleStart}
            disabled={running}
            className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
          >
            启动
          </button>
          <button
            onClick={handleStop}
            disabled={!running}
            className="px-5 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
          >
            停止
          </button>
        </div>
      </div>

      {/* Live stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">贡献速率</p>
            <p className="text-2xl font-bold text-blue-400">{stats.contribute_req_per_min ?? 0}</p>
            <p className="text-xs text-gray-500">req/min</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">活跃请求</p>
            <p className="text-2xl font-bold text-gray-100">{stats.active_requests ?? 0}</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">在线节点</p>
            <p className="text-2xl font-bold text-gray-100">{stats.active_workers ?? 0}</p>
          </div>
        </div>
      )}

      {/* Rate chart */}
      <div className="bg-gray-800 rounded-2xl p-4">
        <p className="text-sm text-gray-400 mb-2">贡献请求速率 (req/min)</p>
        <RateChart data={chartData} />
      </div>

      {/* Settlement history */}
      <section>
        <h2 className="text-lg font-semibold text-gray-300 mb-3">最近结算</h2>
        {settlements.length === 0 ? (
          <p className="text-gray-500 text-sm">暂无结算记录</p>
        ) : (
          <div className="space-y-2">
            {settlements.map((s) => (
              <div
                key={s.id ?? s.period_end}
                className="bg-gray-800 rounded-xl px-4 py-3 grid grid-cols-5 gap-2 text-sm items-center"
              >
                <span className="text-gray-400 text-xs">{s.period_end?.slice(0, 16)}</span>
                <span className="text-gray-300">{(s.output_tokens ?? 0).toLocaleString()} tok</span>
                <span className="text-yellow-400 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                <span className="text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Log output */}
      <section>
        <h2 className="text-lg font-semibold text-gray-300 mb-2">Agent 日志</h2>
        <div
          ref={logRef}
          className="bg-gray-900 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-gray-400 space-y-0.5"
        >
          {logs.length === 0 ? (
            <span className="text-gray-600">（日志为空）</span>
          ) : (
            logs.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      </section>
    </div>
  );
}

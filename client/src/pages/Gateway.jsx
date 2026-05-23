// client/src/pages/Gateway.jsx
import React, { useEffect, useState, useCallback } from 'react';
import { getServerUrl } from '../config';
import { listKeys } from '../api/client';

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function CopyButton({ text, label = '复制' }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <button onClick={copy}
      className="shrink-0 text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
      {copied ? '已复制 ✓' : label}
    </button>
  );
}

function StrategyToggle({ strategy, onChange }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      {['cost', 'quality'].map((s) => (
        <button key={s} onClick={() => onChange(s)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            strategy === s
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}>
          {s === 'cost' ? '省钱优先' : '质量优先'}
        </button>
      ))}
    </div>
  );
}

const VIA_LABELS = {
  ollama: 'Ollama',
  groq: 'Groq',
  'github-models': 'GitHub Models',
  'tokenbank-p2p': 'P2P 网络',
  openai: 'OpenAI',
  'anthropic-paid': 'Anthropic',
};

export default function Gateway() {
  const [status, setStatus]     = useState(null);
  const [stats, setStats]       = useState(null);
  const [logEntries, setLog]    = useState([]);
  const [ccStatus, setCcStatus] = useState(null);
  const [ccMsg, setCcMsg]       = useState('');
  const [ccBusy, setCcBusy]     = useState(false);

  const localBase = status?.port ? `http://localhost:${status.port}/v1` : 'http://localhost:11430/v1';

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.gateway) return;
    const [s, st, lg] = await Promise.all([
      window.electronAPI.gateway.status(),
      window.electronAPI.gateway.getDailyStats(),
      window.electronAPI.gateway.getLog(),
    ]);
    setStatus(s);
    setStats(st);
    setLog(lg.slice(0, 20));
  }, []);

  useEffect(() => {
    refresh();
    window.electronAPI?.claude?.status().then(r => setCcStatus(r?.configured)).catch(() => {});
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleStrategy(s) {
    await window.electronAPI?.gateway?.setStrategy(s);
    setStatus(prev => prev ? { ...prev, strategy: s } : prev);
  }

  async function handleClaudeConfigure() {
    setCcBusy(true); setCcMsg('');
    try {
      const keysRes = await listKeys().catch(() => ({ data: { keys: [] } }));
      const activeKey = (keysRes.data.keys || []).find(k => k.is_active);
      if (!activeKey) { setCcMsg('请先在供给源页面创建并启用 API Key'); return; }
      await window.electronAPI?.claude?.configure(localBase, activeKey.key, []);
      setCcStatus(true);
      setCcMsg('配置成功，重启 Claude Code 生效');
      setTimeout(() => setCcMsg(''), 4000);
    } finally { setCcBusy(false); }
  }

  const totalCalls  = stats?.calls ?? 0;
  const providerEntries = Object.entries(stats?.by_provider ?? {})
    .sort((a, b) => b[1].calls - a[1].calls);
  const freeCalls   = providerEntries
    .filter(([id]) => !['tokenbank-p2p', 'openai', 'anthropic-paid'].includes(id))
    .reduce((s, [, v]) => s + v.calls, 0);
  const freeRatio   = totalCalls > 0 ? Math.round((freeCalls / totalCalls) * 100) : 0;

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">本地网关</h1>
        {status && (
          <div className="flex items-center gap-3">
            <span className={`flex items-center gap-1.5 text-sm ${status.running ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>
              <span className={`w-2 h-2 rounded-full ${status.running ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`} />
              {status.running ? `运行中 :${status.port}` : '已停止'}
            </span>
            <StrategyToggle strategy={status.strategy} onChange={handleStrategy} />
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="今日调用" value={totalCalls} sub="次请求" />
        <StatCard label="免费路由占比" value={`${freeRatio}%`} sub={`${freeCalls} 次走免费层`} />
        <StatCard label="供给来源" value={providerEntries.length} sub="活跃 Provider" />
      </div>

      {/* Endpoint card */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">接入配置</h2>
        <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">本地网关地址（将 AI 工具指向此地址）</p>
            <p className="font-mono text-sm text-gray-800 dark:text-gray-200">{localBase}</p>
          </div>
          <CopyButton text={localBase} />
        </div>
        <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {ccStatus !== null && (
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${ccStatus ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}`}>
                {ccStatus ? 'Claude Code 已配置' : 'Claude Code 未配置'}
              </span>
            )}
            {ccMsg && <span className={`text-xs truncate ${ccMsg.includes('成功') ? 'text-green-600 dark:text-green-400' : 'text-yellow-600'}`}>{ccMsg}</span>}
          </div>
          {window.electronAPI?.claude && (
            <button onClick={handleClaudeConfigure} disabled={ccBusy}
              className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
              {ccBusy ? '配置中…' : '一键配置'}
            </button>
          )}
        </div>
      </div>

      {/* Route log */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">路由明细</h2>
        {logEntries.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">暂无请求记录。将 AI 工具的 base_url 指向 {localBase} 后开始使用。</p>
        ) : (
          <div className="space-y-1.5">
            {logEntries.map((e, i) => (
              <div key={`${e.ts}-${e.via}-${i}`} className="flex items-center gap-3 text-xs px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                <span className="font-mono text-gray-500 dark:text-gray-500 shrink-0 w-12">
                  {new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{e.model || '—'}</span>
                <span className="text-gray-400 dark:text-gray-500 shrink-0">→</span>
                <span className={`shrink-0 font-medium ${e.status === 'ok' ? 'text-blue-600 dark:text-blue-400' : 'text-red-500'}`}>
                  {e.status === 'ok' ? (VIA_LABELS[e.via] || e.via || '—') : '失败'}
                </span>
                <span className="text-gray-400 dark:text-gray-500 shrink-0">{e.latency_ms}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

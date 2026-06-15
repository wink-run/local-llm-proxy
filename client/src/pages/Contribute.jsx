// client/src/pages/Contribute.jsx
import React, { useEffect, useState, useRef } from 'react';
import { getStats, getSettlements } from '../api/client';
import { getConfig, getGateway } from '../api/adapter';
import RateChart from '../components/RateChart';
function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function ContributionConfigCard() {
  const [selectedNames,   setSelectedNames]   = useState(new Set()); // Set<string>
  const [availableModels, setAvailableModels] = useState([]);        // {name, type}[]
  const [nodeName,        setNodeName]        = useState('');
  const [autoStart,       setAutoStart]       = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [savedMsg,        setSavedMsg]        = useState('');
  const [localGw,         setLocalGw]         = useState('http://127.0.0.1:11430/v1');

  useEffect(() => {
    Promise.all([
      getConfig().read().catch(() => null),
      getGateway().status().catch(() => null),
    ]).then(([saved, gwStatus]) => {
      // Dynamic gateway URL from actual running port
      const port = gwStatus?.port || 11430;
      const gw   = `http://127.0.0.1:${port}/v1`;
      setLocalGw(gw);

      if (!saved) return;
      const avail = [];
      const seen  = new Set();
      for (const p of (saved?.providers || [])) {
        if (p.type === 'p2p') continue;
        for (const m of (p.models || [])) {
          const name = typeof m === 'string' ? m : m.name;
          const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
          if (!name || seen.has(name)) continue;
          seen.add(name);
          avail.push({ name, type });
        }
      }
      setAvailableModels(avail);

      const prevNames = new Set(
        (saved?.model_groups || [])
          .flatMap(g => g.models || [])
          .map(m => typeof m === 'string' ? m : m.name)
          .filter(Boolean)
      );
      setSelectedNames(prevNames);
      setNodeName(saved?.name || '');
      setAutoStart(!!saved?.auto_start);
    });
  }, []);

  function toggleModel(name) {
    setSelectedNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const models       = availableModels.filter(m => selectedNames.has(m.name));
      const model_groups = [{ base_url: localGw, token: '', models }];
      const current      = (await getConfig().read().catch(() => null)) || {};
      const updated      = { ...current, model_groups, llm_base_url: localGw, llm_token: '', models, name: nodeName, auto_start: autoStart };
      await getConfig().write(updated);
      setSavedMsg('已保存'); setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">贡献节点配置</span>
        {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>}
      </div>

      {/* Fixed forwarding URL */}
      <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2">
        <span className="text-[10px] text-gray-400 shrink-0">转发地址</span>
        <code className="text-xs font-mono text-green-600 dark:text-green-400 truncate">{localGw}</code>
      </div>

      {/* Model selection */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">贡献模型</span>
          {selectedNames.size > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40">
              {selectedNames.size} 个
            </span>
          )}
        </div>

        {availableModels.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-600">请先在「供给源」中配置模型</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {availableModels.map(m => {
              const sel     = selectedNames.has(m.name);
              const isImage = m.type === 'image';
              return (
                <button key={m.name} type="button" onClick={() => toggleModel(m.name)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-mono transition-colors ${
                    sel
                      ? isImage
                        ? 'bg-purple-100 dark:bg-purple-900/40 border-purple-400 dark:border-purple-700 text-purple-700 dark:text-purple-300'
                        : 'bg-blue-100 dark:bg-blue-900/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                      : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500'
                  }`}>
                  {m.name}
                  <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
                    sel
                      ? isImage ? 'bg-purple-200 dark:bg-purple-800 text-purple-700 dark:text-purple-300' : 'bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300'
                      : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                  }`}>
                    {isImage ? '图' : '文'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Node name */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">节点名称</label>
        <input value={nodeName} onChange={e => setNodeName(e.target.value)} placeholder="留空使用主机名"
          className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500" />
      </div>

      {/* Auto-start toggle */}
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <div onClick={() => setAutoStart(v => !v)}
          className={`relative w-10 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : 'translate-x-1'}`} />
        </div>
        <span className="text-sm text-gray-700 dark:text-gray-300">启动应用时自动运行贡献节点</span>
      </label>

      <button onClick={save} disabled={saving}
        className="px-5 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
        {saving ? '保存中…' : '保存配置'}
      </button>
    </div>
  );
}

export default function Contribute() {
  const [running,     setRunning]     = useState(false);
  const [stats,       setStats]       = useState(null);
  const [chartData,   setChartData]   = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [logs,        setLogs]        = useState([]);
  const logRef = useRef(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.agent.getStatus().then(({ running: r }) => setRunning(r));
    // Load historical logs buffered in main process before subscribing to new ones
    window.electronAPI.agent.getLogs?.().then(lines => {
      if (lines?.length) setLogs(lines.map(l => l.trimEnd()));
    });
    const disposeStatus = window.electronAPI.agent.onStatus(({ running: r, error }) => {
      setRunning(r);
      if (error) setLogs(prev => [...prev.slice(-199), `[error] ${error}`]);
    });
    const disposeLog = window.electronAPI.agent.onLog(line => setLogs(prev => [...prev.slice(-199), line.trimEnd()]));
    return () => { disposeStatus?.(); disposeLog?.(); };
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  useEffect(() => {
    function poll() {
      getStats().then(r => {
        setStats(r.data);
        const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setChartData(prev => [...prev.slice(-29), { time: t, value: r.data.contribute_req_per_min ?? 0 }]);
      }).catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSettlements().then(r => setSettlements((r.data.settlements || []).slice(0, 10))).catch(() => {});
  }, []);

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">贡献</h1>
        <p className="text-sm text-gray-500 mt-0.5">将本地算力或 API Key 共享到 P2P 网络，赚取积分用于消费其他模型</p>
      </div>

      {/* Start/Stop */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            {running && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />}
            <span className={`relative inline-flex rounded-full h-3 w-3 ${running ? 'bg-green-500' : 'bg-gray-600'}`} />
          </span>
          <span className="text-base font-medium text-gray-800 dark:text-gray-200">{running ? '贡献中' : '已停止'}</span>
          {stats && running && (
            <span className="text-xs text-gray-500">agent 运行中 · {stats.contribute_req_per_min ?? 0} req/min</span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => window.electronAPI?.agent.start()} disabled={running}
            className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">启动</button>
          <button onClick={() => window.electronAPI?.agent.stop()} disabled={!running}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">停止</button>
        </div>
      </div>

      <ContributionConfigCard />

      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-500 mb-1">贡献速率</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.contribute_req_per_min ?? 0}</p>
            <p className="text-xs text-gray-600">req/min</p>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-500 mb-1">活跃请求</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_requests ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3">
            <p className="text-xs text-gray-500 mb-1">在线节点</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_workers ?? 0}</p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-4">
        <p className="text-xs text-gray-500 mb-3">贡献请求速率 (req/min)</p>
        <RateChart data={chartData} />
      </div>

      <section>
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">最近结算</h2>
        {settlements.length === 0 ? (
          <p className="text-gray-500 text-sm">暂无结算记录</p>
        ) : (
          <div className="space-y-2">
            {settlements.map(s => (
              <div key={s.id ?? s.period_end}
                className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-4 py-3 grid grid-cols-5 gap-2 text-sm items-center">
                <span className="text-gray-500 text-xs">{s.period_end?.slice(0, 16)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.output_tokens ?? 0).toLocaleString()} tok</span>
                <span className="text-yellow-500 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-600 dark:text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">Agent 日志</h2>
        <div ref={logRef} className="bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
          {logs.length === 0 ? <span className="text-gray-600">（日志为空）</span> : logs.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </section>
    </div>
  );
}

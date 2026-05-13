import React, { useEffect, useState, useRef } from 'react';
import { getStats, getSettlements } from '../api/client';
import RateChart from '../components/RateChart';

function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function mask(s) {
  if (!s) return '';
  if (s.length <= 12) return s.slice(0, 4) + '●●●●';
  return s.slice(0, 8) + '●●●●' + s.slice(-4);
}

function LLMConfigCard() {
  const [scanResults, setScanResults] = useState(null);
  const [scanning, setScanning]       = useState(false);
  const [llmUrl, setLlmUrl]           = useState('');
  const [llmToken, setLlmToken]       = useState('');
  const [modelsText, setModelsText]   = useState('');
  const [nodeName, setNodeName]       = useState('');
  const [autoStart, setAutoStart]     = useState(false);
  const [saving, setSaving]           = useState(false);
  const [savedMsg, setSavedMsg]       = useState('');

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then((cfg) => {
      setLlmUrl(cfg?.llm_base_url || '');
      setLlmToken(cfg?.llm_token || '');
      setModelsText((cfg?.models || []).join(', '));
      setNodeName(cfg?.name || '');
      setAutoStart(!!cfg?.auto_start);
      if (!cfg?.llm_base_url) handleScan();
    });
  }, []);

  async function handleScan() {
    if (!window.electronAPI) return;
    setScanning(true);
    setScanResults(null);
    try {
      setScanResults(await window.electronAPI.config.scan());
    } finally {
      setScanning(false);
    }
  }

  function fillFromResult(r) {
    if (r.base_url) setLlmUrl(r.base_url);
    if (r.token)    setLlmToken(r.token);
    if (r.models?.length) setModelsText(r.models.join(', '));
    setScanResults(null);
  }

  async function saveAll() {
    if (!window.electronAPI) return;
    setSaving(true);
    try {
      const models  = modelsText.split(',').map(s => s.trim()).filter(Boolean);
      const current = (await window.electronAPI.config.read()) || {};
      await window.electronAPI.config.write({
        ...current,
        llm_base_url: llmUrl,
        llm_token:    llmToken,
        models,
        name:         nodeName,
        auto_start:   autoStart,
      });
      setSavedMsg('已保存');
      setTimeout(() => setSavedMsg(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  const configured = !!(llmUrl && modelsText);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${configured ? 'bg-green-400' : 'bg-yellow-400'}`} />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">本地 LLM 配置</span>
          {configured && <span className="text-xs text-green-600 dark:text-green-400">已配置</span>}
        </div>
        <button onClick={handleScan} disabled={scanning}
          className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 disabled:opacity-50 transition-colors">
          {scanning ? '扫描中…' : '自动检测'}
        </button>
      </div>

      {/* Scan results — shown as a pre-fill chooser */}
      {Array.isArray(scanResults) && (
        scanResults.length === 0
          ? <p className="text-xs text-gray-400 dark:text-gray-500">未找到配置，请手动填写。</p>
          : <div className="space-y-1.5">
              <p className="text-xs text-gray-400 dark:text-gray-500">检测到以下配置，点击填入：</p>
              {scanResults.map((r, i) => (
                <button key={i} onClick={() => fillFromResult(r)}
                  className="w-full text-left flex items-start gap-2 bg-gray-50 dark:bg-gray-700/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl px-3 py-2 transition-colors">
                  <div className="text-xs space-y-0.5 min-w-0 flex-1">
                    <p className="text-gray-400 dark:text-gray-500 font-mono truncate">~/{r.source}</p>
                    {r.base_url && <p className="text-gray-700 dark:text-gray-200 truncate">{r.base_url}</p>}
                    {r.token    && <p className="text-gray-500 dark:text-gray-400 font-mono">{mask(r.token)}</p>}
                    {r.models?.length > 0 && <p className="text-gray-500 dark:text-gray-400 truncate">{r.models.join(', ')}</p>}
                  </div>
                  <span className="shrink-0 text-xs text-blue-500 dark:text-blue-400 mt-0.5">填入 →</span>
                </button>
              ))}
            </div>
      )}

      {/* Unified form */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">本地 LLM 地址</label>
          <input value={llmUrl} onChange={e => setLlmUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">LLM Token（可选）</label>
          <input value={llmToken} onChange={e => setLlmToken(e.target.value)}
            placeholder="无则留空" type="password"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">支持的模型（逗号分隔）</label>
          <input value={modelsText} onChange={e => setModelsText(e.target.value)}
            placeholder="qwen3-32b, qwen3-7b"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">节点名称</label>
          <input value={nodeName} onChange={e => setNodeName(e.target.value)}
            placeholder="留空使用主机名"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
        </div>
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <div onClick={() => setAutoStart(v => !v)}
            className={`relative w-10 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
            <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : 'translate-x-1'}`} />
          </div>
          <span className="text-sm text-gray-700 dark:text-gray-300">启动应用时自动运行 Agent</span>
        </label>
        <div className="flex items-center gap-3 pt-1">
          <button onClick={saveAll} disabled={saving}
            className="px-5 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
            {saving ? '保存中…' : '保存配置'}
          </button>
          {savedMsg && <span className="text-sm text-green-600 dark:text-green-400">{savedMsg}</span>}
        </div>
      </div>
    </div>
  );
}

export default function Agent() {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [logs, setLogs] = useState([]);
  const logRef = useRef(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.agent.getStatus().then(({ running: r }) => setRunning(r));
    const disposeStatus = window.electronAPI.agent.onStatus(({ running: r, error }) => {
      setRunning(r);
      if (error) setLogs((prev) => [...prev.slice(-99), `[error] ${error}`]);
    });
    const disposeLog = window.electronAPI.agent.onLog((line) =>
      setLogs((prev) => [...prev.slice(-99), line.trimEnd()])
    );
    return () => { disposeStatus?.(); disposeLog?.(); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    function poll() {
      getStats()
        .then((r) => {
          setStats(r.data);
          const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          setChartData((prev) => [...prev.slice(-29), { time: t, value: r.data.contribute_req_per_min ?? 0 }]);
        })
        .catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSettlements()
      .then((r) => setSettlements((r.data.settlements || []).slice(0, 10)))
      .catch(() => {});
  }, []);

  const handleStart = () => window.electronAPI?.agent.start();
  const handleStop = () => window.electronAPI?.agent.stop();

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Agent</h1>

      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-400 dark:bg-gray-600'}`} />
          <span className="text-lg font-medium text-gray-700 dark:text-gray-200">{running ? '运行中' : '已停止'}</span>
        </div>
        <div className="flex gap-3">
          <button onClick={handleStart} disabled={running}
            className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
            启动
          </button>
          <button onClick={handleStop} disabled={!running}
            className="px-5 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
            停止
          </button>
        </div>
      </div>

      <LLMConfigCard />

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">贡献速率</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.contribute_req_per_min ?? 0}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">req/min</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">活跃请求</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_requests ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">在线节点</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_workers ?? 0}</p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-4">
        <p className="text-sm text-gray-400 dark:text-gray-400 mb-2">贡献请求速率 (req/min)</p>
        <RateChart data={chartData} />
      </div>

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">最近结算</h2>
        {settlements.length === 0 ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">暂无结算记录</p>
        ) : (
          <div className="space-y-2">
            {settlements.map((s) => (
              <div key={s.id ?? s.period_end}
                className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 grid grid-cols-5 gap-2 text-sm items-center">
                <span className="text-gray-400 dark:text-gray-400 text-xs">{s.period_end?.slice(0, 16)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.output_tokens ?? 0).toLocaleString()} tok</span>
                <span className="text-yellow-500 dark:text-yellow-400 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-600 dark:text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">Agent 日志</h2>
        <div ref={logRef}
          className="bg-gray-100 dark:bg-gray-900 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
          {logs.length === 0
            ? <span className="text-gray-400 dark:text-gray-600">（日志为空）</span>
            : logs.map((line, i) => <div key={i}>{line}</div>)
          }
        </div>
      </section>
    </div>
  );
}

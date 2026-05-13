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

async function fetchModels(baseUrl, token) {
  const url = baseUrl.replace(/\/?$/, '') + '/models';
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // OpenAI format: { data: [{ id }] }  |  plain array  |  { models: [{ name/id }] }
  const list = Array.isArray(json) ? json
    : Array.isArray(json.data) ? json.data
    : Array.isArray(json.models) ? json.models
    : [];
  return list.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

function LLMConfigCard() {
  const [agentCfg, setAgentCfg]         = useState(null);
  const [scanResults, setScanResults]   = useState(null); // null=idle, []=scanned
  const [scanning, setScanning]         = useState(false);
  const [showManual, setShowManual]     = useState(false);
  const [manualUrl, setManualUrl]       = useState('');
  const [manualToken, setManualToken]   = useState('');
  const [nodeName, setNodeName]         = useState('');
  const [autoStart, setAutoStart]       = useState(false);
  // model picker state
  const [availModels, setAvailModels]   = useState(null); // null=not fetched
  const [fetchingMod, setFetchingMod]   = useState(false);
  const [modelErr, setModelErr]         = useState('');
  const [selModels, setSelModels]       = useState([]);   // user selection
  const [saving, setSaving]             = useState(false);
  const [savedMsg, setSavedMsg]         = useState('');

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then((cfg) => {
      setAgentCfg(cfg);
      setNodeName(cfg?.name || '');
      setAutoStart(!!cfg?.auto_start);
      if (cfg?.llm_base_url) {
        loadModels(cfg.llm_base_url, cfg.llm_token, cfg.models || []);
      } else {
        handleScan();
      }
    });
  }, []);

  async function loadModels(url, token, savedList) {
    setFetchingMod(true);
    setModelErr('');
    try {
      const ids = await fetchModels(url, token);
      setAvailModels(ids);
      // pre-select: saved list if any, else all fetched
      setSelModels(savedList.length ? savedList.filter(m => ids.includes(m)) : ids);
    } catch (e) {
      setModelErr(`获取模型失败: ${e.message}`);
      // fall back to saved list as editable text
      setAvailModels([]);
      setSelModels(savedList);
    } finally {
      setFetchingMod(false);
    }
  }

  function toggleModel(id) {
    setSelModels(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]);
  }

  async function saveAll() {
    if (!window.electronAPI) return;
    setSaving(true);
    try {
      const current = (await window.electronAPI.config.read()) || {};
      const updated = {
        ...current,
        models: selModels,
        name: nodeName,
        auto_start: autoStart,
      };
      await window.electronAPI.config.write(updated);
      setAgentCfg(prev => ({ ...prev, models: selModels, name: nodeName, auto_start: autoStart }));
      setSavedMsg('已保存');
      setTimeout(() => setSavedMsg(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleScan() {
    if (!window.electronAPI) return;
    setScanning(true);
    setScanResults(null);
    try {
      const results = await window.electronAPI.config.scan();
      setScanResults(results);
    } finally {
      setScanning(false);
    }
  }

  async function applyResult(result) {
    if (!window.electronAPI) return;
    const current = (await window.electronAPI.config.read()) || {};
    const newUrl   = result.base_url || current.llm_base_url || '';
    const newToken = result.token    || current.llm_token    || '';
    await window.electronAPI.config.write({ ...current, llm_base_url: newUrl, llm_token: newToken });
    const updated = { ...current, llm_base_url: newUrl, llm_token: newToken };
    setAgentCfg(updated);
    setScanResults(null);
    loadModels(newUrl, newToken, updated.models || []);
  }

  async function applyManual() {
    if (!window.electronAPI || !manualUrl) return;
    const current = (await window.electronAPI.config.read()) || {};
    await window.electronAPI.config.write({ ...current, llm_base_url: manualUrl, llm_token: manualToken });
    const updated = { ...current, llm_base_url: manualUrl, llm_token: manualToken };
    setAgentCfg(updated);
    setShowManual(false);
    loadModels(manualUrl, manualToken, updated.models || []);
  }

  const configured = !!agentCfg?.llm_base_url;
  const modelsOk   = (agentCfg?.models || []).length > 0;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${configured && modelsOk ? 'bg-green-400' : 'bg-yellow-400'}`} />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">本地 LLM 配置</span>
          {configured && modelsOk && (
            <span className="text-xs text-green-600 dark:text-green-400">已配置</span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={handleScan} disabled={scanning}
            className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 disabled:opacity-50 transition-colors">
            {scanning ? '扫描中…' : '自动检测'}
          </button>
          <button onClick={() => { setShowManual(v => !v); setScanResults(null); }}
            className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 transition-colors">
            手动配置
          </button>
        </div>
      </div>

      {/* Current endpoint */}
      {configured && (
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
          <p><span className="text-gray-400 dark:text-gray-500 w-10 inline-block">端点</span>{agentCfg.llm_base_url}</p>
          {agentCfg.llm_token && (
            <p><span className="text-gray-400 dark:text-gray-500 w-10 inline-block">Token</span>{mask(agentCfg.llm_token)}</p>
          )}
        </div>
      )}

      {/* Not configured hint */}
      {!configured && !scanResults && !scanning && !showManual && (
        <p className="text-xs text-yellow-600 dark:text-yellow-400">
          未配置本地 LLM 端点，点击「自动检测」从常见配置文件中读取。
        </p>
      )}

      {/* Scan results */}
      {Array.isArray(scanResults) && (
        scanResults.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">未找到配置，请手动填写。</p>
        ) : (
          <div className="space-y-2">
            {scanResults.map((r, i) => (
              <div key={i} className="flex items-start justify-between gap-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl px-3 py-2">
                <div className="text-xs space-y-0.5 min-w-0">
                  <p className="text-gray-400 dark:text-gray-500 font-mono truncate">~/{r.source}</p>
                  {r.base_url && <p className="text-gray-700 dark:text-gray-200 truncate">{r.base_url}</p>}
                  {r.token    && <p className="text-gray-500 dark:text-gray-400 font-mono">{mask(r.token)}</p>}
                </div>
                <button onClick={() => applyResult(r)}
                  className="shrink-0 px-3 py-1 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">
                  应用
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {/* Manual config */}
      {showManual && (
        <div className="space-y-2">
          <input value={manualUrl} onChange={e => setManualUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
          <input value={manualToken} onChange={e => setManualToken(e.target.value)}
            placeholder="API Token（无则留空）" type="password"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
          <button onClick={applyManual} disabled={!manualUrl}
            className="px-4 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors">
            确认并获取模型
          </button>
        </div>
      )}

      {/* Model picker — shown when endpoint is set */}
      {configured && (
        <div className="border-t border-gray-100 dark:border-gray-700 pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
              贡献的模型
              {modelsOk && <span className="ml-1.5 text-green-600 dark:text-green-400">({agentCfg.models.length} 个)</span>}
            </span>
            <button onClick={() => loadModels(agentCfg.llm_base_url, agentCfg.llm_token, agentCfg?.models || [])}
              disabled={fetchingMod}
              className="text-xs text-blue-500 hover:text-blue-400 disabled:opacity-50 transition-colors">
              {fetchingMod ? '加载中…' : '刷新'}
            </button>
          </div>

          {modelErr && <p className="text-xs text-red-500 dark:text-red-400">{modelErr}</p>}

          {fetchingMod && (
            <p className="text-xs text-gray-400 dark:text-gray-500">正在从端点获取模型列表…</p>
          )}

          {!fetchingMod && availModels !== null && (
            availModels.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {availModels.map(id => (
                  <button key={id} onClick={() => toggleModel(id)}
                    className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                      selModels.includes(id)
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'
                    }`}>
                    {id}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">未检测到模型，请在设置页手动填写。</p>
            )
          )}

          {!fetchingMod && availModels !== null && availModels.length > 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500">点击模型名称切换是否贡献</p>
          )}
        </div>
      )}

      {/* Node name + auto-start + save — shown when endpoint is set */}
      {configured && (
        <div className="border-t border-gray-100 dark:border-gray-700 pt-3 space-y-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">节点名称</label>
            <input value={nodeName} onChange={e => setNodeName(e.target.value)}
              placeholder="留空使用主机名"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
          </div>
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <div onClick={() => setAutoStart(v => !v)}
              className={`relative w-9 h-5 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-xs text-gray-700 dark:text-gray-300">启动应用时自动运行 Agent</span>
          </label>
          <div className="flex items-center gap-3">
            <button onClick={saveAll} disabled={saving}
              className="px-4 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors">
              {saving ? '保存中…' : '保存配置'}
            </button>
            {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>}
          </div>
        </div>
      )}
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

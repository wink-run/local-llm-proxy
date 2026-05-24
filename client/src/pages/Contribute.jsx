// client/src/pages/Contribute.jsx
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getStats, getSettlements } from '../api/client';
import RateChart from '../components/RateChart';
import { LLM_PROVIDER_PRESETS, matchPresetId } from '../data/llmProviderPresets';

function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function emptyGroup() {
  return { base_url: '', token: '', showToken: false, models: [] };
}

function ContributionConfigCard() {
  const [cfg,       setCfg]       = useState(null);
  const [editing,   setEditing]   = useState(false);
  const [groups,    setGroups]    = useState([emptyGroup()]);
  const [nodeName,  setNodeName]  = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [savedMsg,  setSavedMsg]  = useState('');
  const [scanning,  setScanning]  = useState(false);
  const [presetId,  setPresetId]  = useState('custom');

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then(async (saved) => {
      const hasGroups = saved?.model_groups?.length > 0;
      const hasLegacy = saved?.llm_base_url;
      if (hasGroups || hasLegacy) { setCfg(saved); }
      else {
        try {
          const results = await window.electronAPI.config.scan();
          const best = results[0];
          if (best?.base_url) {
            const updated = { ...(saved || {}), llm_base_url: best.base_url, llm_token: best.token || '', models: best.models || [] };
            await window.electronAPI.config.write(updated);
            setCfg(updated); return;
          }
        } catch {}
        setCfg(saved || {}); setEditing(true);
      }
    });
  }, []);

  function openEdit() {
    let parsed;
    if (cfg?.model_groups?.length) {
      parsed = cfg.model_groups.map(g => ({
        base_url: g.base_url || '', token: g.token || '', showToken: false,
        models: (g.models || []).map(m => typeof m === 'string' ? { name: m, type: 'chat' } : m),
      }));
    } else {
      const models = (cfg?.models || []).map(m => typeof m === 'string' ? { name: m, type: 'chat' } : { name: m.name, type: m.type || 'chat' });
      parsed = [{ base_url: cfg?.llm_base_url || '', token: cfg?.llm_token || '', showToken: false, models }];
    }
    if (parsed.length === 0) parsed = [emptyGroup()];
    setGroups(parsed);
    setNodeName(cfg?.name || '');
    setAutoStart(!!cfg?.auto_start);
    setPresetId(matchPresetId(parsed[0]?.base_url));
    setEditing(true);
  }

  async function autoScan() {
    if (!window.electronAPI) return;
    setScanning(true);
    try {
      const results = await window.electronAPI.config.scan();
      const best = results[0];
      if (best?.base_url) {
        const current = (await window.electronAPI.config.read()) || {};
        const updated = { ...current, llm_base_url: best.base_url, llm_token: best.token || '', models: best.models || [] };
        await window.electronAPI.config.write(updated); setCfg(updated);
        setSavedMsg('已自动配置'); setTimeout(() => setSavedMsg(''), 2000);
      } else { setSavedMsg('未找到配置'); setTimeout(() => setSavedMsg(''), 2000); }
    } finally { setScanning(false); }
  }

  function applyPreset(pid) {
    setPresetId(pid);
    const preset = LLM_PROVIDER_PRESETS.find(p => p.id === pid);
    if (!preset || !preset.baseUrl) return;
    setGroups(prev => prev.map((g, i) => i === 0 ? {
      ...g, base_url: preset.baseUrl,
      models: preset.defaultModels.map(n => ({ name: n, type: 'chat' })),
    } : g));
  }

  async function save() {
    if (!window.electronAPI) return;
    setSaving(true);
    try {
      const model_groups = groups.map(({ base_url, token, models }) => ({ base_url, token, models: models.filter(m => m.name.trim()) }));
      const allModels = model_groups.flatMap(g => g.models);
      const first = model_groups[0] || {};
      const current = (await window.electronAPI.config.read()) || {};
      const updated = { ...current, model_groups, llm_base_url: first.base_url || '', llm_token: first.token || '', models: allModels, name: nodeName, auto_start: autoStart };
      await window.electronAPI.config.write(updated); setCfg(updated); setEditing(false);
      setSavedMsg('已保存'); setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  function updateGroup(idx, patch) { setGroups(prev => prev.map((g, i) => i === idx ? { ...g, ...patch } : g)); }
  function updateGroupModel(gIdx, mIdx, patch) {
    setGroups(prev => prev.map((g, i) => i === gIdx ? { ...g, models: g.models.map((m, j) => j === mIdx ? { ...m, ...patch } : m) } : g));
  }
  function removeGroupModel(gIdx, mIdx) {
    setGroups(prev => prev.map((g, i) => i === gIdx ? { ...g, models: g.models.filter((_, j) => j !== mIdx) } : g));
  }

  const viewGroups = cfg?.model_groups?.length ? cfg.model_groups : (cfg?.llm_base_url ? [{ base_url: cfg.llm_base_url, models: cfg?.models || [] }] : []);
  const configured = viewGroups.some(g => g.base_url && g.models?.length > 0);
  const canSave    = groups.some(g => g.base_url.trim());

  if (!editing) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${configured ? 'bg-green-400' : 'bg-yellow-400'}`} />
            <span className="text-sm font-medium text-gray-800 dark:text-gray-200">贡献节点配置</span>
            {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={autoScan} disabled={scanning}
              className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-50 transition-colors">
              {scanning ? '扫描中…' : '自动配置'}
            </button>
            <button onClick={openEdit}
              className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors">
              手动配置
            </button>
          </div>
        </div>
        {configured ? (
          <div className="mt-3 space-y-2 text-xs text-gray-500">
            {viewGroups.map((g, i) => {
              const ms = (g.models || []).map(m => typeof m === 'string' ? m : `${m.name}(${m.type === 'image' ? '图像' : '对话'})`).join(', ');
              return (
                <div key={i} className="bg-gray-100/50 dark:bg-gray-800/50 rounded-xl px-3 py-2 space-y-1">
                  <p className="font-mono truncate text-gray-700 dark:text-gray-300">{g.base_url}</p>
                  {ms && <p className="text-gray-500">{ms}</p>}
                </div>
              );
            })}
            <div className="flex items-center gap-4 text-[10px] text-gray-600">
              {cfg?.name && <span>节点名：<span className="text-gray-600 dark:text-gray-400">{cfg.name}</span></span>}
              <span>自启动：<span className="text-gray-600 dark:text-gray-400">{cfg?.auto_start ? '开启' : '关闭'}</span></span>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-yellow-400">未找到可用配置，请点击「手动配置」填写。</p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">贡献节点配置</span>
        {configured && <button onClick={() => setEditing(false)} className="text-xs text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-700 dark:text-gray-300">取消</button>}
      </div>

      {/* Preset selector */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">快速选择 Provider</label>
        <select value={presetId} onChange={e => applyPreset(e.target.value)}
          className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500">
          {LLM_PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      {groups.map((g, gIdx) => (
        <div key={gIdx} className="border border-gray-300 dark:border-gray-700 rounded-xl p-3 space-y-2.5 bg-gray-100/40 dark:bg-gray-800/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">分组 {gIdx + 1}</span>
            {groups.length > 1 && <button type="button" onClick={() => setGroups(prev => prev.filter((_, i) => i !== gIdx))} className="text-xs text-red-600 dark:text-red-400 hover:text-red-600">删除分组</button>}
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Base URL</label>
            <input value={g.base_url} onChange={e => updateGroup(gIdx, { base_url: e.target.value })} placeholder="http://127.0.0.1:11434/v1"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key（可选）</label>
            <div className="flex gap-2">
              <input value={g.token} onChange={e => updateGroup(gIdx, { token: e.target.value })} placeholder="无则留空"
                type={g.showToken ? 'text' : 'password'} autoComplete="off"
                className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
              <button type="button" onClick={() => updateGroup(gIdx, { showToken: !g.showToken })}
                className="shrink-0 px-3 py-2 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 hover:dark:bg-gray-700">
                {g.showToken ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">模型</label>
            <div className="space-y-1.5 mb-2">
              {g.models.map((m, mIdx) => (
                <div key={mIdx} className="flex items-center gap-2">
                  <input value={m.name} onChange={e => updateGroupModel(gIdx, mIdx, { name: e.target.value })} placeholder="模型 ID"
                    className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
                  <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-600 shrink-0">
                    {['chat', 'image'].map(t => (
                      <button key={t} type="button" onClick={() => updateGroupModel(gIdx, mIdx, { type: t })}
                        className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${m.type === t ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                        {t === 'chat' ? '对话' : '图像'}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={() => removeGroupModel(gIdx, mIdx)} className="text-gray-600 dark:text-gray-400 hover:text-red-500 text-lg leading-none px-1">×</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => updateGroup(gIdx, { models: [...g.models, { name: '', type: 'chat' }] })}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加模型</button>
          </div>
        </div>
      ))}

      <button type="button" onClick={() => setGroups(prev => [...prev, emptyGroup()])}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加分组</button>

      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">节点名称</label>
        <input value={nodeName} onChange={e => setNodeName(e.target.value)} placeholder="留空使用主机名"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
      </div>

      <label className="flex items-center gap-3 cursor-pointer select-none">
        <div onClick={() => setAutoStart(v => !v)} className={`relative w-10 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : 'translate-x-1'}`} />
        </div>
        <span className="text-sm text-gray-700 dark:text-gray-300">启动应用时自动运行贡献节点</span>
      </label>

      <button onClick={save} disabled={saving || !canSave}
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
    const disposeStatus = window.electronAPI.agent.onStatus(({ running: r, error }) => {
      setRunning(r);
      if (error) setLogs(prev => [...prev.slice(-99), `[error] ${error}`]);
    });
    const disposeLog = window.electronAPI.agent.onLog(line => setLogs(prev => [...prev.slice(-99), line.trimEnd()]));
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

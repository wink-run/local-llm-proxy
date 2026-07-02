// client/src/pages/Contribute.jsx
import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStats, getSettlements, getContributeSummary, listJoinedCircles, listMyCircles } from '../api/client';
import { getConfig, getGateway } from '../api/adapter';
import { resolveLocalGatewayBase } from '../api/gatewayModels';
import {
  getAgentStatus, startAgent, stopAgent, getAgentLogs,
  subscribeAgentEvents, useAgentPolling,
} from '../api/agentControl';
import RateChart from '../components/RateChart';
import { useLang } from '../store/lang';
import { fmtContribTokens, fmtCreditCny, creditsToCny } from '../lib/credit-pricing';
function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** 按圈子 id 去重（统一为 number，避免 owned/joined 合并重复） */
function uniqueCircles(list) {
  const map = new Map();
  for (const c of list || []) {
    const id = Number(c.id);
    if (!id || map.has(id)) continue;
    map.set(id, { ...c, id });
  }
  return [...map.values()];
}

function uniqueCircleIds(ids) {
  return [...new Set((ids || []).map(id => Number(id)).filter(Boolean))];
}

function ContributionConfigCard() {
  const { t } = useLang();
  const [selectedNames,   setSelectedNames]   = useState(new Set()); // Set<string>
  const [availableModels, setAvailableModels] = useState([]);        // {name, type}[]
  const [nodeName,        setNodeName]        = useState('');
  const [autoStart,       setAutoStart]       = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [savedMsg,        setSavedMsg]        = useState('');
  const [localGw,         setLocalGw]         = useState(() => resolveLocalGatewayBase());
  const [circles,         setCircles]         = useState([]);         // 可分享的圈子
  const [circleScope,     setCircleScope]     = useState('public');   // 'public' | 'circle'
  const [selectedCircleIds, setSelectedCircleIds] = useState(new Set());

  useEffect(() => {
    Promise.all([listMyCircles(), listJoinedCircles()])
      .then(([ownedRes, joinedRes]) => {
        const owned = ownedRes.data?.circles || [];
        const joined = joinedRes.data?.circles || [];
        setCircles(uniqueCircles([...owned, ...joined]));
      })
      .catch(() => {});
    Promise.all([
      getConfig().read().catch(() => null),
      getGateway().status().catch(() => null),
    ]).then(([saved, gwStatus]) => {
      // Dynamic gateway URL from actual running port
      const port = gwStatus?.port || 11430;
      const gw   = resolveLocalGatewayBase(port);
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
      if (saved?.contribute_circle_ids?.length) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds(saved.contribute_circle_ids)));
      } else if (saved?.contribute_circle_id) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds([saved.contribute_circle_id])));
      }
    });
  }, []);

  function toggleModel(name) {
    setSelectedNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function toggleCircle(id) {
    const nid = Number(id);
    if (!nid) return;
    setSelectedCircleIds(prev => {
      const next = new Set(prev);
      if (next.has(nid)) next.delete(nid); else next.add(nid);
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
      const circleIds = circleScope === 'circle' ? uniqueCircleIds([...selectedCircleIds]) : [];
      await getConfig().write({
        ...updated,
        contribute_circle_ids: circleIds,
        contribute_circle_id: circleIds[0] ?? null,
      });
      setSavedMsg(t('common.saved')); setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('contribute.configTitle')}</span>
        {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>}
      </div>

      {/* Fixed forwarding URL */}
      <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2">
        <span className="text-xs text-zinc-400 shrink-0">{t('contribute.forwardUrl')}</span>
        <code className="text-xs font-mono text-green-600 dark:text-green-400 truncate">{localGw}</code>
      </div>

      {/* Model selection */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.models')}</span>
          {selectedNames.size > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40">
              {t('contribute.modelsSelected', { n: selectedNames.size })}
            </span>
          )}
        </div>

        {availableModels.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 dark:text-zinc-400">{t('contribute.noModelsHint')}</p>
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
                      : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-500'
                  }`}>
                  {m.name}
                  <span className={`text-xs px-1 py-0.5 rounded font-medium ${
                    sel
                      ? isImage ? 'bg-purple-200 dark:bg-purple-800 text-purple-700 dark:text-purple-300' : 'bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300'
                      : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'
                  }`}>
                    {isImage ? t('contribute.modelTypeImage') : t('contribute.modelTypeText')}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Node name */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">{t('contribute.nodeName')}</label>
        <input value={nodeName} onChange={e => setNodeName(e.target.value)} placeholder={t('contribute.nodeNamePh')}
          className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500" />
      </div>

      {/* Auto-start toggle */}
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <div onClick={() => setAutoStart(v => !v)}
          className={`relative w-10 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : 'translate-x-1'}`} />
        </div>
        <span className="text-sm text-zinc-700 dark:text-zinc-300">{t('contribute.autoStart')}</span>
      </label>

      {/* Contribution scope */}
      <div className="mt-4">
        <p className="text-sm font-medium mb-2">{t('contribute.scope')}</p>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="radio" name="scope" value="public"
              checked={circleScope === 'public'}
              onChange={() => setCircleScope('public')} />
            {t('contribute.scopePublic')}
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="radio" name="scope" value="circle"
              checked={circleScope === 'circle'}
              onChange={() => setCircleScope('circle')} />
            {t('contribute.scopeCircle')}
          </label>
        </div>
        {circleScope === 'circle' && (
          <div className="mt-2 space-y-2">
            {circles.length === 0
              ? <p className="text-xs text-gray-400">{t('contribute.noCircle')}</p>
              : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {circles.map(c => {
                      const sel = selectedCircleIds.has(c.id);
                      return (
                        <button key={c.id} type="button" onClick={() => toggleCircle(c.id)}
                          className={`px-2.5 py-1 rounded-lg border text-xs transition-colors ${
                            sel
                              ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                              : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-zinc-400'
                          }`}>
                          {c.name}
                        </button>
                      );
                    })}
                  </div>
                  {selectedCircleIds.size > 0 && (
                    <p className="text-xs text-blue-600 dark:text-blue-400">
                      {t('contribute.circlesSelected', { n: selectedCircleIds.size })}
                    </p>
                  )}
                </>
              )
            }
            <p className="text-xs text-gray-400 mt-1">{t('contribute.scopeHint')}</p>
          </div>
        )}
      </div>

      <button onClick={save} disabled={saving}
        className="px-5 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-50 text-white font-medium transition-colors">
        {saving ? t('common.saving') : t('contribute.saveConfig')}
      </button>
    </div>
  );
}

export default function Contribute() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const [running,     setRunning]     = useState(false);
  const [stats,       setStats]       = useState(null);
  const [chartData,   setChartData]   = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [summary,     setSummary]     = useState(null);
  const [logs,        setLogs]        = useState([]);
  const [agentError,  setAgentError]  = useState('');
  const logRef = useRef(null);

  useEffect(() => {
    const unsub = subscribeAgentEvents({
      onStatus: ({ running: r, error }) => {
        setRunning(r);
        if (error) setLogs(prev => [...prev.slice(-199), `[error] ${error}`]);
      },
      onLog: (line) => setLogs(prev => [...prev.slice(-199), line.trimEnd()]),
    });
    if (unsub) {
      getAgentStatus().then(({ running: r }) => setRunning(r));
      getAgentLogs().then(lines => {
        if (lines?.length) setLogs(lines.map(l => String(l).trimEnd()));
      });
      return unsub;
    }

    // Docker / CLI：轮询 admin-api
    if (!useAgentPolling()) return undefined;
    let cancelled = false;
    async function poll() {
      try {
        const st = await getAgentStatus();
        if (cancelled) return;
        setRunning(!!st.running);
        const lines = await getAgentLogs();
        if (!cancelled && lines.length) setLogs(lines.map(l => String(l).trimEnd()));
      } catch {}
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  useEffect(() => {
    function poll() {
      getStats().then(r => {
        setStats(r.data);
        const locale = lang === 'en' ? 'en-US' : 'zh-CN';
        const time = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setChartData(prev => [...prev.slice(-29), { time, value: r.data.contribute_req_per_min ?? 0 }]);
      }).catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, [lang]);

  useEffect(() => {
    function loadSummary() {
      getContributeSummary().then(r => setSummary(r.data)).catch(() => {});
    }
    loadSummary();
    const id = setInterval(loadSummary, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSettlements().then(r => setSettlements((r.data.settlements || []).slice(0, 10))).catch(() => {});
  }, []);

  async function handleStart() {
    setAgentError('');
    try {
      await startAgent();
      const st = await getAgentStatus();
      setRunning(!!st.running);
      const lines = await getAgentLogs();
      if (lines.length) setLogs(lines.map(l => String(l).trimEnd()));
    } catch (e) {
      setAgentError(e.message || String(e));
    }
  }

  async function handleStop() {
    setAgentError('');
    try {
      await stopAgent();
      setRunning(false);
    } catch (e) {
      setAgentError(e.message || String(e));
    }
  }

  return (
    <div className="px-5 py-5 space-y-5">
      <div>
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t('contribute.title')}</h1>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">{t('contribute.subtitle')}</p>
          <button
            type="button"
            onClick={() => navigate('/network')}
            className="electron-no-drag relative z-50 mt-2 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
          >
            {t('providers.p2p.globalNetwork')}
          </button>
        </div>
      </div>

      {/* 累计贡献 / 赚取积分 / P2P 节省 */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
            <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">
              {t('contribute.totalTokens')}
            </p>
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              {fmtContribTokens(summary.contrib_tokens)}
            </p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
              {summary.period_tokens > 0
                ? t('contribute.periodTokens', { n: fmtContribTokens(summary.period_tokens) })
                : t('contribute.totalTokensHint')}
            </p>
          </div>
          <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
            <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">
              {t('contribute.earnedCredits')}
            </p>
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">
              +{(summary.contrib_credits ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}
            </p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
              {t('contribute.approxCny', { amount: fmtCreditCny(summary.contrib_cny) })}
            </p>
          </div>
          <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
            <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">
              {t('contribute.savedMoney')}
            </p>
            <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {fmtCreditCny(summary.saved_cny)}
            </p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
              {summary.p2p_tokens > 0
                ? t('contribute.p2pTokensUsed', { n: fmtContribTokens(summary.p2p_tokens) })
                : t('contribute.savedHint')}
            </p>
          </div>
        </div>
      )}

      {/* Start/Stop */}
      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            {running && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />}
            <span className={`relative inline-flex rounded-full h-3 w-3 ${running ? 'bg-green-500' : 'bg-zinc-600'}`} />
          </span>
          <span className="text-base font-medium text-zinc-800 dark:text-zinc-200">{running ? t('contribute.running') : t('contribute.stopped')}</span>
          {stats && running && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.agentRunning', { n: stats.contribute_req_per_min ?? 0 })}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={handleStart} disabled={running}
            className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">{t('contribute.start')}</button>
          <button onClick={handleStop} disabled={!running}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">{t('contribute.stop')}</button>
        </div>
      </div>
      {agentError && (
        <p className="text-sm text-red-600 dark:text-red-400">{agentError}</p>
      )}

      <ContributionConfigCard />

      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
            <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">{t('contribute.rate')}</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.contribute_req_per_min ?? 0}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">req/min</p>
          </div>
          <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
            <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">{t('contribute.activeReqs')}</p>
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{stats.active_requests ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
            <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">{t('contribute.onlineNodes')}</p>
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{stats.active_workers ?? 0}</p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-3">{t('contribute.chartTitle')}</p>
        <RateChart data={chartData} />
      </div>

      <section>
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-3">{t('contribute.settlements')}</h2>
        {settlements.length === 0 ? (
          <p className="text-zinc-400 dark:text-zinc-500 text-sm">{t('contribute.noSettlements')}</p>
        ) : (
          <div className="space-y-2">
            {settlements.map(s => (
              <div key={s.id ?? s.period_end}
                className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 grid grid-cols-6 gap-2 text-sm items-center">
                <span className="text-zinc-400 dark:text-zinc-500 text-xs col-span-2 sm:col-span-1">{s.period_end?.slice(0, 16)}</span>
                <span className="text-zinc-700 dark:text-zinc-300">{fmtContribTokens(s.output_tokens ?? 0)} tok</span>
                <span className="text-yellow-500 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                <span className="text-zinc-700 dark:text-zinc-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-600 dark:text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
                <span className="text-zinc-400 dark:text-zinc-500 text-xs">
                  ≈{fmtCreditCny(creditsToCny(s.credits_awarded))}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-2">{t('contribute.agentLog')}</h2>
        <div ref={logRef} className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5">
          {logs.length === 0 ? <span className="text-zinc-500 dark:text-zinc-400">{t('contribute.logEmpty')}</span> : logs.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </section>
    </div>
  );
}

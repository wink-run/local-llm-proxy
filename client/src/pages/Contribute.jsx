// client/src/pages/Contribute.jsx
import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStats, getSettlements, getContributeSummary, listJoinedCircles, listMyCircles, listCommunityAgents, listPublicCommunityAgents } from '../api/client';
import { getConfig, getGateway, getLocalConfig } from '../api/adapter';
import { resolveLocalGatewayBase } from '../api/gatewayModels';
import { loadUserAccounts } from '../api/userAccounts';
import { collectPersonalAvailableModels, mergeAccountsForGateway } from '../lib/personalAvailableModels';
import {
  getAgentStatus, startAgent, stopAgent, getAgentLogs,
  subscribeAgentEvents, useAgentPolling,
} from '../api/agentControl';
import RateChart from '../components/RateChart';
import { useLang } from '../store/lang';
import { fmtContribTokens, fmtCreditCny, creditsToCny } from '../lib/credit-pricing';
import { avatarColor } from '../components/UserAvatar';
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

/** 贡献可选模型：个人源 + agent providers + 已保存配置 */
function collectContributeAvailableModels(saved, accounts, localCfg) {
  const merged = mergeAccountsForGateway(localCfg || {}, accounts || {});
  const avail = [];
  const seen  = new Set();
  const add = (name, type = 'chat') => {
    const n = String(name || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    avail.push({ name: n, type });
  };

  // 个人源（与「个人源」页模型视图同源）
  for (const { id } of collectPersonalAvailableModels(saved || {}, merged)) {
    add(id, 'chat');
  }

  for (const p of (saved?.providers || [])) {
    if (p.type === 'p2p') continue;
    for (const m of (p.models || [])) {
      const name = typeof m === 'string' ? m : m.name;
      const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
      add(name, type);
    }
  }

  for (const m of (saved?.models || [])) {
    const name = typeof m === 'string' ? m : m.name;
    const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
    add(name, type);
  }

  for (const g of (saved?.model_groups || [])) {
    for (const m of (g.models || [])) {
      const name = typeof m === 'string' ? m : m.name;
      add(name, typeof m === 'string' ? 'chat' : (m.type || 'chat'));
    }
  }

  return avail;
}

function ContributionConfigCard({ onStart, onStop, running, stats, agentError }) {
  const { t } = useLang();
  const [selectedNames,   setSelectedNames]   = useState(new Set()); // Set<string>
  const [availableModels, setAvailableModels] = useState([]);        // {name, type}[]
  const [availableAssistants, setAvailableAssistants] = useState([]); // resource rows
  const [selectedAssistantIds, setSelectedAssistantIds] = useState(new Set());
  const [nodeName,        setNodeName]        = useState('');
  const [autoStart,       setAutoStart]       = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [savedMsg,        setSavedMsg]        = useState('');
  const [localGw,         setLocalGw]         = useState(() => resolveLocalGatewayBase());
  const [circles,         setCircles]         = useState([]);         // 可分享的圈子
  const [circleScope,     setCircleScope]     = useState('public');   // 'public' | 'circle'
  const [selectedCircleIds, setSelectedCircleIds] = useState(new Set());
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);

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
      loadUserAccounts().catch(() => ({})),
      getLocalConfig().get().catch(() => ({})),
      (typeof window !== 'undefined' && window.electronAPI?.resource?.listResources)
        ? window.electronAPI.resource.listResources({ type: 'assistant' }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([saved, gwStatus, accounts, localCfg, asstRes]) => {
      // Dynamic gateway URL from actual running port
      const port = gwStatus?.port || 11430;
      const gw   = resolveLocalGatewayBase(port);
      setLocalGw(gw);

      const cfg = saved || {};
      const avail = collectContributeAvailableModels(cfg, accounts, localCfg);
      const prevNames = new Set(
        (cfg.model_groups || [])
          .flatMap(g => g.models || [])
          .map(m => typeof m === 'string' ? m : m.name)
          .filter(Boolean)
      );
      setAvailableModels(avail);
      setSelectedNames(prevNames);
      setNodeName(cfg.name || '');
      setAutoStart(!!cfg.auto_start);
      if (cfg.contribute_circle_ids?.length) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds(cfg.contribute_circle_ids)));
      } else if (cfg.contribute_circle_id) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds([cfg.contribute_circle_id])));
      }
      const assistants = asstRes?.success ? (asstRes.resources || []) : (asstRes?.resources || []);
      setAvailableAssistants(Array.isArray(assistants) ? assistants : []);
      const prevAsst = new Set(
        (cfg.contribute_assistants || [])
          .map((x) => (typeof x === 'string' ? x : x?.id))
          .filter(Boolean),
      );
      setSelectedAssistantIds(prevAsst);
    });
  }, []);

  function toggleModel(name) {
    setSelectedNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function toggleAssistant(id) {
    setSelectedAssistantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function assistantDisabledReason(r) {
    const ENABLE = new Set(['claude-code', 'codex', 'cursor', 'kimi-code', 'workbuddy']);
    const ok = (r.projections || []).some((p) => ENABLE.has(p.agentId || p.agent_id));
    if (!ok) return t('contribute.assistantNeedProject');
    return '';
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
    setSavedMsg('');
    try {
      const models = [...selectedNames].map(name =>
        availableModels.find(m => m.name === name) || { name, type: 'chat' }
      );
      const model_groups = [{ base_url: localGw, token: '', models }];
      const current      = (await getConfig().read().catch(() => null)) || {};
      const visibility = circleScope === 'circle' ? 'circle' : 'public';
      const contribute_assistants = [...selectedAssistantIds]
        .filter((id) => {
          const row = availableAssistants.find((a) => a.id === id);
          return row && !assistantDisabledReason(row);
        })
        .map((id) => ({ id, visibility }));
      const updated      = {
        ...current,
        model_groups,
        llm_base_url: localGw,
        llm_token: '',
        models,
        name: nodeName,
        auto_start: autoStart,
        contribute_assistants,
      };
      const circleIds = circleScope === 'circle' ? uniqueCircleIds([...selectedCircleIds]) : [];
      await getConfig().write({
        ...updated,
        contribute_circle_ids: circleIds,
        contribute_circle_id: circleIds[0] ?? null,
      });
      // 保存后立即启动贡献节点
      const started = onStart ? await onStart() : true;
      setSavedMsg(started ? t('contribute.savedAndStarted') : t('common.saved'));
      // 保存后刷新社区智能体列表（停止贡献应立刻从在线名片消失）
      try {
        window.dispatchEvent(new CustomEvent('tb:community-agents-refresh'));
      } catch { /* ignore */ }
      setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-4">
      {/* 标题、运行状态、转发地址 — 单行 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-4 border-b border-zinc-100 dark:border-zinc-700/80">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 shrink-0">{t('contribute.configTitle')}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${running ? 'bg-green-500' : 'bg-zinc-400 dark:bg-zinc-600'}`} />
          </span>
          <span className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
            {running ? t('contribute.running') : t('contribute.stopped')}
          </span>
          {stats && running && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
              {t('contribute.agentRunning', { n: stats.contribute_req_per_min ?? 0 })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 min-w-0 flex-1 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5">
          <span className="text-xs text-zinc-400 shrink-0">{t('contribute.forwardUrl')}</span>
          <code className="text-xs font-mono text-green-600 dark:text-green-400 truncate">{localGw}</code>
        </div>
        {savedMsg && <span className="text-xs text-green-600 dark:text-green-400 shrink-0 ml-auto">{savedMsg}</span>}
      </div>
      {agentError && (
        <p className="text-sm text-red-600 dark:text-red-400 -mt-1">{agentError}</p>
      )}

      {/* 贡献模型：默认只展示已选；点 + 从候选里添加，避免占满整页 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.models')}</span>
          {selectedNames.size > 0 && (
            <span className="text-[11px] text-zinc-400">{t('contribute.modelsSelected', { n: selectedNames.size })}</span>
          )}
        </div>

        {availableModels.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.noModelsHint')}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 items-center">
              {[...selectedNames].map((name) => {
                const m = availableModels.find((x) => x.name === name) || { name, type: 'chat' };
                const isImage = m.type === 'image';
                return (
                  <button
                    key={name}
                    type="button"
                    title={t('contribute.removeModel')}
                    onClick={() => toggleModel(name)}
                    className={`inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-lg border text-xs font-mono transition-colors ${
                      isImage
                        ? 'bg-purple-100 dark:bg-purple-900/40 border-purple-400 dark:border-purple-700 text-purple-700 dark:text-purple-300'
                        : 'bg-blue-100 dark:bg-blue-900/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    }`}
                  >
                    <span className="truncate max-w-[14rem]">{name}</span>
                    <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${
                      isImage
                        ? 'bg-purple-200 dark:bg-purple-800 text-purple-700 dark:text-purple-300'
                        : 'bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300'
                    }`}>
                      {isImage ? t('contribute.modelTypeImage') : t('contribute.modelTypeText')}
                    </span>
                    <span className="ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded text-zinc-500 hover:text-red-500" aria-hidden>×</span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setShowModelPicker((v) => !v)}
                className={`inline-flex items-center justify-center gap-1 min-w-[2rem] h-7 px-2 rounded-lg border text-sm font-medium transition-colors ${
                  showModelPicker
                    ? 'bg-zinc-200 dark:bg-zinc-700 border-zinc-400 dark:border-zinc-500 text-zinc-800 dark:text-zinc-100'
                    : 'bg-zinc-50 dark:bg-zinc-900 border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600'
                }`}
                title={t('contribute.addModel')}
              >
                +
              </button>
            </div>
            {selectedNames.size === 0 && !showModelPicker && (
              <p className="text-[11px] text-zinc-400">{t('contribute.addModelHint')}</p>
            )}
            {showModelPicker && (
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/60 p-3 space-y-2 max-h-48 overflow-y-auto">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">{t('contribute.pickModelHint')}</p>
                  <button
                    type="button"
                    onClick={() => setShowModelPicker(false)}
                    className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  >
                    {t('contribute.closePicker')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {availableModels
                    .filter((m) => !selectedNames.has(m.name))
                    .map((m) => {
                      const isImage = m.type === 'image';
                      return (
                        <button
                          key={m.name}
                          type="button"
                          onClick={() => toggleModel(m.name)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-mono transition-colors bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:border-blue-400 dark:hover:border-blue-500"
                        >
                          {m.name}
                          <span className="text-[10px] px-1 py-0.5 rounded font-medium bg-zinc-100 dark:bg-zinc-700 text-zinc-500">
                            {isImage ? t('contribute.modelTypeImage') : t('contribute.modelTypeText')}
                          </span>
                        </button>
                      );
                    })}
                  {availableModels.every((m) => selectedNames.has(m.name)) && (
                    <p className="text-[11px] text-zinc-400">{t('contribute.allModelsAdded')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 贡献智能体：默认只展示已选；点 + 添加（须已投射） */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.assistants')}</span>
          {selectedAssistantIds.size > 0 && (
            <span className="text-[11px] text-zinc-400">
              {t('contribute.assistantsSelected', { n: selectedAssistantIds.size })}
            </span>
          )}
        </div>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('contribute.assistantsHint')}</p>
        {availableAssistants.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.noAssistantsHint')}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 items-center">
              {[...selectedAssistantIds].map((id) => {
                const a = availableAssistants.find((x) => x.id === id);
                const label = a ? (a.display_name || a.name) : id;
                const reason = a ? assistantDisabledReason(a) : '';
                return (
                  <button
                    key={id}
                    type="button"
                    title={reason || a?.description || t('contribute.removeAssistant')}
                    onClick={() => toggleAssistant(id)}
                    className={`inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-lg border text-xs transition-colors ${
                      reason
                        ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                        : 'bg-amber-100 dark:bg-amber-900/40 border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200'
                    }`}
                  >
                    <span className="truncate max-w-[14rem]">{label}</span>
                    {reason && <span className="text-[10px] opacity-80">· {reason}</span>}
                    <span className="ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded text-zinc-500 hover:text-red-500" aria-hidden>×</span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setShowAssistantPicker((v) => !v)}
                className={`inline-flex items-center justify-center gap-1 min-w-[2rem] h-7 px-2 rounded-lg border text-sm font-medium transition-colors ${
                  showAssistantPicker
                    ? 'bg-zinc-200 dark:bg-zinc-700 border-zinc-400 dark:border-zinc-500 text-zinc-800 dark:text-zinc-100'
                    : 'bg-zinc-50 dark:bg-zinc-900 border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-amber-400 hover:text-amber-700'
                }`}
                title={t('contribute.addAssistant')}
              >
                +
              </button>
            </div>
            {selectedAssistantIds.size === 0 && !showAssistantPicker && (
              <p className="text-[11px] text-zinc-400">{t('contribute.addAssistantHint')}</p>
            )}
            {showAssistantPicker && (
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/60 p-3 space-y-2 max-h-48 overflow-y-auto">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">{t('contribute.pickAssistantHint')}</p>
                  <button
                    type="button"
                    onClick={() => setShowAssistantPicker(false)}
                    className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  >
                    {t('contribute.closePicker')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {availableAssistants
                    .filter((a) => !selectedAssistantIds.has(a.id) && !assistantDisabledReason(a))
                    .map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        title={a.description || a.name}
                        onClick={() => toggleAssistant(a.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs transition-colors bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:border-amber-400 dark:hover:border-amber-600"
                      >
                        {a.display_name || a.name}
                      </button>
                    ))}
                  {availableAssistants.filter((a) => !selectedAssistantIds.has(a.id) && !assistantDisabledReason(a)).length === 0 && (
                    <p className="text-[11px] text-zinc-400">{t('contribute.noAddableAssistants')}</p>
                  )}
                </div>
              </div>
            )}
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

      <div className="flex flex-wrap gap-2">
        <button onClick={save} disabled={saving}
          className="px-5 py-2 text-sm rounded-lg bg-green-700 hover:bg-green-600 dark:bg-green-800 dark:hover:bg-green-700 disabled:opacity-50 text-white font-medium transition-colors">
          {saving ? t('contribute.savingAndStarting') : t('contribute.saveAndStart')}
        </button>
        <button type="button" onClick={onStop} disabled={!running}
          className="px-5 py-2 text-sm rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-medium transition-colors">
          {t('contribute.stop')}
        </button>
      </div>
    </div>
  );
}

/** 社区智能体标题：账号 + 智能体名（如 adam的写诗专家） */
function communityAgentTitle(a) {
  const owner = String(a?.owner_nickname || '').trim();
  const raw = String(a?.display_name || a?.name || '').trim();
  if (!raw && !owner) return a?.id || '智能体';
  if (!owner) return raw || a?.id || '智能体';
  const prefix = `${owner}的`;
  const base = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
  return `${prefix}${base || a?.name || '智能体'}`;
}

/** 社区智能体卡片左侧图标：按名称着色 + 首字，辅以简易智能体符号 */
function CommunityAgentIcon({ name, selected }) {
  const label = String(name || '?').trim() || '?';
  const initial = label[0].toUpperCase();
  return (
    <div
      className={`relative w-11 h-11 rounded-2xl shrink-0 flex items-center justify-center text-white font-semibold text-base shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${avatarColor(label)} ${
        selected ? 'ring-2 ring-amber-400 dark:ring-amber-500' : ''
      }`}
      aria-hidden
    >
      {/* 右下角小符号，区分「智能体」而非用户头像 */}
      <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-md bg-white dark:bg-zinc-900 flex items-center justify-center shadow-sm">
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 text-zinc-600 dark:text-zinc-300" fill="currentColor">
          <path d="M8 1.5a1 1 0 0 1 1 1V4h1.5a2 2 0 0 1 2 2v1H14a1 1 0 1 1 0 2h-1.5v1a2 2 0 0 1-2 2H9v1.5a1 1 0 1 1-2 0V12H5.5a2 2 0 0 1-2-2v-1H2a1 1 0 1 1 0-2h1.5V6a2 2 0 0 1 2-2H7V2.5a1 1 0 0 1 1-1zM5.5 6v4h5V6h-5z" />
        </svg>
      </span>
      {initial}
    </div>
  );
}

/** 社区智能体：浏览在线名片 → 雇佣/取消雇佣（供游乐场与 MCP；此处不发起任务） */
function CommunityAgentsCard() {
  const { t } = useLang();
  const [agents, setAgents] = useState([]);
  const [hiredIds, setHiredIds] = useState(new Set());
  const [credits, setCredits] = useState(null);
  const [selected, setSelected] = useState(null); // { id, worker_id, display_name, runtime, description }
  const [hireMsg, setHireMsg] = useState('');
  const [err, setErr] = useState('');

  function refreshHired() {
    if (!window.electronAPI?.agent?.listHiredCommunity) return;
    window.electronAPI.agent.listHiredCommunity()
      .then((r) => {
        const ids = new Set((r?.hired || []).map((h) => h.assistant_id));
        setHiredIds(ids);
      })
      .catch(() => {});
  }

  function refresh() {
    listCommunityAgents()
      .then((r) => {
        setAgents(r.data?.agents || []);
        if (r.data?.credits_per_task != null) setCredits(r.data.credits_per_task);
      })
      .catch(() => {
        listPublicCommunityAgents()
          .then((r) => setAgents(r.data?.agents || []))
          .catch(() => setAgents([]));
      });
    refreshHired();
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    function onRefresh() {
      // 贡献配置保存后稍等节点重连再拉列表
      setTimeout(() => refresh(), 800);
    }
    window.addEventListener('tb:community-agents-refresh', onRefresh);
    return () => window.removeEventListener('tb:community-agents-refresh', onRefresh);
  }, []);

  async function hireSelected() {
    if (!selected) return;
    setErr('');
    setHireMsg('');
    try {
      if (!window.electronAPI?.agent?.hireCommunity) {
        throw new Error('请在桌面客户端中雇佣');
      }
      const r = await window.electronAPI.agent.hireCommunity({
        assistant_id: selected.id,
        worker_id: selected.worker_id,
        display_name: selected.display_name,
        runtime: selected.runtime,
        description: selected.description,
      });
      if (!r?.success) throw new Error(r?.error || 'hire failed');
      setHireMsg(t('contribute.hiredOk', { name: selected.display_name || selected.id, id: r.hired?.id }));
      refreshHired();
    } catch (e) {
      setErr(e.message || String(e));
    }
  }

  async function unhireSelected() {
    if (!selected) return;
    setErr('');
    setHireMsg('');
    try {
      if (!window.electronAPI?.agent?.unhireCommunity) {
        throw new Error('请在桌面客户端中操作');
      }
      const r = await window.electronAPI.agent.unhireCommunity(selected.id);
      if (!r?.success) throw new Error(r?.error || 'unhire failed');
      setHireMsg(t('contribute.unhiredOk', { name: selected.display_name || selected.id }));
      refreshHired();
    } catch (e) {
      setErr(e.message || String(e));
    }
  }

  const selectedHired = selected && hiredIds.has(selected.id);

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('contribute.communityAgents')}</h2>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{t('contribute.communityAgentsHint')}</p>
        </div>
        <button type="button" onClick={refresh}
          className="text-xs text-blue-500 hover:text-blue-600 shrink-0">
          {t('contribute.refreshAgents')}
        </button>
      </div>
      {credits != null && (
        <p className="text-[11px] text-zinc-400">{t('contribute.agentTaskCost', { n: credits })}</p>
      )}
      {agents.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.noCommunityAgents')}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-80 overflow-y-auto pr-0.5">
          {agents.map((a) => {
            const key = `${a.worker_id}:${a.id}`;
            const sel = selected && selected.id === a.id && selected.worker_id === a.worker_id;
            const hired = hiredIds.has(a.id);
            const title = communityAgentTitle(a);
            const blurb = String(a.description || '').trim();
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected({
                  id: a.id,
                  worker_id: a.worker_id,
                  display_name: title,
                  runtime: a.runtime,
                  description: a.description,
                  owner_nickname: a.owner_nickname,
                })}
                className={`flex gap-3 text-left p-3 rounded-2xl border transition-all ${
                  sel
                    ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-400 dark:border-amber-600 shadow-md shadow-amber-500/10'
                    : 'bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-700 shadow-sm hover:shadow-md hover:border-zinc-300 dark:hover:border-zinc-500'
                }`}
              >
                <CommunityAgentIcon name={title} selected={sel} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-1.5">
                    <span className={`text-sm font-semibold leading-snug truncate ${
                      sel ? 'text-amber-900 dark:text-amber-100' : 'text-zinc-900 dark:text-zinc-100'
                    }`}>
                      {title}
                    </span>
                    {hired && (
                      <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300">
                        {t('contribute.hiredBadge')}
                      </span>
                    )}
                  </div>
                  {a.runtime && (
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 truncate">
                      {t('contribute.agentRuntime', { runtime: a.runtime })}
                    </p>
                  )}
                  <p className={`text-[11px] mt-1.5 line-clamp-2 leading-relaxed ${
                    blurb
                      ? 'text-zinc-500 dark:text-zinc-400'
                      : 'text-zinc-400 dark:text-zinc-500 italic'
                  }`}>
                    {blurb || t('contribute.noAgentDesc')}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {selected && (
        <div className="space-y-2.5 pt-3 border-t border-zinc-100 dark:border-zinc-700/80">
          <div className="flex gap-3 items-start">
            <CommunityAgentIcon name={selected.display_name || selected.id} selected />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {t('contribute.hireTarget', { name: selected.display_name || selected.id })}
              </p>
              {/* 选中后完整展示简介，便于判断用途 */}
              <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {String(selected.description || '').trim() || t('contribute.noAgentDesc')}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!selectedHired ? (
              <button
                type="button"
                onClick={hireSelected}
                className="px-4 py-1.5 text-sm rounded-lg bg-blue-700 hover:bg-blue-600 text-white font-medium"
              >
                {t('contribute.hireBtn')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={hireSelected}
                  className="px-4 py-1.5 text-sm rounded-lg bg-blue-700 hover:bg-blue-600 text-white font-medium"
                >
                  {t('contribute.hiredAgain')}
                </button>
                <button
                  type="button"
                  onClick={unhireSelected}
                  className="px-4 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 font-medium"
                >
                  {t('contribute.unhireBtn')}
                </button>
              </>
            )}
          </div>
          <p className="text-[11px] text-zinc-400">{t('contribute.hireHint')}</p>
        </div>
      )}
      {hireMsg && <p className="text-sm text-green-600 dark:text-green-400">{hireMsg}</p>}
      {err && <p className="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">{err}</p>}
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
      return true;
    } catch (e) {
      setAgentError(e.message || String(e));
      return false;
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

      <ContributionConfigCard
        onStart={handleStart}
        onStop={handleStop}
        running={running}
        stats={stats}
        agentError={agentError}
      />

      <CommunityAgentsCard />

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

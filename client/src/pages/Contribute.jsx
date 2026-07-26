// client/src/pages/Contribute.jsx
import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
import TruncTip from '../components/TruncTip';
import { useLang } from '../store/lang';
import { useAuth } from '../store/index';
import { fmtContribTokens, fmtCreditCny, creditsToCny } from '../lib/credit-pricing';
import { avatarColor } from '../components/UserAvatar';
function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** 兼容 API 返回 list 或 JSON 字符串 */
function normalizeSettlementResources(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch { /* ignore */ }
  }
  return [];
}

/** 结算时间：去掉 ISO 的 T，显示为 YYYY-MM-DD HH:mm（period_end 为墙钟时间，不按 UTC 偏移） */
function formatSettlementTime(iso) {
  if (!iso) return '—';
  const m = String(iso).trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[1]} ${m[2]}:${m[3]}`;
  return String(iso).slice(0, 16).replace('T', ' ');
}

/** 结算资源展示：模型名原样；agent → 智能体裸名（去掉「昵称的」前缀） */
function formatSettlementResource(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  let raw = s.startsWith('agent:') ? s.slice(6).trim() : s;
  // 兼容 id 形态与「所有者的名称」历史展示名
  raw = raw.replace(/^res-assistant-/, '').replace(/-assistant$/, '');
  const m = raw.match(/^(.+?)的(.+)$/);
  if (m && m[2]) raw = m[2].trim();
  return raw || s;
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

function ContributionConfigCard({ onStart, onStop, running, stats, agentError, onAgentsRefresh }) {
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
      // 内置智能体不出现在贡献列表
      const contributable = (Array.isArray(assistants) ? assistants : []).filter((a) => {
        if (!a) return false;
        if (a.source === 'builtin' || a.metadata?.builtin) return false;
        if (String(a.source_url || '').startsWith('builtin:')) return false;
        return true;
      });
      setAvailableAssistants(contributable);
      const allowedIds = new Set(contributable.map((a) => a.id));
      const prevAsst = new Set(
        (cfg.contribute_assistants || [])
          .map((x) => (typeof x === 'string' ? x : x?.id))
          .filter((id) => id && allowedIds.has(id)),
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
    // 内置智能体不可贡献（列表侧已过滤；此处兜底）
    if (r?.source === 'builtin' || r?.metadata?.builtin
      || String(r?.source_url || '').startsWith('builtin:')) {
      return t('contribute.assistantBuiltinBlocked');
    }
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
      // 启动后触发社区列表刷新（含延迟补刷，等节点重连上报）
      onAgentsRefresh?.();
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
          <TruncTip as="span" title={localGw} className="text-xs font-mono text-green-600 dark:text-green-400">
            {localGw}
          </TruncTip>
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
                  // 仅 × 可移除，避免点 chip 本体误删
                  <span
                    key={name}
                    className={`inline-flex items-center gap-1 pl-2.5 pr-0.5 py-0.5 rounded-lg border text-xs font-mono ${
                      isImage
                        ? 'bg-purple-100 dark:bg-purple-900/40 border-purple-400 dark:border-purple-700 text-purple-700 dark:text-purple-300'
                        : 'bg-blue-100 dark:bg-blue-900/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    }`}
                  >
                    <TruncTip as="span" title={name} className="max-w-[14rem]">{name}</TruncTip>
                    <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${
                      isImage
                        ? 'bg-purple-200 dark:bg-purple-800 text-purple-700 dark:text-purple-300'
                        : 'bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300'
                    }`}>
                      {isImage ? t('contribute.modelTypeImage') : t('contribute.modelTypeText')}
                    </span>
                    <button
                      type="button"
                      title={t('contribute.removeModel')}
                      aria-label={t('contribute.removeModel')}
                      onClick={() => toggleModel(name)}
                      className="ml-0.5 w-5 h-5 inline-flex items-center justify-center rounded text-zinc-500 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowModelPicker((v) => !v)}
                className={`inline-flex items-center justify-center gap-1 min-w-[2rem] h-7 px-2 rounded-lg border text-sm font-medium transition-colors duration-200 cursor-pointer ${
                  showModelPicker
                    ? 'bg-zinc-200 dark:bg-zinc-700 border-zinc-400 dark:border-zinc-500 text-zinc-800 dark:text-zinc-100'
                    : 'bg-zinc-50 dark:bg-zinc-900 border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600'
                }`}
                title={t('contribute.addModel')}
                aria-label={t('contribute.addModel')}
                aria-expanded={showModelPicker}
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
                  // 仅 × 可移除，避免点 chip 本体误删
                  <span
                    key={id}
                    title={reason || a?.description || undefined}
                    className={`inline-flex items-center gap-1 pl-2.5 pr-0.5 py-0.5 rounded-lg border text-xs ${
                      reason
                        ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                        : 'bg-amber-100 dark:bg-amber-900/40 border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200'
                    }`}
                  >
                    <TruncTip as="span" title={label} className="max-w-[14rem]">{label}</TruncTip>
                    {reason && <span className="text-[10px] opacity-80">· {reason}</span>}
                    <button
                      type="button"
                      title={t('contribute.removeAssistant')}
                      aria-label={t('contribute.removeAssistant')}
                      onClick={() => toggleAssistant(id)}
                      className="ml-0.5 w-5 h-5 inline-flex items-center justify-center rounded text-zinc-500 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowAssistantPicker((v) => !v)}
                className={`inline-flex items-center justify-center gap-1 min-w-[2rem] h-7 px-2 rounded-lg border text-sm font-medium transition-colors duration-200 cursor-pointer ${
                  showAssistantPicker
                    ? 'bg-zinc-200 dark:bg-zinc-700 border-zinc-400 dark:border-zinc-500 text-zinc-800 dark:text-zinc-100'
                    : 'bg-zinc-50 dark:bg-zinc-900 border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-amber-400 hover:text-amber-700'
                }`}
                title={t('contribute.addAssistant')}
                aria-label={t('contribute.addAssistant')}
                aria-expanded={showAssistantPicker}
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

      {/* 自动启动：原生 button + switch，保证键盘与读屏可用 */}
      <div className="flex items-center gap-3 select-none">
        <button
          type="button"
          role="switch"
          aria-checked={autoStart}
          aria-label={t('contribute.autoStart')}
          onClick={() => setAutoStart((v) => !v)}
          className={`relative w-11 h-7 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-800 cursor-pointer ${
            autoStart ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
          }`}
        >
          <span
            className={`absolute top-1 left-0 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
              autoStart ? 'translate-x-5' : 'translate-x-1'
            }`}
          />
        </button>
        <span className="text-sm text-zinc-700 dark:text-zinc-300">{t('contribute.autoStart')}</span>
      </div>

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
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-5 py-1.5 text-sm rounded-lg bg-green-700 hover:bg-green-600 dark:bg-green-800 dark:hover:bg-green-700 disabled:opacity-50 text-white font-medium transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed"
        >
          {saving ? t('contribute.savingAndStarting') : t('contribute.saveAndStart')}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!running) return;
            // 停止会下线算力，二次确认避免误触
            if (typeof window !== 'undefined' && !window.confirm(t('contribute.stopConfirm'))) return;
            onStop?.();
          }}
          disabled={!running}
          className="px-5 py-1.5 text-sm rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-medium transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed"
        >
          {t('contribute.stop')}
        </button>
      </div>
    </div>
  );
}

/** 拆分智能体名与所有者（去掉「昵称的」前缀；展示为 owner/name 以区分同名） */
function parseCommunityAgent(a) {
  let owner = String(a?.owner_nickname || '').trim();
  const raw = String(a?.display_name || a?.name || '').trim();
  let name = raw;
  if (owner) {
    const prefix = `${owner}的`;
    if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  } else {
    const m = raw.match(/^(.+?)的(.+)$/);
    if (m && m[2]) {
      owner = m[1].trim();
      name = m[2].trim();
    }
  }
  name = name || String(a?.name || '').trim() || a?.id || '智能体';
  return { name, owner };
}

/** @deprecated 兼容旧调用：仅返回智能体名 */
function communityAgentTitle(a) {
  return parseCommunityAgent(a).name;
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
function CommunityAgentsCard({ refreshKey = 0 }) {
  const { t } = useLang();
  const location = useLocation();
  const [agents, setAgents] = useState([]);
  const [hiredIds, setHiredIds] = useState(new Set());
  const [credits, setCredits] = useState(null);
  const [selected, setSelected] = useState(null); // { id, worker_id, display_name, runtime, description }
  const [hireMsg, setHireMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(''); // '' | 'hire' | 'unhire'
  // KeepAlive 下用 pathname 判断是否在交易页（再次进入需立刻刷新）
  const pageActive = location.pathname === '/contribute';
  const refreshRef = useRef(null);

  function refreshHired() {
    if (!window.electronAPI?.agent?.listHiredCommunity) return;
    window.electronAPI.agent.listHiredCommunity()
      .then((r) => {
        const ids = new Set((r?.hired || []).map((h) => h.assistant_id));
        setHiredIds(ids);
      })
      .catch(() => {});
  }

  /** @param {{ quiet?: boolean }} [opts] quiet=true 时不闪 skeleton（定时/事件刷新） */
  async function refresh(opts = {}) {
    const quiet = !!opts.quiet;
    if (!quiet) setLoading(true);
    try {
      try {
        const r = await listCommunityAgents();
        setAgents(r.data?.agents || []);
        if (r.data?.credits_per_task != null) setCredits(r.data.credits_per_task);
      } catch {
        // 未登录或鉴权失败时回退公开列表
        try {
          const r = await listPublicCommunityAgents();
          setAgents(r.data?.agents || []);
        } catch {
          setAgents([]);
        }
      }
    } finally {
      if (!quiet) setLoading(false);
    }
    refreshHired();
  }
  refreshRef.current = refresh;

  // 进入交易页立即刷新（无定时轮询）
  useEffect(() => {
    if (!pageActive) return;
    refresh({ quiet: agents.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随页面可见性触发
  }, [pageActive]);

  // 保存/停止：立刻刷一次，再于 0.8s、2s 补刷（等节点重连上报名片）
  useEffect(() => {
    if (!refreshKey) return undefined;
    let cancelled = false;
    (async () => {
      await refreshRef.current?.({ quiet: true });
      await new Promise((r) => setTimeout(r, 800));
      if (cancelled) return;
      await refreshRef.current?.({ quiet: true });
      await new Promise((r) => setTimeout(r, 1200));
      if (cancelled) return;
      await refreshRef.current?.({ quiet: true });
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  async function hireSelected() {
    if (!selected || busy) return;
    setErr('');
    setHireMsg('');
    setBusy('hire');
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
    } finally {
      setBusy('');
    }
  }

  async function unhireSelected() {
    if (!selected || busy) return;
    setErr('');
    setHireMsg('');
    setBusy('unhire');
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
    } finally {
      setBusy('');
    }
  }

  const selectedHired = selected && hiredIds.has(selected.id);
  const hireBannerRef = useRef(null);

  // 雇佣结果横幅：数秒后自动收起
  useEffect(() => {
    if (!hireMsg) return undefined;
    hireBannerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    const id = setTimeout(() => setHireMsg(''), 5000);
    return () => clearTimeout(id);
  }, [hireMsg]);

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('contribute.communityAgents')}</h2>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-0.5 leading-relaxed">{t('contribute.communityAgentsHint')}</p>
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 shrink-0 px-1 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
        >
          {t('contribute.refreshAgents')}
        </button>
      </div>
      {hireMsg && (
        <div
          ref={hireBannerRef}
          role="status"
          className="flex items-start gap-2 rounded-xl border border-green-200 dark:border-green-800/60 bg-green-50 dark:bg-green-950/40 px-3 py-2.5"
        >
          <p className="flex-1 text-sm text-green-800 dark:text-green-300 font-medium leading-snug">{hireMsg}</p>
          <button
            type="button"
            onClick={() => setHireMsg('')}
            className="shrink-0 text-xs text-green-700/70 dark:text-green-400/70 hover:text-green-900 dark:hover:text-green-200 cursor-pointer"
            aria-label={t('contribute.hireFeedbackDismiss')}
          >
            ×
          </button>
        </div>
      )}
      {credits != null && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('contribute.agentTaskCost', { n: credits })}</p>
      )}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" aria-busy="true" aria-label={t('contribute.agentsLoading')}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex gap-3 p-3 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 animate-pulse"
            >
              <div className="w-11 h-11 rounded-2xl bg-zinc-200 dark:bg-zinc-700 shrink-0" />
              <div className="flex-1 space-y-2 py-0.5">
                <div className="h-3.5 w-2/3 rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-2.5 w-1/3 rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-2.5 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>
          ))}
        </div>
      ) : agents.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('contribute.noCommunityAgents')}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-80 overflow-y-auto pr-0.5">
          {agents.map((a) => {
            const key = `${a.worker_id}:${a.id}`;
            const sel = selected && selected.id === a.id && selected.worker_id === a.worker_id;
            const hired = hiredIds.has(a.id);
            const { name: title, owner } = parseCommunityAgent(a);
            const blurb = String(a.description || '').trim();
            const fullId = owner ? `${owner}/${title}` : title;
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
                  owner_nickname: owner || a.owner_nickname,
                })}
                className={`flex gap-3 text-left p-3 min-h-[72px] rounded-2xl border transition-all duration-200 cursor-pointer ${
                  sel
                    ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-400 dark:border-amber-600 shadow-md shadow-amber-500/10'
                    : 'bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-700 shadow-sm hover:shadow-md hover:border-zinc-300 dark:hover:border-zinc-500'
                }`}
              >
                <CommunityAgentIcon name={title} selected={sel} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-1.5 min-w-0">
                    {/* 模型式命名：owner/name，区分多人同名 */}
                    <TruncTip
                      as="span"
                      title={fullId}
                      className={`text-sm font-mono font-semibold leading-snug min-w-0 ${
                        sel ? 'text-amber-900 dark:text-amber-100' : 'text-zinc-900 dark:text-zinc-100'
                      }`}
                    >
                      {owner ? (
                        <>
                          <span className={sel ? 'text-amber-700/80 dark:text-amber-300/80' : 'text-zinc-500 dark:text-zinc-400'}>{owner}</span>
                          <span className="text-zinc-400 dark:text-zinc-500 mx-0.5">/</span>
                          <span>{title}</span>
                        </>
                      ) : title}
                    </TruncTip>
                    {hired && (
                      <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300">
                        {t('contribute.hiredBadge')}
                      </span>
                    )}
                  </div>
                  {a.runtime ? (
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 truncate">
                      {t('contribute.agentRuntime', { runtime: a.runtime })}
                    </p>
                  ) : null}
                  {blurb ? (
                    <TruncTip
                      ellipsis={false}
                      title={blurb}
                      className="text-[11px] mt-1.5 line-clamp-2 leading-relaxed text-zinc-500 dark:text-zinc-400"
                    >
                      {blurb}
                    </TruncTip>
                  ) : (
                    <p className="text-[11px] mt-1.5 text-zinc-400 dark:text-zinc-500 italic">
                      {t('contribute.noAgentDesc')}
                    </p>
                  )}
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
              <TruncTip
                className="text-sm font-mono font-semibold text-zinc-800 dark:text-zinc-100"
                title={selected.owner_nickname
                  ? `${selected.owner_nickname}/${selected.display_name || selected.id}`
                  : (selected.display_name || selected.id)}
              >
                {t('contribute.hireTarget', {
                  name: selected.owner_nickname
                    ? `${selected.owner_nickname}/${selected.display_name || selected.id}`
                    : (selected.display_name || selected.id),
                })}
              </TruncTip>
              {selected.runtime ? (
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                  {t('contribute.agentRuntime', { runtime: selected.runtime })}
                </p>
              ) : null}
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
                disabled={!!busy}
                className="px-4 py-1.5 text-sm rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white font-medium transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed"
              >
                {busy === 'hire' ? t('contribute.hiring') : t('contribute.hireBtn')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={hireSelected}
                  disabled={!!busy}
                  className="px-4 py-1.5 text-sm rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white font-medium transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed"
                >
                  {busy === 'hire' ? t('contribute.hiring') : t('contribute.hiredAgain')}
                </button>
                <button
                  type="button"
                  onClick={unhireSelected}
                  disabled={!!busy}
                  className="px-4 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-50 font-medium transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed"
                >
                  {busy === 'unhire' ? t('contribute.unhiring') : t('contribute.unhireBtn')}
                </button>
              </>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">{t('contribute.hireHint')}</p>
        </div>
      )}
      {err && <p className="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap" role="alert">{err}</p>}
    </div>
  );
}

export default function Contribute() {
  const { t, lang } = useLang();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [running,     setRunning]     = useState(false);
  const [stats,       setStats]       = useState(null);
  const [chartData,   setChartData]   = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [summary,     setSummary]     = useState(null);
  const [logs,        setLogs]        = useState([]);
  const [agentError,  setAgentError]  = useState('');
  const [agentsRefreshKey, setAgentsRefreshKey] = useState(0);
  const logRef = useRef(null);

  /** 触发社区智能体列表刷新（保存/停止后） */
  function bumpAgentsRefresh() {
    setAgentsRefreshKey((k) => k + 1);
  }

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

  // KeepAlive 下只挂载一次：登录就绪后拉取，并定时刷新，避免首次失败后一直「暂无」
  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    function loadSettlements() {
      getSettlements()
        .then((r) => {
          if (cancelled) return;
          setSettlements((r.data?.settlements || []).slice(0, 10));
        })
        .catch((e) => {
          console.warn('[contribute] settlements load failed', e?.message || e);
        });
    }
    loadSettlements();
    const id = setInterval(loadSettlements, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user?.id]);

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
      // 停止后刷新社区智能体（本机名片应尽快消失）
      bumpAgentsRefresh();
    } catch (e) {
      setAgentError(e.message || String(e));
    }
  }

  return (
    <div className="px-5 py-5 space-y-5">
      <div>
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t('contribute.title')}</h1>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 leading-relaxed">{t('contribute.subtitle')}</p>
          <button
            type="button"
            onClick={() => navigate('/network')}
            className="electron-no-drag relative z-50 mt-2 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 cursor-pointer transition-colors duration-200"
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

      {/* 我上架：供给侧 */}
      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('contribute.sectionSupply')}</h2>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{t('contribute.sectionSupplyHint')}</p>
        </div>
        <ContributionConfigCard
          onStart={handleStart}
          onStop={handleStop}
          running={running}
          stats={stats}
          agentError={agentError}
          onAgentsRefresh={bumpAgentsRefresh}
        />
      </section>

      {/* 我雇佣：需求侧 */}
      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('contribute.sectionHire')}</h2>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{t('contribute.sectionHireHint')}</p>
        </div>
        <CommunityAgentsCard refreshKey={agentsRefreshKey} />
      </section>

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
          <p className="text-zinc-500 dark:text-zinc-400 text-sm">{t('contribute.noSettlements')}</p>
        ) : (
          <div className="space-y-1.5">
            {settlements.map(s => {
              const resources = normalizeSettlementResources(s.resources);
              // 模型/智能体并入得分括号内，单行展示以压缩高度
              const resHint = resources.length
                ? resources.map((r) => formatSettlementResource(r)).join('、')
                : '';
              const mult = s.multiplier ?? 1;
              const qualityLabel = t('contribute.qualityMult', { n: mult.toFixed(2) });
              return (
              <div
                key={s.id ?? s.period_end}
                className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-2.5 text-sm
                  flex flex-col gap-1.5
                  sm:grid sm:grid-cols-[8.5rem_4.5rem_minmax(0,1fr)_4.5rem] sm:gap-x-2 sm:items-center sm:gap-y-0"
              >
                  <span className="text-zinc-500 dark:text-zinc-400 text-xs tabular-nums">{formatSettlementTime(s.period_end)}</span>
                  <span className="text-zinc-700 dark:text-zinc-300 tabular-nums text-xs sm:text-sm">
                    {fmtContribTokens(s.output_tokens ?? 0)} tok
                  </span>
                  <span className="text-green-600 dark:text-green-400 font-medium min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span>+{(s.credits_awarded ?? 0).toFixed(1)}</span>
                    {/* 星级 + 文字倍率，避免仅靠符号传达质量 */}
                    <span
                      className="text-yellow-600 dark:text-yellow-400 text-xs tracking-tight"
                      title={qualityLabel}
                      aria-label={qualityLabel}
                    >
                      {multiplierToStars(mult)}
                      <span className="ml-1 text-zinc-500 dark:text-zinc-400 tabular-nums font-normal">
                        {mult.toFixed(2)}×
                      </span>
                    </span>
                    {resHint ? (
                      <span className="text-zinc-500 dark:text-zinc-400 font-normal text-xs basis-full sm:basis-auto">
                        ({resHint})
                      </span>
                    ) : null}
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400 text-xs sm:text-right tabular-nums">
                    ≈{fmtCreditCny(creditsToCny(s.credits_awarded))}
                  </span>
              </div>
              );
            })}
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

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { getConfig, getLocalConfig, getGateway } from '../api/adapter';
import { loadGatewayAvailableModels, resolveGatewayModelType, resolveLocalGatewayBase } from '../api/gatewayModels';
import { encodeTierModelRoute } from '../lib/route-binding';
import {
  agentSessionKey,
  getStoreSession,
  mergeTaskIntoStore,
  patchStoreSession,
  readStoreSnapshot,
  resolveTaskRoute,
  resolveSessionKey,
  routeTask,
  routeTaskMirror,
  resolveMirrorRoute,
  resolveFinalizeKey,
  resolveTaskInstance,
  beginSessionInstance,
  eventMatchesSession,
  eventMatchesAgentMirror,
  sessionTaskInstanceMatches,
  setStoreSelectedAgentId,
  getStoreSelectedAgentId,
  releaseAllExecutingSessions,
  releaseExecutingForTask,
  clearSessionTaskState,
  isFreshAgentSession,
  inferSessionKeyFromTask,
  stepsFromTaskStatus,
  resolveArchiveSteps,
  preferRicherSteps,
  getCachedAgentsList,
  setCachedAgentsList,
  archiveCompletedTurn,
  patchDelegation,
  syncDelegatedToAgentTab,
  syncDelegatedMirrorToAgentTab,
  shouldContinueCliSession,
  canResumeInterruptedSession,
  buildInterruptedContinuePrompt,
  normalizeWorkingDir,
  hasOpenToolCalls,
  closePendingToolSteps,
} from '../lib/debug-agent-store';
import { useLang } from '../store/lang';
import {
  mergeStreamText,
  splitInlineReasoning,
  looksLikeInlineReasoning,
  normalizeLoose,
  stripDuplicateThinkingPrefix,
  stripReasoningLeakage,
  looksLikeLeakedReasoning,
  sanitizeThinkingOutputPairs,
} from '../../shared/stream-text-merge.js';
import AgentTabBar from '../components/AgentTabBar';
import ExecutionLog from '../components/ExecutionLog';
import AgentSessionHistoryPanel from '../components/AgentSessionHistoryPanel';
import { saveAgentSessionSnapshot } from '../lib/debug-session-history';

/** 下拉 value：同 id 跨层时用 tier:id，避免 HTML option 重复 value 选中错位 */
function modelSelectValue(m) {
  if (!m) return '';
  const id = m.name || m.id || '';
  return m.tier ? encodeTierModelRoute(m.tier, id) : id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 合并 Agent 流式步骤；output 去重/剥离已展示的 thinking */
function coalesceAgentSteps(prev, stepData) {
  const next = appendCoalescedStep(prev || [], stepData);
  return sanitizeSteps(next);
}

/** 合并相邻/被泄漏 output 分隔的重复 thinking 步骤 */
function dedupeThinkingSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const step of steps) {
    if (step.stepType !== 'thinking') {
      out.push(step);
      continue;
    }
    let j = out.length - 1;
    while (j >= 0 && out[j].stepType === 'output' && looksLikeLeakedReasoning(out[j].content)) {
      j -= 1;
    }
    if (j >= 0 && out[j].stepType === 'thinking') {
      const last = out[j];
      const merged = mergeStreamText(last.content, step.content, {
        isSnapshot: !!step.is_snapshot,
        isDelta: !!step.is_delta,
      });
      const la = normalizeLoose(last.content);
      const lb = normalizeLoose(step.content);
      const lm = normalizeLoose(merged);
      if (la === lb || la === lm || lb === lm || la.startsWith(lb) || lb.startsWith(la)) {
        out[j] = {
          ...last,
          content: String(merged).length >= String(last.content).length
            ? merged
            : last.content,
          timestamp: step.timestamp || last.timestamp,
        };
        continue;
      }
    }
    out.push(step);
  }
  return out;
}

/** 合并被重复 output 步骤（快照与 delta 交替） */
function dedupeOutputSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const step of steps) {
    if (step.stepType !== 'output') {
      out.push(step);
      continue;
    }
    let j = out.length - 1;
    while (j >= 0 && out[j].stepType === 'thinking' && looksLikeLeakedReasoning(out[j].content)) {
      j -= 1;
    }
    const prevOut = [...out].reverse().find(s => s.stepType === 'output');
    if (prevOut) {
      const prevLeaked = looksLikeLeakedReasoning(prevOut.content);
      const nextLeaked = looksLikeLeakedReasoning(step.content);
      // 泄漏推理与用户正文分开保留，避免合并后 sanitize 误删正文
      if (prevLeaked !== nextLeaked) {
        out.push(step);
        continue;
      }
      const merged = mergeStreamText(prevOut.content, step.content, {
        isSnapshot: !!step.is_snapshot,
        isDelta: !!step.is_delta,
      });
      const pa = normalizeLoose(prevOut.content);
      const pb = normalizeLoose(step.content);
      const pm = normalizeLoose(merged);
      if (pa === pb || pa === pm || pb === pm || pa.startsWith(pb) || pb.startsWith(pa)) {
        prevOut.content = String(merged).length >= String(prevOut.content).length
          ? merged
          : prevOut.content;
        prevOut.timestamp = step.timestamp || prevOut.timestamp;
        continue;
      }
    }
    out.push(step);
  }
  return out;
}

/** 全量清理：去掉误分类混合 output + 修复边界 + 尾部剥离 */
function sanitizeSteps(steps) {
  return sanitizeTailOutput(sanitizeThinkingOutputPairs(
    dedupeOutputSteps(dedupeThinkingSteps(dropOrphanMixedOutputs(steps))),
  ));
}

/** 已有 thinking 或后续干净 output 时，删除前面的混合 output */
function dropOrphanMixedOutputs(steps) {
  if (!steps?.length) return steps;
  return steps.filter((step, i, arr) => {
    if (step.stepType !== 'output' || !looksLikeLeakedReasoning(step.content)) return true;
    const hasThinking = arr.some(s => s.stepType === 'thinking');
    const hasLaterClean = arr.slice(i + 1).some(s =>
      s.stepType === 'output' && s.content?.trim() && !looksLikeLeakedReasoning(s.content),
    );
    return !(hasThinking || hasLaterClean);
  });
}

function appendCoalescedStep(steps, stepData) {
  const last = steps[steps.length - 1];
  const type = stepData.stepType || 'output';

  if (last && last.stepType === type && (type === 'output' || type === 'thinking')) {
    const merged = mergeStreamText(last.content, stepData.content, {
      isDelta: !!stepData.is_delta,
      isSnapshot: !!stepData.is_snapshot,
    });
    if (normalizeLoose(merged) === normalizeLoose(last.content)
      && normalizeLoose(merged) === normalizeLoose(stepData.content)) {
      return steps;
    }
    if (merged === last.content && merged === stepData.content) return steps;
    return [
      ...steps.slice(0, -1),
      {
        ...last,
        ...stepData,
        content: merged,
        timestamp: stepData.timestamp || last.timestamp,
        is_delta: undefined,
        is_snapshot: undefined,
      },
    ];
  }

  // 相邻 thinking 内容相同 → 跳过重复
  if (type === 'thinking' && last?.stepType === 'thinking'
    && normalizeLoose(last.content) === normalizeLoose(stepData.content)) {
    return steps;
  }

  if (last && last.stepType === type && last.content === stepData.content) return steps;
  return [...steps, stepData];
}

/** 清理尾部 output：剥离重复推理，仅在无 thinking 步骤时才拆分 */
function sanitizeTailOutput(steps) {
  const last = steps[steps.length - 1];
  if (!last || last.stepType !== 'output') return steps;

  const lastThinking = [...steps].reverse().find(s => s.stepType === 'thinking');
  let content = last.content;

  if (lastThinking) {
    content = stripReasoningLeakage(content, lastThinking.content);
  } else if (looksLikeInlineReasoning(content)) {
    const parts = splitInlineReasoning(content);
    if (parts.some(p => p.stepType === 'thinking')) {
      let acc = steps.slice(0, -1);
      for (const part of parts) {
        acc = appendCoalescedStep(acc, {
          ...last,
          stepType: part.stepType,
          content: part.content,
          is_delta: undefined,
          is_snapshot: undefined,
        });
      }
      return acc;
    }
    const outputs = parts.filter(p => p.stepType === 'output');
    if (outputs.length) content = outputs.map(o => o.content).join('');
  }

  if (content === last.content) return steps;
  // 剥离后为空则丢弃该 output，避免空气泡覆盖已有正文
  if (!String(content || '').trim()) return steps.slice(0, -1);
  return [...steps.slice(0, -1), { ...last, content }];
}

function isAnthropicUrl(url) {
  try { return /anthropic/i.test(new URL(url).hostname + new URL(url).pathname); } catch { return false; }
}

function buildChatUrl(base, anthropic) {
  const b = base.replace(/\/+$/, '');
  return b + (anthropic ? '/v1/messages' : '/v1/chat/completions');
}

function buildImageUrl(base) {
  return base.replace(/\/+$/, '') + '/v1/images/generations';
}

function toAnthropicBody(messages, model, stream) {
  const sys = messages.find(m => m.role === 'system');
  const sysText = !sys ? undefined
    : typeof sys.content === 'string' ? sys.content
    : Array.isArray(sys.content) ? sys.content.map(b => b.text || '').join('') : '';
  return {
    model, max_tokens: 8096, stream: !!stream,
    messages: messages.filter(m => m.role !== 'system'),
    ...(sysText ? { system: sysText } : {}),
  };
}

function parseSseLines(lines, anthropic, firstTokenTime, onChunk, evRef) {
  for (const line of lines) {
    const t = line.trimEnd();
    if (!t) { evRef.v = null; continue; }
    if (anthropic) {
      if (t.startsWith('event: ')) { evRef.v = t.slice(7).trim(); }
      else if (t.startsWith('data: ') && evRef.v === 'content_block_delta') {
        try {
          const d = JSON.parse(t.slice(6));
          const text = d.delta?.type === 'text_delta' ? d.delta.text : '';
          if (text) { if (firstTokenTime.v === null) firstTokenTime.v = Date.now(); onChunk(text); }
        } catch {}
      }
    } else {
      if (t === 'data: [DONE]') continue;
      if (t.startsWith('data: ')) {
        try {
          const d = JSON.parse(t.slice(6));
          const delta = d.choices?.[0]?.delta?.content ?? '';
          if (delta) { if (firstTokenTime.v === null) firstTokenTime.v = Date.now(); onChunk(delta); }
        } catch {}
      }
    }
  }
}

async function doStreamChat({ baseUrl, token, model, messages, stream, anthropic, onChunk, onDone, onError }) {
  const url = buildChatUrl(baseUrl, anthropic);
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    if (anthropic) { headers['x-api-key'] = token; headers['anthropic-version'] = '2023-06-01'; }
    else headers['Authorization'] = `Bearer ${token}`;
  }
  const body = JSON.stringify(anthropic ? toAnthropicBody(messages, model, stream) : { model, messages, stream });
  const startTime = Date.now();
  const firstTokenTime = { v: null };

  const useIpc = !!window.electronAPI?.llm;
  if (useIpc) {
    if (!stream) {
      try {
        const r = await window.electronAPI.llm.fetch(url, { method: 'POST', headers, body });
        if (r.status >= 300) { onError(`HTTP ${r.status}: ${r.body}`); return; }
        const data = JSON.parse(r.body);
        const content = anthropic
          ? (data.content || []).map(b => b.text || '').join('')
          : (data.choices?.[0]?.message?.content ?? '');
        onChunk(content);
        onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      } catch (e) { onError(e.message); }
      return;
    }
    await new Promise(resolve => {
      let buf = ''; const evRef = { v: null };
      window.electronAPI.llm.stream({ url, method: 'POST', headers, body },
        raw => {
          buf += raw;
          const lines = buf.split('\n'); buf = lines.pop();
          parseSseLines(lines, anthropic, firstTokenTime, onChunk, evRef);
        },
        () => { onDone({ firstTokenMs: firstTokenTime.v ? firstTokenTime.v - startTime : null, totalMs: Date.now() - startTime }); resolve(); },
        err => { onError(err); resolve(); }
      );
    });
    return;
  }

  try {
    const resp = await fetch(url, { method: 'POST', headers, body });
    if (!resp.ok) { onError(`HTTP ${resp.status}: ${await resp.text()}`); return; }
    if (!stream) {
      const data = await resp.json();
      const content = anthropic
        ? (data.content || []).map(b => b.text || '').join('')
        : (data.choices?.[0]?.message?.content ?? '');
      onChunk(content);
      onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      return;
    }
    const reader = resp.body.getReader(); const decoder = new TextDecoder();
    let buf = ''; const evRef = { v: null };
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      parseSseLines(lines, anthropic, firstTokenTime, onChunk, evRef);
    }
    onDone({ firstTokenMs: firstTokenTime.v ? firstTokenTime.v - startTime : null, totalMs: Date.now() - startTime });
  } catch (e) { onError(e.message); }
}

async function doGenerateImage({ baseUrl, token, model, prompt, ratio, resolution, onDone, onError, t }) {
  const url = buildImageUrl(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const extra = {};
  if (ratio) extra.ratio = ratio;
  if (resolution) extra.resolution = resolution;
  const body = JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json', ...extra });
  const startTime = Date.now();

  const parse = async (text) => {
    let data = JSON.parse(text);
    // 网关曾把截断后的 JSON 字符串二次序列化，需再 parse 一层
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error(t('debug.emptyImageList', { text: text.slice(0, 200) })); }
    }
    const errMsg = data.detail
      || (typeof data.error === 'string' ? data.error : data.error?.message);
    if (errMsg) throw new Error(errMsg);
    const images = (Array.isArray(data.data) ? data.data : [])
      .map(item => (item && (item.b64_json || item.url || item.image?.url)) || '')
      .filter(Boolean);
    if (!images.length) throw new Error(t('debug.emptyImageList', { text: text.slice(0, 200) }));
    onDone({ images, totalMs: Date.now() - startTime });
  };

  try {
    if (window.electronAPI?.llm) {
      const r = await window.electronAPI.llm.fetch(url, {
        method: 'POST', headers, body, timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
      });
      if (r.status >= 300 || r.status === 0) {
        onError(r.status === 0 ? (r.body || t('debug.imageTimeout')) : `HTTP ${r.status}: ${r.body}`);
        return;
      }
      await parse(r.body);
    } else {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS) : null;
      try {
        const resp = await fetch(url, { method: 'POST', headers, body, signal: ctrl?.signal });
        if (!resp.ok) { onError(`HTTP ${resp.status}: ${await resp.text()}`); return; }
        await parse(await resp.text());
      } catch (e) {
        if (e?.name === 'AbortError') onError(t('debug.imageTimeout'));
        else onError(e.message);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } catch (e) { onError(e.message); }
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** 图像生成 IPC/HTTP 超时（须 ≥ 上游轮询耗时，如即梦 ~30–60s） */
const IMAGE_FETCH_TIMEOUT_MS = 300_000;

const LOCAL_GW = { id: '__local_gw__', base_url: 'http://127.0.0.1:11430', token: '', models: [] };
const CUSTOM   = { id: '__custom__',   base_url: '', token: '', models: [] };

const TIER_ORDER = ['free', 'p2p', 'paid'];

function normModel(m) { return typeof m === 'string' ? { name: m, type: 'chat' } : { name: m.name, type: m.type || 'chat' }; }

function providerOptions(cfg, localCfg, localGw, t) {
  // 本地网关模型由 loadGatewayAvailableModels() 动态拉取（含 free/p2p/paid）
  const opts = [{ ...localGw, label: t('debug.localGw'), models: [] }];
  for (const p of (cfg?.providers || [])) {
    if (!p.enabled || p.type === 'p2p' || !p.base_url) continue;
    const label = (() => { try { return new URL(p.base_url).hostname; } catch { return p.id; } })();
    opts.push({ id: p.id, label, base_url: p.base_url, token: p.token || '', models: (p.models || []).map(normModel) });
  }
  // P2P backend from local-config cloud_config
  const cc = localCfg?.cloud_config;
  if (cc?.url) {
    const label = (() => { try { return new URL(cc.url).hostname; } catch { return t('debug.p2pBackend'); } })();
    opts.push({ id: '__p2p__', label: `🌐 ${label}`, base_url: cc.url, token: cc.token || '', models: [] });
  }
  opts.push({ ...CUSTOM, label: t('debug.custom') });
  return opts;
}

const defaultPanel = () => ({ conversation: [], input: '', systemPrompt: '', showSystem: false, streamMode: true, imageMode: false, imageRatio: '', imageResolution: '' });

/** localStorage 键：调试页聊天记录（切换页面/重启后恢复） */
const DEBUG_CHAT_KEY = 'tokenbank.debug.chat';
const DEBUG_CHAT_MAX = 200;
const B64_OMITTED = '__b64_omitted__';

/** 持久化前清洗：去掉流式态；图片 base64 过大则仅存占位符 */
function serializeDebugMessage(msg) {
  const base = { ...msg, streaming: false, generating: false };
  if (!Array.isArray(base.images)) return base;
  return {
    ...base,
    images: base.images.map(src => {
      if (!src || src === B64_OMITTED) return B64_OMITTED;
      if (String(src).startsWith('http')) return src;
      return B64_OMITTED;
    }),
  };
}

function loadDebugPanel() {
  try {
    const raw = localStorage.getItem(DEBUG_CHAT_KEY);
    if (!raw) return defaultPanel();
    const data = JSON.parse(raw);
    const conversation = (Array.isArray(data.conversation) ? data.conversation : [])
      .slice(-DEBUG_CHAT_MAX)
      .map(m => ({ ...m, streaming: false, generating: false }));
    return {
      ...defaultPanel(),
      conversation,
      systemPrompt: data.systemPrompt || '',
      showSystem: !!data.showSystem,
      streamMode: data.streamMode !== false,
      imageMode: !!data.imageMode,
      imageRatio: data.imageRatio || '',
      imageResolution: data.imageResolution || '',
    };
  } catch {
    return defaultPanel();
  }
}

function persistDebugPanel(panel) {
  try {
    localStorage.setItem(DEBUG_CHAT_KEY, JSON.stringify({
      conversation: (panel.conversation || []).slice(-DEBUG_CHAT_MAX).map(serializeDebugMessage),
      systemPrompt: panel.systemPrompt || '',
      showSystem: !!panel.showSystem,
      streamMode: panel.streamMode !== false,
      imageMode: !!panel.imageMode,
      imageRatio: panel.imageRatio || '',
      imageResolution: panel.imageResolution || '',
    }));
  } catch { /* quota 超限等：忽略，不影响当前会话 */ }
}

function clearDebugPanelStorage() {
  try { localStorage.removeItem(DEBUG_CHAT_KEY); } catch {}
}

// ── Agent 模式常量 ─────────────────────────────────────────────────────────────

const MAIN_AGENT_STORAGE_KEY = 'tokenbank.mainAgentId';
const MCP_PROFILE_STORAGE_KEY = 'tokenbank.mcpProfileId';
const AGENT_WORKING_DIR_KEY = 'tokenbank.agentWorkingDir';
const DEBUG_MODE_KEY = 'tokenbank.debugMode';

function loadMainAgentId() {
  try { return localStorage.getItem(MAIN_AGENT_STORAGE_KEY) || ''; } catch { return ''; }
}

function loadMcpProfileId() {
  try { return localStorage.getItem(MCP_PROFILE_STORAGE_KEY) || 'orchestrator-default'; } catch { return 'orchestrator-default'; }
}

function saveMainAgentId(id) {
  try {
    if (id) localStorage.setItem(MAIN_AGENT_STORAGE_KEY, id);
    else localStorage.removeItem(MAIN_AGENT_STORAGE_KEY);
  } catch {}
}

function saveMcpProfileId(id) {
  try {
    if (id) localStorage.setItem(MCP_PROFILE_STORAGE_KEY, id);
    else localStorage.removeItem(MCP_PROFILE_STORAGE_KEY);
  } catch {}
}

function loadAgentWorkingDir() {
  try { return localStorage.getItem(AGENT_WORKING_DIR_KEY) || ''; } catch { return ''; }
}

function saveAgentWorkingDir(dir) {
  try {
    if (dir) localStorage.setItem(AGENT_WORKING_DIR_KEY, dir);
    else localStorage.removeItem(AGENT_WORKING_DIR_KEY);
  } catch {}
}

function loadDebugMode() {
  try { return localStorage.getItem(DEBUG_MODE_KEY) || 'llm'; } catch { return 'llm'; }
}

function saveDebugMode(mode) {
  try { localStorage.setItem(DEBUG_MODE_KEY, mode); } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Debug() {
  const { t } = useLang();
  const location = useLocation();
  const isDebugRouteRef = useRef(location.pathname === '/debug');
  isDebugRouteRef.current = location.pathname === '/debug';
  
  // 模式切换：'llm' | 'agent'
  const [mode, setMode] = useState(() => loadDebugMode());
  
  // LLM 模式状态
  const [cfg,            setCfg]           = useState(null);
  const [provOpts,       setProvOpts]      = useState([]);
  const [selectedId,     setSelectedId]    = useState('__local_gw__');
  const [manualBaseUrl,  setManualBaseUrl] = useState('');
  const [token,          setToken]         = useState('');
  const [showToken,      setShowToken]     = useState(false);
  const [models,         setModels]        = useState([]);   // {name, type}[]
  const [model,          setModel]         = useState('');
  const [manualModel,    setManualModel]   = useState(false);
  const [loadingModels,  setLoadingModels] = useState(false);
  const [panels,         setPanels]        = useState(() => ({ main: loadDebugPanel() }));
  const [sending,        setSending]       = useState(false);
  const [lightbox,       setLightbox]      = useState(null);
  // LLM 模式：从资产加载的提示词列表，选中后填入 System
  const [promptList,     setPromptList]    = useState([]);
  const [selectedPromptId, setSelectedPromptId] = useState('');

  // Agent 模式状态
  const [agents, setAgents] = useState(() => getCachedAgentsList() || []);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentWorkingDir, setAgentWorkingDir] = useState(() => loadAgentWorkingDir());
  const [dirError, setDirError] = useState('');
  const [currentUserPrompt, setCurrentUserPrompt] = useState('');
  const [currentTask, setCurrentTask] = useState(null);
  const [taskSteps, setTaskSteps] = useState([]);
  const [taskResult, setTaskResult] = useState(null);
  const [executing, setExecuting] = useState(false);
  const [mainAgentId, setMainAgentId] = useState(() => loadMainAgentId());
  const [mcpProfiles, setMcpProfiles] = useState([]);
  const [mcpProfileId, setMcpProfileId] = useState(() => loadMcpProfileId());
  const [delegations, setDelegations] = useState({});
  const [conversationTurns, setConversationTurns] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 任意会话 executing 变化时递增，驱动侧栏运行绿点刷新
  const [runningRev, setRunningRev] = useState(0);
  const agentTextareaRef = useRef(null);
  const selectedAgentRef = useRef(null);
  selectedAgentRef.current = selectedAgent;
  const agentsRef = useRef([]);
  agentsRef.current = agents;
  const syncSessionToStateRef = useRef(null);
  const finalizeTaskInUiRef = useRef(null);
  const finishDelegatedChildRef = useRef(null);

  // 当前生效的 Agent：直调 tab 或聚合入口的主 Agent
  const mainAgent = agents.find(a => a.id === mainAgentId && !a.custom)
    || agents.find(a => !a.custom)
    || null;
  const isHubMode = !selectedAgent;
  const activeAgent = isHubMode ? mainAgent : selectedAgent;

  /** 将当前标签页已完成对话写入本地历史（新会话前/归档后） */
  function persistCurrentSessionHistory(key) {
    if (!key) return;
    const sess = getStoreSession(key);
    if (!sess.conversationTurns?.length) return;
    saveAgentSessionSnapshot(key, {
      conversationTurns: sess.conversationTurns,
      sessionWorkingDir: sess.sessionWorkingDir,
      cliSessionId: sess.cliSessionId,
    });
  }

  /** 恢复历史会话到当前标签页 */
  function applyHistorySnapshot(execKey, snapshot) {
    if (!execKey || !snapshot) return;
    patchSession(execKey, {
      conversationTurns: snapshot.conversationTurns || [],
      currentUserPrompt: '',
      taskSteps: [],
      taskResult: null,
      currentTask: null,
      executing: false,
      delegations: {},
      agentPrompt: '',
      sessionWorkingDir: snapshot.sessionWorkingDir || getStoreSession(execKey).sessionWorkingDir || '',
      cliSessionId: snapshot.cliSessionId || null,
      skipHistoryRecover: Date.now(),
    });
    if (snapshot.sessionWorkingDir) {
      setAgentWorkingDir(snapshot.sessionWorkingDir);
      saveAgentWorkingDir(snapshot.sessionWorkingDir);
    }
    syncSessionToState(execKey);
  }

  function restoreHistorySession(snapshot) {
    const execKey = agentSessionKey(selectedAgent);
    if (executing) {
      cancelAgent().then(() => applyHistorySnapshot(execKey, snapshot));
      return;
    }
    applyHistorySnapshot(execKey, snapshot);
  }

  const panel = panels.main;
  const { conversation, input, systemPrompt, showSystem, streamMode, imageMode, imageRatio, imageResolution } = panel;

  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);

  // 进入游乐场即预加载 Agent / 提示词（切换模式时无需再等）
  useEffect(() => {
    loadAgents();
    loadPromptList();
  }, []);

  // 游乐场 keep-alive：从「资产」返回时强制刷新智能体与提示词
  const prevDebugPathRef = useRef(location.pathname);
  useEffect(() => {
    const wasActive = prevDebugPathRef.current === '/debug';
    prevDebugPathRef.current = location.pathname;
    if (location.pathname === '/debug' && !wasActive) {
      loadAgents({ force: true });
      loadPromptList();
    }
  }, [location.pathname]);

  // 切到 LLM 模式时刷新提示词（资产页新建后可立即选用）
  useEffect(() => {
    if (mode === 'llm') loadPromptList();
  }, [mode]);

  // Load Agents when switching to agent mode（缓存为空时补拉）
  useEffect(() => {
    if (mode === 'agent' && agents.length === 0 && !loadingAgents) {
      loadAgents();
    }
  }, [mode]);

  // 加载 MCP Profile 列表（聚合入口编排用）
  useEffect(() => {
    if (mode !== 'agent' || !window.electronAPI?.mcp) return;
    window.electronAPI.mcp.listProfiles()
      .then(res => {
        if (res.success && res.profiles?.length) {
          setMcpProfiles(res.profiles);
          if (!res.profiles.some(p => p.id === mcpProfileId)) {
            const fallback = res.profiles.find(p => p.id === 'orchestrator-default')?.id
              || res.profiles[0].id;
            setMcpProfileId(fallback);
            saveMcpProfileId(fallback);
          }
        }
      })
      .catch(err => console.warn('Failed to load MCP profiles:', err));
  }, [mode]);

  const autoFinalizeTimersRef = useRef({});

  /** 同步 JSON 步骤到齐后延迟收尾（IPC completed 丢失兜底） */
  function scheduleAutoFinalize(taskId, key) {
    if (!taskId || !key) return;
    const timers = autoFinalizeTimersRef.current;
    if (timers[taskId]) clearTimeout(timers[taskId]);
    timers[taskId] = setTimeout(async () => {
      delete timers[taskId];
      const sess = getStoreSession(key);
      if (isFreshAgentSession(sess)) return;
      if (!sessionTaskInstanceMatches(sess, taskId)) return;
      if (!sess.executing) return;
      const routed = resolveTaskRoute(taskId, null, null, agentsRef.current);
      const mirrorKey = resolveMirrorRoute(taskId);
      const isMirrorTab = mirrorKey === key
        || (sess.currentTask?.parentTaskId && sess.currentTask?.id === taskId);
      if (routed && routed !== key && !isMirrorTab) return;
      if (sess.currentTask?.id && sess.currentTask.id !== taskId) return;

      try {
        const res = await window.electronAPI.agent.getTaskStatus(taskId);
        if (res.success && ['completed', 'failed', 'cancelled'].includes(res.status?.status)) {
          const status = res.status;
          const terminal = status.status;
          if (status.context?.parentTaskId || sess.currentTask?.parentTaskId) {
            finishDelegatedChildRef.current?.(
              { taskId, agentId: status.agent_id, sessionInstanceId: status.context?.sessionInstanceId, result: status.result },
              status,
              terminal,
            );
            return;
          }
          const steps = resolveTaskSteps(status, { taskId, result: status.result }, key);
          finalizeTaskInUiRef.current?.(taskId, key, {
            currentTask: { ...status, status: status.status },
            currentUserPrompt: status.prompt || sess.currentUserPrompt,
            taskResult: status.result || null,
            taskSteps: preferRicherSteps(steps, sess.taskSteps || []),
          });
          return;
        }
      } catch { /* ignore */ }

      if (!sess.taskSteps?.some(s => s.content?.trim())) return;
      // 派发镜像：有步骤但 DB 未终态时，仍走委派收尾
      if (sess.currentTask?.parentTaskId) {
        finishDelegatedChildRef.current?.(
          { taskId, sessionInstanceId: resolveTaskInstance(taskId) },
          null,
          'completed',
        );
        return;
      }
      // 尚无用户可见正文时不提前收尾（避免只归档推理过程）
      const hasCleanOutput = sess.taskSteps.some(s =>
        s.stepType === 'output' && s.content?.trim() && !looksLikeLeakedReasoning(s.content),
      );
      if (!hasCleanOutput) return;

      const summary = sess.taskSteps
        .filter(s => s.stepType === 'output' && s.content?.trim())
        .map(s => s.content)
        .join('\n\n')
        || sess.taskSteps
          .filter(s => s.stepType === 'thinking' && s.content?.trim())
          .map(s => s.content)
          .join('\n\n')
        || null;
      finalizeTaskInUiRef.current?.(taskId, key, {
        currentTask: { id: taskId, status: 'completed', completed_at: Date.now() },
        currentUserPrompt: sess.currentUserPrompt,
        taskResult: {
          ...(summary ? { summary } : {}),
          cliSessionId: sess.cliSessionId || null,
        },
        taskSteps: sess.taskSteps,
      });
    }, 600);
  }
  const scheduleAutoFinalizeRef = useRef(scheduleAutoFinalize);
  scheduleAutoFinalizeRef.current = scheduleAutoFinalize;

  /** 切换标签时从 DB 恢复最近任务（派发完成但前端未同步时） */
  const recoverSessionHistory = useCallback(async (syncKey) => {
    if (!syncKey || syncKey === '__hub__') return;
    if (!window.electronAPI?.agent?.listRecentTasks) return;
    const sess = getStoreSession(syncKey);
    if (sess.currentUserPrompt || sess.taskSteps?.length || sess.executing || sess.conversationTurns?.length) return;
    // 「新会话」后切换窗口/标签，不回填任何历史（含旧派发）
    if (sess.skipHistoryRecover && Date.now() - sess.skipHistoryRecover < 120_000) return;

    try {
      const res = await window.electronAPI.agent.listRecentTasks({ agentId: syncKey, limit: 1 });
      if (!res.success || !res.tasks?.length) return;
      const recent = res.tasks[0];
      mergeTaskIntoStore(recent);
      syncSessionToStateRef.current?.(syncKey);
    } catch (err) {
      console.warn('[Debug] recoverSessionHistory failed:', err);
    }
  }, []);

  // Agent 列表加载后，校验主 Agent 偏好并恢复上次选中的 Agent 标签
  useEffect(() => {
    if (!agents.length) return;
    const cliAgents = agents.filter(a => !a.custom && a.type !== 'assistant');
    if (cliAgents.length) {
      if (!mainAgentId || !cliAgents.some(a => a.id === mainAgentId)) {
        const fallback = cliAgents[0].id;
        setMainAgentId(fallback);
        saveMainAgentId(fallback);
      }
    }
    const savedId = getStoreSelectedAgentId();
    if (savedId && agents.some(a => a.id === savedId)) {
      const agent = agents.find(a => a.id === savedId);
      if (agent && selectedAgent?.id !== savedId) {
        setSelectedAgent(agent);
        selectedAgentRef.current = agent;
        syncSessionToState(savedId);
        recoverSessionHistory(savedId);
      }
    }
  }, [agents, mainAgentId]);

  function setMainAgent(agent) {
    if (!agent?.id || agent.custom || agent.type === 'assistant') return;
    setMainAgentId(agent.id);
    saveMainAgentId(agent.id);
  }

  /**
   * @param {string} key
   * @param {{ preserveAgentPrompt?: boolean }} [opts]
   *   preserveAgentPrompt：保留输入框正文（轮询/步骤推送时勿用 store 空串覆盖）
   */
  function syncSessionToState(key, opts = {}) {
    const saved = readStoreSnapshot(key);
    if (!opts.preserveAgentPrompt) {
      setAgentPrompt(saved.agentPrompt || '');
    }
    setCurrentUserPrompt(saved.currentUserPrompt || '');
    setCurrentTask(saved.currentTask || null);
    setTaskSteps(saved.taskSteps || []);
    setTaskResult(saved.taskResult || null);
    setExecuting(!!saved.executing);
    setDelegations(saved.delegations || {});
    setConversationTurns(saved.conversationTurns || []);
  }
  syncSessionToStateRef.current = syncSessionToState;

  /** 更新模块级会话；当前标签页被修改时立即同步 React state */
  function patchSession(key, patch) {
    const prevExec = !!getStoreSession(key).executing;
    patchStoreSession(key, patch);
    if ('executing' in patch && !!patch.executing !== prevExec) {
      setRunningRev(r => r + 1);
    }
    if (!isDebugRouteRef.current) return getStoreSession(key);

    const activeKey = agentSessionKey(selectedAgentRef.current);
    if (activeKey === key) {
      // 未显式改 agentPrompt 时保留输入框，避免步骤/轮询把正在输入的内容清掉
      syncSessionToState(key, { preserveAgentPrompt: !('agentPrompt' in patch) });
      return getStoreSession(key);
    }

    // 子 Agent 任务完成时，若当前正在看聚合入口，同步 hub 派发状态
    const patchTaskId = patch.currentTask?.id;
    const routedKey = patchTaskId
      ? resolveTaskRoute(patchTaskId, null, null, agentsRef.current)
      : null;
    if (activeKey === '__hub__' && (key === '__hub__' || routedKey === '__hub__')) {
      syncSessionToState('__hub__', { preserveAgentPrompt: !('agentPrompt' in patch) });
    } else if (patch.executing === false && routedKey === activeKey) {
      syncSessionToState(activeKey, { preserveAgentPrompt: true });
    }
    return getStoreSession(key);
  }

  /** 任务结束：释放 executing、归档对话轮次并同步当前标签页 */
  function finalizeTaskInUi(taskId, key, patch) {
    const resolvedKey = resolveFinalizeKey(taskId, key, agentsRef.current);
    if (!resolvedKey) return;
    const sess = getStoreSession(resolvedKey);

    // 用户已开新会话：仅释放 executing 锁，避免迟到事件把旧输出写回空白页
    if (isFreshAgentSession(sess)) {
      releaseExecutingForTask(taskId, { status: patch.currentTask?.status });
      return;
    }

    const touched = releaseExecutingForTask(taskId, {
      status: patch.currentTask?.status,
    });
    const terminal = patch.currentTask?.status;
    if (resolvedKey && terminal && ['completed', 'failed', 'cancelled'].includes(terminal)) {
      const rawSteps = preferRicherSteps(patch.taskSteps || [], sess.taskSteps || []);
      const archiveSteps = closePendingToolSteps(
        rawSteps,
        terminal === 'cancelled' ? '已中止' : '未收到结果',
      );
      archiveCompletedTurn(resolvedKey, {
        user: patch.currentUserPrompt || sess.currentUserPrompt,
        steps: archiveSteps,
        delegations: sess.delegations || {},
        result: patch.taskResult || sess.taskResult || null,
        status: terminal === 'cancelled' ? 'failed' : terminal,
        taskId,
        cliSessionId: patch.taskResult?.cliSessionId || sess.cliSessionId || null,
        workingDir: normalizeWorkingDir(sess.sessionWorkingDir || agentWorkingDir.trim()),
        timestamp: patch.currentTask?.completed_at || Date.now(),
      });
    }

    if (resolvedKey) {
      const afterArchive = getStoreSession(resolvedKey);
      const wasRunning = !!afterArchive.executing;
      patchStoreSession(resolvedKey, {
        currentTask: patch.currentTask,
        executing: false,
        // 已归档到 conversationTurns，避免与当前轮重复展示
        currentUserPrompt: '',
        taskSteps: [],
        taskResult: null,
        delegations: {},
        conversationTurns: afterArchive.conversationTurns,
        // 中止也保留 sessionId，便于停止后续接
        cliSessionId: patch.taskResult?.cliSessionId || afterArchive.cliSessionId || null,
        sessionWorkingDir: afterArchive.sessionWorkingDir,
      });
      if (wasRunning) setRunningRev(r => r + 1);
      persistCurrentSessionHistory(resolvedKey);
    }

    if (!isDebugRouteRef.current) return;
    const activeKey = agentSessionKey(selectedAgentRef.current);
    const routedKey = resolveTaskRoute(taskId, null, null, agentsRef.current);
    const mirrorKey = resolveMirrorRoute(taskId);
    const activeSess = getStoreSession(activeKey);
    const shouldSync = touched.includes(activeKey)
      || activeKey === resolvedKey
      || activeKey === mirrorKey
      || routedKey === activeKey
      || activeSess.currentTask?.id === taskId
      || (activeSess.executing && (routedKey === activeKey || mirrorKey === activeKey));
    if (shouldSync) syncSessionToState(activeKey);
  }
  finalizeTaskInUiRef.current = finalizeTaskInUi;

  const recoverActiveTasks = useCallback(async (syncKey) => {
    if (!window.electronAPI?.agent?.listActiveTasks) return false;
    try {
      const res = await window.electronAPI.agent.listActiveTasks();
      if (!res.success) return false;
      const tasks = res.tasks || [];
      for (const task of tasks) mergeTaskIntoStore(task);

      // 当前标签：后端仍在跑但 UI 已空闲 → 强制拉回进行中
      const key = syncKey || agentSessionKey(selectedAgentRef.current);
      const activeForKey = tasks.find((t) => {
        const k = inferSessionKeyFromTask(t);
        return k === key && ['running', 'pending'].includes(t.status);
      });
      const sess = getStoreSession(key);
      if (activeForKey && !sess.executing) {
        mergeTaskIntoStore(activeForKey);
        setRunningRev(r => r + 1);
      }
      // 后端已无进行中任务，但 UI 仍锁着 → 用状态收尾（避免假「执行中」）
      if (!activeForKey && sess.executing && sess.currentTask?.id) {
        try {
          const st = await window.electronAPI.agent.getTaskStatus(sess.currentTask.id);
          if (st.success && ['completed', 'failed', 'cancelled'].includes(st.status?.status)) {
            finalizeTaskInUiRef.current?.(sess.currentTask.id, key, {
              currentTask: { ...st.status, status: st.status.status },
              currentUserPrompt: st.status.prompt || sess.currentUserPrompt,
              taskResult: st.status.result || null,
              taskSteps: preferRicherSteps(
                stepsFromTaskStatus(st.status),
                sess.taskSteps || [],
              ),
            });
          }
        } catch { /* ignore */ }
      }

      // 对账只刷新任务态，绝不覆盖输入框
      syncSessionToStateRef.current?.(key, { preserveAgentPrompt: true });
      return tasks.some(t => ['running', 'pending'].includes(t.status));
    } catch (err) {
      console.warn('[Debug] recoverActiveTasks failed:', err);
      return false;
    }
  }, []);

  /** 镜像标签卡在 executing 时，从 DB 拉取子任务终态并收尾 */
  async function recoverStuckMirrorTask(agentKey) {
    if (!agentKey || agentKey === '__hub__' || !window.electronAPI?.agent) return;
    const sess = getStoreSession(agentKey);
    if (!sess.executing || !sess.currentTask?.id || !sess.currentTask?.parentTaskId) return;
    if (!sessionTaskInstanceMatches(sess, sess.currentTask.id)) return;
    try {
      const res = await window.electronAPI.agent.getTaskStatus(sess.currentTask.id);
      if (!res.success) return;
      const status = res.status;
      if (!['completed', 'failed', 'cancelled'].includes(status.status)) return;
      finishDelegatedChildRef.current?.(
        {
          taskId: sess.currentTask.id,
          agentId: status.agent_id,
          sessionInstanceId: status.context?.sessionInstanceId,
          result: status.result,
        },
        status,
        status.status,
      );
      syncSessionToState(agentKey);
    } catch {
      // ignore
    }
  }

  // 切换侧边栏回到调试页时，从 store / 后端恢复进行中的任务
  useEffect(() => {
    if (location.pathname !== '/debug') return;
    const key = agentSessionKey(selectedAgent);
    // 恢复全局工作目录（切换菜单后可能未同步到 React state）
    const savedDir = loadAgentWorkingDir();
    if (savedDir && savedDir !== agentWorkingDir) {
      setAgentWorkingDir(savedDir);
    }
    syncSessionToState(key);
    recoverActiveTasks(key);
    syncDelegatedMirrorToAgentTab(key, agentsRef.current);
    syncSessionToState(key);
    recoverStuckMirrorTask(key);
    recoverSessionHistory(key);
  }, [location.pathname, selectedAgent, recoverActiveTasks, recoverSessionHistory]);

  // 定期与后端对账：避免 UI 已显示「执行」而进程仍在跑
  useEffect(() => {
    if (location.pathname !== '/debug' || mode !== 'agent') return undefined;
    let alive = true;
    const tick = async () => {
      if (!alive || !isDebugRouteRef.current) return;
      const key = agentSessionKey(selectedAgentRef.current);
      await recoverActiveTasks(key);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [location.pathname, mode, selectedAgent, recoverActiveTasks]);

  useEffect(() => {
    saveDebugMode(mode);
  }, [mode]);

  const agentNameMap = useMemo(
    () => Object.fromEntries((agents || []).map(a => [a.id, a.name])),
    [agents],
  );

  // 侧栏呼吸绿点：扫描各 Agent / 聚合入口会话是否在执行
  const runningAgentKeys = useMemo(() => {
    const keys = new Set();
    if (getStoreSession('__hub__').executing) keys.add('__hub__');
    for (const a of agents || []) {
      if (a?.id && getStoreSession(a.id).executing) keys.add(a.id);
    }
    return keys;
    // executing / runningRev：覆盖当前页与后台标签的启停
  }, [agents, executing, runningRev]);

  // 切换 Agent 标签时保存/恢复会话状态
  function switchAgent(agent) {
    const prevKey = agentSessionKey(selectedAgent);
    persistCurrentSessionHistory(prevKey);
    patchStoreSession(prevKey, {
      agentPrompt,
      currentUserPrompt,
      currentTask,
      taskSteps,
      taskResult,
      executing,
      delegations,
      conversationTurns,
    });

    const key = agentSessionKey(agent);
    setStoreSelectedAgentId(agent?.id ?? null);
    selectedAgentRef.current = agent;
    setSelectedAgent(agent);
    syncSessionToState(key);
    setDirError('');
    syncDelegatedMirrorToAgentTab(key, agentsRef.current);
    syncSessionToState(key);
    recoverStuckMirrorTask(key);
    recoverSessionHistory(key);
  }

  /** 将事件里的 agentId 规范化为当前标签页 session key */
  function eventSessionKey(agentId, sessionKey) {
    return resolveSessionKey(sessionKey, agentsRef.current)
      || resolveSessionKey(agentId, agentsRef.current)
      || sessionKey
      || agentId
      || null;
  }

  /** 从任务状态/完成事件补全步骤（DB 无步骤时用 summary/stdout 兜底） */
  function resolveTaskSteps(status, data, key) {
    const stored = getStoreSession(key).taskSteps || [];
    const dbSteps = status ? stepsFromTaskStatus(status) : [];
    const merged = resolveArchiveSteps(dbSteps, stored);
    if (merged.length) return merged;
    const out = status?.result?.summary
      || status?.result?.output
      || data?.result?.summary
      || data?.result?.output;
    if (out && String(out).trim()) {
      return [{
        taskId: status?.id || data?.taskId,
        stepType: 'output',
        content: String(out).trim(),
        timestamp: status?.completed_at || Date.now(),
        agentId: status?.agent_id || data?.agentId,
      }];
    }
    return [];
  }

  // 监听 Agent 事件：路由到对应标签页（主 Agent / 被派发子 Agent）
  useEffect(() => {
    if (!window.electronAPI?.agent) return;

    const finishDelegatedChild = (data, status, terminalStatus) => {
      const parentId = status?.context?.parentTaskId || data.parentTaskId;
      if (!parentId) return false;

      const parentKey = resolveTaskRoute(parentId, null, null, agentsRef.current) || '__hub__';
      const childId = data.taskId;
      const instanceId = status?.context?.sessionInstanceId
        || data.sessionInstanceId
        || resolveTaskInstance(childId);

      // 过期 session：若镜像标签仍匹配，继续收尾镜像页
      if (instanceId && !eventMatchesSession(parentKey, instanceId)) {
        const agentId = status?.agent_id || data.agentId;
        const agentKey = resolveSessionKey(agentId, agentsRef.current) || eventSessionKey(agentId, data.sessionKey);
        if (agentKey && eventMatchesAgentMirror(agentKey, instanceId)) {
          routeTaskMirror(childId, agentKey);
          let resolvedSteps = resolveTaskSteps(status, data, agentKey);
          if (!resolvedSteps.length) {
            resolvedSteps = getStoreSession(agentKey).taskSteps || [];
          }
          if (!resolvedSteps.length) {
            const summary = status?.result?.summary || data?.result?.summary;
            if (summary) {
              resolvedSteps = [{ stepType: 'output', content: String(summary), timestamp: Date.now(), agentId }];
            }
          }
          finalizeTaskInUiRef.current?.(childId, agentKey, {
            currentTask: status
              ? { ...status, status: terminalStatus }
              : { id: childId, status: terminalStatus, error: data.error },
            currentUserPrompt: status?.prompt || data.prompt || getStoreSession(agentKey).currentUserPrompt,
            taskResult: status?.result || data.result || null,
            taskSteps: resolvedSteps,
          });
          return true;
        }
        releaseExecutingForTask(childId, { status: terminalStatus });
        return true;
      }
      const agentId = status?.agent_id || data.agentId;
      const agentKey = resolveSessionKey(agentId, agentsRef.current) || eventSessionKey(agentId, data.sessionKey);
      const mirrorKey = resolveMirrorRoute(childId) || agentKey;

      const prevDel = getStoreSession(parentKey).delegations?.[childId] || {};
      const mirrorStored = prevDel.steps?.length
        ? prevDel.steps
        : (getStoreSession(mirrorKey).taskSteps || []);
      const dbSteps = status ? stepsFromTaskStatus(status) : [];
      let resolvedSteps = preferRicherSteps(dbSteps, mirrorStored);
      if (!resolvedSteps.length) {
        resolvedSteps = prevDel.steps || getStoreSession(mirrorKey).taskSteps || [];
      }
      if (!resolvedSteps.length) {
        const summary = status?.result?.summary || data?.result?.summary;
        if (summary) {
          resolvedSteps = [{
            stepType: 'output',
            content: String(summary),
            timestamp: status?.completed_at || Date.now(),
            agentId,
          }];
        }
      }
      const nextDel = {
        ...prevDel,
        agentId,
        status: terminalStatus,
        result: status?.result || data.result || null,
        steps: resolvedSteps,
      };
      patchSession(parentKey, {
        delegations: {
          ...(getStoreSession(parentKey).delegations || {}),
          [childId]: nextDel,
        },
      });

      // 子 Agent 标签同步收尾归档
      if (agentKey && agentKey !== parentKey) {
        routeTaskMirror(childId, agentKey);
        finalizeTaskInUiRef.current?.(childId, agentKey, {
          currentTask: status
            ? { ...status, status: terminalStatus }
            : { id: childId, status: terminalStatus, error: data.error },
          currentUserPrompt: nextDel.prompt || status?.prompt || data.prompt || '',
          taskResult: status?.result || data.result || null,
          taskSteps: resolvedSteps.length ? resolvedSteps : (nextDel.steps || getStoreSession(agentKey).taskSteps),
        });
      } else {
        releaseExecutingForTask(childId, { status: terminalStatus });
      }
      return true;
    };
    finishDelegatedChildRef.current = finishDelegatedChild;

    const finishTask = async (data) => {
      if (!data?.taskId) return;

      // 收到 completed/failed 事件时，DB 可能仍为 running（写入延迟），需强制终态
      const eventTerminal = data.error ? 'failed' : 'completed';

      // 优先用已注册路由，确保子 Agent 标签页能正确收尾
      let key = resolveTaskRoute(data.taskId, null, null, agentsRef.current)
        || resolveTaskRoute(
          data.taskId,
          data.agentId,
          data.sessionKey,
          agentsRef.current,
        );

      try {
        const statusResult = await window.electronAPI.agent.getTaskStatus(data.taskId);
        if (statusResult.success) {
          const status = statusResult.status;
          key = key || inferSessionKeyFromTask(status);
          key = resolveSessionKey(key, agentsRef.current) || key;
          if (!key) key = data.sessionKey || data.agentId || resolveTaskRoute(data.taskId) || null;
          if (!key) return;

          const steps = resolveTaskSteps(status, data, key);
          const terminalStatus = ['completed', 'failed', 'cancelled'].includes(status.status)
            ? status.status
            : eventTerminal;

          const parentId = status.context?.parentTaskId || data.parentTaskId;
          if (parentId && finishDelegatedChild(data, status, terminalStatus)) {
            return;
          }

          const taskInstanceId = status.context?.sessionInstanceId
            || data.sessionInstanceId
            || resolveTaskInstance(data.taskId);
          if (taskInstanceId && key && !eventMatchesSession(key, taskInstanceId)) {
            releaseExecutingForTask(data.taskId, { status: terminalStatus });
            return;
          }

          finalizeTaskInUiRef.current?.(data.taskId, key, {
            currentTask: { ...status, status: terminalStatus },
            currentUserPrompt: status.prompt || getStoreSession(key).currentUserPrompt,
            taskResult: status.result || data.result || null,
            taskSteps: preferRicherSteps(steps, getStoreSession(key).taskSteps || []),
          });
          return;
        }
      } catch (err) {
        console.warn('[Debug] finishTask getTaskStatus failed:', err);
      }

      // DB 不可用或查询失败时仍释放 UI 锁，避免一直「正在执行…」
      key = key || eventSessionKey(data.agentId, data.sessionKey) || data.agentId || data.sessionKey;
      if (!key) return;
      const steps = resolveTaskSteps(null, data, key);
      const terminalStatus = data.error ? 'failed' : 'completed';

      const parentId = data.parentTaskId;
      if (parentId && finishDelegatedChild(data, null, terminalStatus)) {
        return;
      }

      finalizeTaskInUiRef.current?.(data.taskId, key, {
        currentUserPrompt: getStoreSession(key).currentUserPrompt || data.prompt,
        currentTask: { id: data.taskId, status: terminalStatus, error: data.error },
        taskResult: data.result || null,
        taskSteps: steps.length ? steps : getStoreSession(key).taskSteps,
      });
    };

    const handleDispatched = ({ parentTaskId, childTaskId, agentId, prompt, parentSessionKey, parentSessionInstanceId }) => {
      if (!childTaskId || !agentId) return;

      // 编排派发：子任务归属父窗口 session（当前标签页）
      if (parentTaskId) {
        const parentKey = resolveTaskRoute(parentTaskId, null, null, agentsRef.current)
          || parentSessionKey
          || '__hub__';
        const instanceId = parentSessionInstanceId
          || getStoreSession(parentKey).sessionInstanceId;
        if (instanceId && !eventMatchesSession(parentKey, instanceId)) return;

        routeTask(childTaskId, parentKey, instanceId);
        routeTask(parentTaskId, parentKey, instanceId);

        const parent = getStoreSession(parentKey);
        patchSession(parentKey, {
          delegations: {
            ...(parent.delegations || {}),
            [childTaskId]: {
              agentId,
              prompt,
              steps: [],
              status: 'running',
              result: null,
              sessionInstanceId: instanceId,
            },
          },
        });

        // 镜像到子 Agent 标签，切换过去也能看到执行过程
        const agentKey = resolveSessionKey(agentId, agentsRef.current)
          || eventSessionKey(agentId, agentId);
        if (agentKey && agentKey !== parentKey) {
          routeTaskMirror(childTaskId, agentKey);
          patchSession(agentKey, {
            currentUserPrompt: prompt,
            currentTask: { id: childTaskId, status: 'running', parentTaskId },
            taskSteps: [],
            taskResult: null,
            executing: true,
            mirroredSessionInstanceId: instanceId,
            // 认领子标签会话：即便刚点了「新会话」，派发也要落到该会话
            skipHistoryRecover: 0,
          });
          scheduleAutoFinalizeRef.current?.(childTaskId, agentKey);
        }
        return;
      }

      // 无父任务：直调子 Agent 标签
      const ownerKey = eventSessionKey(agentId, agentId);
      routeTask(childTaskId, ownerKey);
      patchSession(ownerKey, {
        currentUserPrompt: prompt,
        currentTask: { id: childTaskId, status: 'running' },
        taskSteps: [],
        taskResult: null,
        executing: true,
      });
    };

    const handleStep = (stepData) => {
      const { taskId, parentTaskId, agentId, sessionKey, sessionInstanceId, stepType } = stepData;

      if (stepType === 'delegation') {
        const hubKey = resolveTaskRoute(taskId, null, null, agentsRef.current) || '__hub__';
        const instanceId = sessionInstanceId || resolveTaskInstance(taskId);
        if (instanceId && !eventMatchesSession(hubKey, instanceId)) return;
        if (hubKey) {
          const hub = getStoreSession(hubKey);
          patchSession(hubKey, {
            taskSteps: [...(hub.taskSteps || []), stepData],
          });
          if (stepData.phase === 'complete' && stepData.childTaskId) {
            const dels = { ...(hub.delegations || {}) };
            if (dels[stepData.childTaskId]) {
              dels[stepData.childTaskId] = {
                ...dels[stepData.childTaskId],
                status: stepData.status || 'completed',
              };
            }
            patchSession(hubKey, { delegations: dels });
          }
        }
        return;
      }

      // 派发子任务步骤：父窗口 delegations + 子 Agent 标签镜像
      const mirrorKey = resolveMirrorRoute(taskId);
      const isDelegatedChild = !!parentTaskId || !!mirrorKey;
      if (isDelegatedChild) {
        const parentKey = parentTaskId
          ? (resolveTaskRoute(parentTaskId, null, null, agentsRef.current) || '__hub__')
          : (resolveTaskRoute(taskId, null, null, agentsRef.current) || '__hub__');
        const instanceId = sessionInstanceId
          || resolveTaskInstance(taskId)
          || resolveTaskInstance(parentTaskId);
        if (instanceId && !eventMatchesSession(parentKey, instanceId)) return;
        const parent = getStoreSession(parentKey);
        const dels = { ...(parent.delegations || {}) };
        const del = dels[taskId] || { agentId, prompt: '', steps: [], status: 'running' };
        del.steps = coalesceAgentSteps(del.steps || [], stepData);
        dels[taskId] = del;
        patchSession(parentKey, { delegations: dels });

        const agentKey = mirrorKey
          || resolveSessionKey(agentId, agentsRef.current)
          || eventSessionKey(agentId, sessionKey);
        if (agentKey && agentKey !== parentKey) {
          if (instanceId && !eventMatchesAgentMirror(agentKey, instanceId)) return;
          const agentSess = getStoreSession(agentKey);
          patchSession(agentKey, {
            currentUserPrompt: del.prompt || agentSess.currentUserPrompt,
            currentTask: {
              id: taskId,
              status: 'running',
              parentTaskId: parentTaskId || agentSess.currentTask?.parentTaskId,
            },
            taskSteps: coalesceAgentSteps(agentSess.taskSteps || [], stepData),
            executing: true,
          });
          if (stepData.content?.trim() || stepData.is_snapshot) {
            scheduleAutoFinalizeRef.current?.(taskId, agentKey);
          }
        }
        return;
      }

      const ownerKey = resolveTaskRoute(
        taskId,
        agentId,
        sessionKey,
        agentsRef.current,
      ) || eventSessionKey(agentId, sessionKey);
      if (ownerKey) {
        const instanceId = sessionInstanceId || resolveTaskInstance(taskId);
        if (instanceId && !eventMatchesSession(ownerKey, instanceId)) return;
        const sess = getStoreSession(ownerKey);
        const sameTask = !sess.currentTask || sess.currentTask.id === taskId;
        if (sameTask) {
          const prev = sess.taskSteps || [];
          // 收到步骤时拉回 executing，避免锁被误释放后无法停止/继续
          patchSession(ownerKey, {
            currentTask: sess.currentTask?.id === taskId
              ? { ...sess.currentTask, status: 'running' }
              : { id: taskId, status: 'running', parentTaskId: parentTaskId || sess.currentTask?.parentTaskId },
            taskSteps: coalesceAgentSteps(prev, stepData),
            executing: true,
          });
          // 同步 JSON 批量步骤到达后延迟收尾
          if (stepData.content?.trim() || stepData.is_snapshot) {
            scheduleAutoFinalizeRef.current?.(taskId, ownerKey);
          }
        }
      }
    };

    const handleCancelled = (data) => {
      const key = resolveTaskRoute(
        data.taskId,
        data.agentId,
        data.sessionKey,
        agentsRef.current,
      ) || eventSessionKey(data.agentId, data.sessionKey);
      if (key) {
        const sess = getStoreSession(key);
        const cliSid = data.result?.cliSessionId || sess.cliSessionId || null;
        finalizeTaskInUiRef.current?.(data.taskId, key, {
          currentTask: { id: data.taskId, status: 'cancelled' },
          currentUserPrompt: sess.currentUserPrompt,
          taskSteps: closePendingToolSteps(sess.taskSteps || [], '已中止'),
          taskResult: {
            ...(sess.taskResult || {}),
            ...(data.result || {}),
            cliSessionId: cliSid,
            cancelled: true,
          },
        });
      }
    };

    /** 流式阶段尽早记住 sessionId，停止后即可 --resume */
    const handleCliSession = (data) => {
      if (!data?.taskId || !data?.cliSessionId) return;
      const key = resolveTaskRoute(
        data.taskId,
        data.agentId,
        data.sessionKey,
        agentsRef.current,
      ) || eventSessionKey(data.agentId, data.sessionKey);
      if (!key) return;
      const sess = getStoreSession(key);
      if (sess.currentTask?.id && sess.currentTask.id !== data.taskId) return;
      patchSession(key, { cliSessionId: data.cliSessionId });
    };

    const removeStep = window.electronAPI.agent.onStep(handleStep);
    const removeDispatched = window.electronAPI.agent.onDispatched
      ? window.electronAPI.agent.onDispatched(handleDispatched)
      : () => {};
    const removeCompleted = window.electronAPI.agent.onCompleted(finishTask);
    const removeFailed = window.electronAPI.agent.onFailed(finishTask);
    const removeCancelled = window.electronAPI.agent.onCancelled
      ? window.electronAPI.agent.onCancelled(handleCancelled)
      : () => {};
    const removeCliSession = window.electronAPI.agent.onCliSession
      ? window.electronAPI.agent.onCliSession(handleCliSession)
      : () => {};

    return () => {
      removeStep?.();
      removeDispatched?.();
      removeCompleted?.();
      removeFailed?.();
      removeCancelled?.();
      removeCliSession?.();
    };
  }, []);

  // Load available agents（有缓存则先展示，后台刷新）
  async function loadAgents({ force = false } = {}) {
    if (!window.electronAPI?.agent) {
      console.warn('Agent API not available');
      return;
    }

    const cached = getCachedAgentsList();
    if (cached?.length && !force) {
      setAgents(cached);
      setLoadingAgents(false);
    } else {
      setLoadingAgents(true);
    }

    try {
      const result = await window.electronAPI.agent.list({ force });
      if (result.success) {
        const list = result.agents || [];
        setCachedAgentsList(list);
        setAgents(list);
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      setLoadingAgents(false);
    }
  }

  /** 从资产加载已纳管的提示词，供 LLM 模式选用为 System */
  async function loadPromptList() {
    if (!window.electronAPI?.resource?.listResources) return;
    try {
      const res = await window.electronAPI.resource.listResources({ type: 'prompt' });
      if (res.success) {
        setPromptList(res.resources || []);
        // 列表刷新后若原选项已删除，清空选中态（保留已填入的 system 正文）
        setSelectedPromptId(prev => {
          if (!prev) return '';
          return (res.resources || []).some(p => p.id === prev) ? prev : '';
        });
      }
    } catch (error) {
      console.warn('[PlayGround] loadPromptList failed:', error);
    }
  }

  /** 选择提示词 → 写入 System Prompt 并展开编辑区 */
  function applyPromptSelection(promptId) {
    setSelectedPromptId(promptId);
    if (!promptId) return;
    const prompt = promptList.find(p => p.id === promptId);
    if (!prompt) return;
    setPanel({
      systemPrompt: prompt.content || '',
      showSystem: true,
    });
  }

  /** 当前轮仍有未闭合工具 / 任务未终态 → 视为进行中（可停止） */
  const taskCanStop = !!(
    executing
    || ['running', 'pending'].includes(currentTask?.status)
    || (currentUserPrompt && hasOpenToolCalls(taskSteps))
  );

  /** 停止后可一键续接（同工作目录 + 有 session / 中止轮） */
  const canResumeContinue = !taskCanStop && !!activeAgent && !!agentWorkingDir.trim()
    && canResumeInterruptedSession(agentSessionKey(selectedAgent), normalizeWorkingDir(agentWorkingDir.trim()));

  /** 停止后点「继续」：带 --resume / 进度摘要续跑 */
  function continueInterruptedAgent() {
    if (taskCanStop || !activeAgent) return;
    const text = agentPrompt.trim() || '请从上次中断处继续，不要重复已完成的步骤。';
    executeAgent(text);
  }

  /** UI 展示用任务状态：与停止按钮同源，避免假「已完成」 */
  function displayTaskStatus() {
    if (taskCanStop) return 'running';
    const s = currentTask?.status;
    if (s === 'running' || s === 'pending') return 'completed';
    return s;
  }

  /** 轮询任务状态直到终态（IPC 事件兜底） */
  async function pollTaskUntilTerminal(taskId, execKey) {
    const maxAttempts = 1200; // ~10min
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500));
      const sess = getStoreSession(execKey);
      if (isFreshAgentSession(sess)) return;
      if (!sessionTaskInstanceMatches(sess, taskId)) return;
      if (!sess.executing && sess.currentTask?.id === taskId
        && ['completed', 'failed', 'cancelled'].includes(sess.currentTask?.status)) {
        return;
      }

      // 不在此处提前收尾：1s 时往往只有推理、尚无正文，会导致归档后最终输出消失
      try {
        const res = await window.electronAPI.agent.getTaskStatus(taskId);
        if (!res.success) continue;
        const status = res.status;
        if (!['completed', 'failed', 'cancelled'].includes(status.status)) continue;

        if (status.context?.parentTaskId || sess.currentTask?.parentTaskId) {
          finishDelegatedChildRef.current?.(
            { taskId, agentId: status.agent_id, sessionInstanceId: status.context?.sessionInstanceId, result: status.result },
            status,
            status.status,
          );
          return;
        }

        const steps = resolveTaskSteps(status, { taskId, result: status.result }, execKey);
        finalizeTaskInUiRef.current?.(taskId, execKey, {
          currentTask: { ...status, status: status.status },
          currentUserPrompt: status.prompt || sess.currentUserPrompt,
          taskResult: status.result || null,
          taskSteps: steps.length ? steps : sess.taskSteps,
        });
        return;
      } catch {
        // 继续轮询
      }
    }
  }

  // Execute agent task（promptOverride 供「继续」一键续接，避免等 setState）
  async function executeAgent(promptOverride) {
    const prompt = String(promptOverride != null ? promptOverride : agentPrompt).trim();
    if (!activeAgent || !prompt || !window.electronAPI?.agent) {
      return;
    }
    if (executing || taskCanStop) return;
    if (activeAgent.custom && isHubMode) {
      return;
    }
    if (!agentWorkingDir.trim()) {
      setDirError('请先选择工作目录');
      return;
    }
    // 聚合入口：主 Agent 须支持 MCP 编排（Claude Code / Codex）
    const orchestratorAgents = new Set(['claude-code', 'codex']);
    if (isHubMode && mainAgent && !orchestratorAgents.has(mainAgent.id)) {
      alert(`聚合派发需要主 Agent 支持 MCP 编排，当前 ${mainAgent.name} 暂不支持，请切换主 Agent`);
      return;
    }

    setDirError('');
    setAgentPrompt(prompt);
    const execKey = agentSessionKey(selectedAgent);
    const workDir = normalizeWorkingDir(agentWorkingDir.trim());
    const sess = getStoreSession(execKey);
    const continueSession = shouldContinueCliSession(execKey, workDir);
    const lastTurn = sess.conversationTurns?.length
      ? sess.conversationTurns[sess.conversationTurns.length - 1]
      : null;
    const resumeCliSessionId = continueSession
      ? (sess.cliSessionId || lastTurn?.cliSessionId || lastTurn?.result?.cliSessionId || undefined)
      : undefined;
    // 无 sessionId 时把上次进度写进 prompt，避免停止后续接「失忆」
    const execPrompt = (continueSession && !resumeCliSessionId
      && ['cancelled', 'failed'].includes(lastTurn?.status))
      ? buildInterruptedContinuePrompt(prompt, lastTurn)
      : prompt;
    const instanceId = beginSessionInstance(execKey);

    patchSession(execKey, {
      currentUserPrompt: prompt,
      agentPrompt: '',
      executing: true,
      taskSteps: [],
      taskResult: null,
      currentTask: null,
      delegations: {},
      sessionWorkingDir: workDir,
      sessionInstanceId: instanceId,
      // 续接时保留 id，避免新一轮开始前被清空
      cliSessionId: resumeCliSessionId || sess.cliSessionId || null,
    });

    // 聚合入口 = 主 Agent 编排；Agent tab = 直调
    const execMode = isHubMode ? 'orchestrator' : 'direct';

    try {
      const result = await window.electronAPI.agent.execute({
        agentId: activeAgent.id,
        prompt: execPrompt,
        options: {
          workingDir: workDir,
          mode: execMode,
          mainAgentId: isHubMode ? activeAgent.id : mainAgentId,
          mcpProfile: isHubMode ? mcpProfileId : undefined,
          sessionKey: execKey,
          sessionInstanceId: instanceId,
          continueSession,
          cliSessionId: resumeCliSessionId,
        },
      });

      if (result.success) {
        routeTask(result.taskId, execKey, instanceId);
        patchSession(execKey, {
          currentUserPrompt: prompt,
          executing: true,
          taskSteps: [],
          taskResult: null,
          currentTask: { id: result.taskId, status: 'running' },
          agentPrompt: '',
        });
        // IPC 完成事件丢失时的轮询兜底
        pollTaskUntilTerminal(result.taskId, execKey);
      } else {
        patchSession(execKey, { executing: false });
        setExecuting(false);
        alert('执行失败: ' + (result.error || '未知错误'));
      }
    } catch (error) {
      setExecuting(false);
      console.error('Agent execution error:', error);
      alert('执行失败: ' + error.message);
    }
  }

  async function pickWorkingDir() {
    if (!window.electronAPI?.agent?.pickWorkingDir) return;
    try {
      const result = await window.electronAPI.agent.pickWorkingDir(
        agentWorkingDir.trim() ? { defaultPath: agentWorkingDir.trim() } : {},
      );
      if (result.success && result.path) {
        setAgentWorkingDir(result.path);
        saveAgentWorkingDir(result.path);
        setDirError('');
      }
    } catch (error) {
      console.error('Failed to pick directory:', error);
    }
  }

  async function cancelAgent() {
    if (!window.electronAPI?.agent) return;
    const execKey = agentSessionKey(selectedAgent);
    const snap = readStoreSnapshot(execKey);
    const closedSteps = closePendingToolSteps(snap.taskSteps || [], '已中止');
    const taskId = currentTask?.id || snap.currentTask?.id;
    // 停止前记下 session，取消接口也会回传已解析的 id
    let cliSid = snap.cliSessionId || snap.taskResult?.cliSessionId || null;

    try {
      if (window.electronAPI.agent.cancelAllActive) {
        const res = await window.electronAPI.agent.cancelAllActive();
        if (res?.cliSessionId) cliSid = res.cliSessionId;
      } else if (taskId) {
        const res = await window.electronAPI.agent.cancel(taskId);
        if (res?.cliSessionId) cliSid = res.cliSessionId;
      }
      if (taskId && !cliSid) {
        const st = await window.electronAPI.agent.getTaskStatus(taskId);
        cliSid = st?.status?.result?.cliSessionId || cliSid;
      }
    } catch (error) {
      console.error('Failed to cancel agent:', error);
    }

    // 无论后端是否找到进程，都释放 UI 锁并闭合未完成工具，避免卡死
    releaseAllExecutingSessions();
    const task = currentTask?.id
      ? { ...currentTask, status: 'cancelled' }
      : snap.currentTask?.id
        ? { ...snap.currentTask, status: 'cancelled' }
        : null;
    const resultWithSession = {
      ...(snap.taskResult || {}),
      cliSessionId: cliSid || snap.taskResult?.cliSessionId || null,
      cancelled: true,
    };
    // 有用户输入时归档本轮；保留 cliSessionId 供下一轮 --resume
    if (snap.currentUserPrompt) {
      archiveCompletedTurn(execKey, {
        user: snap.currentUserPrompt,
        steps: closedSteps,
        delegations: snap.delegations || {},
        result: resultWithSession,
        status: 'cancelled',
        taskId: task?.id || null,
        cliSessionId: cliSid || null,
        workingDir: normalizeWorkingDir(snap.sessionWorkingDir || agentWorkingDir.trim()),
        timestamp: Date.now(),
      });
      patchSession(execKey, {
        executing: false,
        currentTask: task,
        currentUserPrompt: '',
        taskSteps: [],
        taskResult: null,
        delegations: {},
        cliSessionId: cliSid || getStoreSession(execKey).cliSessionId || null,
        conversationTurns: getStoreSession(execKey).conversationTurns,
      });
    } else {
      patchSession(execKey, {
        executing: false,
        currentTask: task,
        taskSteps: closedSteps,
        cliSessionId: cliSid || snap.cliSessionId || null,
      });
    }
  }

  /** 清空当前标签页对话，便于开启新任务 */
  function startNewAgentSession() {
    const execKey = agentSessionKey(selectedAgent);
    const doClear = () => {
      persistCurrentSessionHistory(execKey);
      clearSessionTaskState(execKey);
      syncSessionToState(execKey);
    };
    if (executing || taskCanStop) {
      cancelAgent().then(doClear);
      return;
    }
    doClear();
  }

  // Load config + gateway status (to get actual running port)
  useEffect(() => {
    Promise.all([
      getConfig().read().catch(() => null),
      getLocalConfig().get().catch(() => null),
      getGateway().status().catch(() => null),
    ]).then(([c, lc, gwStatus]) => {
      setCfg(c);
      const gwPort = gwStatus?.port || 11430;
      const localGw = { ...LOCAL_GW, base_url: resolveLocalGatewayBase(gwPort).replace(/\/v1\/?$/, '') };
      setProvOpts(providerOptions(c, lc, localGw, t));
    });
  }, [t]);

  // When selected provider changes
  useEffect(() => {
    const opt = provOpts.find(o => o.id === selectedId) || LOCAL_GW;
    if (selectedId === '__custom__') {
      setToken(''); setModels([]); setModel(''); setManualModel(true); return;
    }
    setToken(opt.token || '');

    // 本地网关：拉 /v1/models + P2P 在线，按 free/p2p/paid 分层
    if (selectedId === '__local_gw__') {
      setLoadingModels(true); setModels([]); setModel(''); setManualModel(false);
      let cancelled = false;
      (async () => {
        try {
          const [list, c] = await Promise.all([
            loadGatewayAvailableModels(),
            getConfig().read().catch(() => null),
          ]);
          if (cancelled) return;
          const mapped = list.map(({ id, tier }) => ({
            name: id,
            tier,
            type: resolveGatewayModelType(id, c),
          }));
          setModels(mapped);
          const preferred = mapped.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
          setModel(modelSelectValue(preferred[0] || mapped[0]));
          setManualModel(mapped.length === 0);
        } catch {
          if (!cancelled) { setModels([]); setManualModel(true); }
        } finally {
          if (!cancelled) setLoadingModels(false);
        }
      })();
      return () => { cancelled = true; };
    }

    const staticMods = opt.models || [];
    if (staticMods.length > 0) {
      setModels(staticMods);
      const preferred = staticMods.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
      setModel((preferred[0] || staticMods[0])?.name || '');
      setManualModel(false);
      return;
    }
    // Try to fetch /v1/models from the provider
    const base = (opt.base_url || '').replace(/\/+$/, '');
    if (!base) { setModels([]); setModel(''); setManualModel(true); return; }
    const url = base + '/v1/models';
    const headers = {};
    if (opt.token) {
      if (/anthropic/i.test(base)) { headers['x-api-key'] = opt.token; headers['anthropic-version'] = '2023-06-01'; }
      else headers['Authorization'] = `Bearer ${opt.token}`;
    }
    setLoadingModels(true); setModels([]); setModel(''); setManualModel(false);
    const doFetch = async () => {
      try {
        let data;
        if (window.electronAPI?.llm) {
          const r = await window.electronAPI.llm.fetch(url, { headers });
          data = JSON.parse(r.body);
        } else {
          data = await fetch(url, { headers }).then(r => r.json());
        }
        const list = (data.data || []).map(m => ({ name: m.id || m.name, type: m.model_type || 'chat' })).filter(m => m.name);
        setModels(list);
        const preferred = list.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
        setModel((preferred[0] || list[0])?.name || '');
        setManualModel(list.length === 0);
      } catch {
        setModels([]); setManualModel(true);
      } finally {
        setLoadingModels(false);
      }
    };
    doFetch();
  }, [selectedId, provOpts, imageMode]);

  // When imageMode changes, try to switch to right model type
  useEffect(() => {
    if (!models.length) return;
    const preferred = models.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
    if (preferred.length && !preferred.some(m => modelSelectValue(m) === model)) {
      setModel(modelSelectValue(preferred[0]));
    }
  }, [imageMode]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [conversation]);

  // 聊天记录落盘：流式/生成中不写，避免频繁 IO
  useEffect(() => {
    if (sending) return;
    if (conversation.some(m => m.streaming || m.generating)) return;
    persistDebugPanel(panel);
  }, [panel, sending, conversation]);

  function setPanel(patch) { setPanels(prev => ({ ...prev, main: { ...prev.main, ...patch } })); }

  function handleClearChat() {
    if (!window.confirm(t('debug.clearConfirm'))) return;
    setPanel({ conversation: [], input: '' });
    clearDebugPanelStorage();
  }

  const effectiveBase = selectedId === '__custom__' ? manualBaseUrl : (provOpts.find(o => o.id === selectedId)?.base_url || '');
  const anthropic     = isAnthropicUrl(effectiveBase);
  const filteredModels = models.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');

  async function handleSend() {
    const text = input.trim();
    if (!text || !model || !effectiveBase || sending) return;

    if (imageMode) {
      const idx = conversation.length + 1;
      setPanel({ input: '', conversation: [...conversation, { role: 'user', content: text }, { role: 'assistant', images: null, generating: true }] });
      setSending(true);
      await doGenerateImage({
        baseUrl: effectiveBase, token, model, prompt: text,
        ratio: imageRatio || undefined, resolution: imageResolution || undefined, t,
        onDone: ({ images, totalMs }) => {
          setPanels(prev => {
            const p = prev.main; const next = [...p.conversation];
            next[idx] = { ...next[idx], images, generating: false, timing: { totalMs } };
            return { ...prev, main: { ...p, conversation: next } };
          });
          setSending(false);
        },
        onError: msg => {
          setPanels(prev => {
            const p = prev.main; const next = [...p.conversation];
            next[idx] = { ...next[idx], generating: false, error: msg };
            return { ...prev, main: { ...p, conversation: next } };
          });
          setSending(false);
        },
      });
      return;
    }

    const apiMessages = [];
    if (systemPrompt.trim()) apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    conversation.forEach(m => { if (m.role === 'user' || m.role === 'assistant') apiMessages.push({ role: m.role, content: m.content }); });
    apiMessages.push({ role: 'user', content: text });

    const assistantIdx = conversation.length + 1;
    setPanel({ input: '', conversation: [...conversation, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }] });
    setSending(true);

    await doStreamChat({
      baseUrl: effectiveBase, token, model, messages: apiMessages, stream: streamMode, anthropic,
      onChunk: delta => {
        setPanels(prev => {
          const p = prev.main; const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], content: next[assistantIdx].content + delta };
          return { ...prev, main: { ...p, conversation: next } };
        });
      },
      onDone: timing => {
        setPanels(prev => {
          const p = prev.main; const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, timing };
          return { ...prev, main: { ...p, conversation: next } };
        });
        setSending(false);
      },
      onError: msg => {
        setPanels(prev => {
          const p = prev.main; const next = [...p.conversation];
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, error: msg };
          return { ...prev, main: { ...p, conversation: next } };
        });
        setSending(false);
      },
    });
  }

  function handleKeyDown(e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }
  function handleInputChange(e) {
    setPanel({ input: e.target.value });
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
  }

  // 模式切换按钮（LLM / Agent 共用）
  const modeSwitcher = (
    <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-0.5 bg-zinc-50 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => setMode('llm')}
        className={`
          px-3 py-1 text-sm font-medium rounded-md transition-all
          ${mode === 'llm'
            ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
          }
        `}
      >
        💬 LLM 模式
      </button>
      <button
        type="button"
        onClick={() => setMode('agent')}
        className={`
          px-3 py-1 text-sm font-medium rounded-md transition-all
          ${mode === 'agent'
            ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
          }
        `}
      >
        🤖 Agent 模式
      </button>
    </div>
  );

  return (
    /* 顶栏拉通；智能体列表仅在 Agent 模式内容区内 */
    <div className="relative h-screen min-h-0 flex flex-col bg-white dark:bg-zinc-900">
      {/* ── 顶栏（整宽）── */}
      <div className={`shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 px-4 electron-no-drag relative z-[60] ${
        mode === 'agent' ? 'pt-4 pb-2' : 'pt-4 pb-2 space-y-2'
      }`}>

        {/* Mode Switcher — electron-no-drag 避免被顶部拖拽条拦截点击 */}
        <div className="flex gap-2 items-center">
          {modeSwitcher}
        </div>

        {/* LLM Mode Toolbar */}
        {mode === 'llm' && (
        <>
        {/* Row 1: provider + token */}
        <div className="flex gap-2 items-center flex-wrap">
          {/* Provider dropdown */}
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
            className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 shrink-0">
            {provOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>

          {/* Base URL (custom or display) */}
          {selectedId === '__custom__' ? (
            <input value={manualBaseUrl} onChange={e => setManualBaseUrl(e.target.value)}
              placeholder={t('debug.baseUrlPh')}
              className="flex-1 min-w-[200px] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500" />
          ) : (
            <code className="text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate max-w-[260px]">{effectiveBase}</code>
          )}

          {/* API Key/Token */}
          <div className="flex gap-1 items-center ml-auto">
            {anthropic && effectiveBase && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800/40 shrink-0">Anthropic</span>
            )}
            <input value={token} onChange={e => setToken(e.target.value)}
              type={showToken ? 'text' : 'password'} placeholder={t('debug.apiKeyPh')} autoComplete="off"
              className="w-36 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500" />
            <button onClick={() => setShowToken(v => !v)}
              className="text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors shrink-0">
              {showToken ? t('debug.hide') : t('debug.show')}
            </button>
          </div>
        </div>

        {/* Row 2: model + mode + options */}
        <div className="flex gap-2 items-center flex-wrap">
          {/* Model selector */}
          {loadingModels ? (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-1.5">
              <span className="w-3 h-3 border border-zinc-700 border-t-blue-400 rounded-full animate-spin" />
              {t('debug.loadingModels')}
            </span>
          ) : !manualModel && filteredModels.length > 0 ? (
            <select value={model} onChange={e => setModel(e.target.value)}
              className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 max-w-[220px]">
              {filteredModels.some(m => m.tier)
                ? [{ key: 'local', tiers: ['free', 'paid'] }, { key: 'remote', tiers: ['p2p'] }].map(g => {
                    const tms = filteredModels.filter(m => g.tiers.includes(m.tier));
                    return tms.length ? (
                      <optgroup key={g.key} label={t(`debug.tier.${g.key}`)}>
                        {tms.map(m => <option key={modelSelectValue(m)} value={modelSelectValue(m)}>{m.name}</option>)}
                      </optgroup>
                    ) : null;
                  })
                : filteredModels.map(m => <option key={m.name} value={m.name}>{m.name}</option>)
              }
            </select>
          ) : (
            <input value={model} onChange={e => setModel(e.target.value)}
              placeholder={t('debug.modelPh')}
              className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 w-44" />
          )}
          {/* Toggle dropdown ↔ manual */}
          {!loadingModels && models.length > 0 && (
            <button onClick={() => setManualModel(v => !v)}
              className="text-xs text-zinc-400 hover:text-blue-500 transition-colors shrink-0">
              {manualModel ? t('debug.pickFromList') : t('debug.manualInput')}
            </button>
          )}

          {/* Mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 shrink-0">
            {[{ v: false, l: t('debug.modeChat') }, { v: true, l: t('debug.modeImage') }].map(({ v, l }) => (
              <button key={String(v)} onClick={() => setPanel({ imageMode: v })}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  imageMode === v ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                }`}>{l}</button>
            ))}
          </div>

          {/* Image-only controls */}
          {imageMode && (
            <>
              <select value={imageRatio} onChange={e => setPanel({ imageRatio: e.target.value })}
                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none">
                <option value="">{t('debug.ratioDefault')}</option>
                {['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select value={imageResolution} onChange={e => setPanel({ imageResolution: e.target.value })}
                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none">
                <option value="">{t('debug.resolutionDefault')}</option>
                {['1k','2k','4k'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </>
          )}

          {/* Chat-only controls */}
          {!imageMode && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer select-none">
                <input type="checkbox" checked={streamMode} onChange={e => setPanel({ streamMode: e.target.checked })} className="w-3.5 h-3.5 accent-blue-600" />
                {t('debug.stream')}
              </label>
              {/* 从资产选用提示词，写入 System */}
              <select
                value={selectedPromptId}
                onChange={e => applyPromptSelection(e.target.value)}
                title={t('debug.promptSelectTitle')}
                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 max-w-[160px]"
              >
                <option value="">
                  {promptList.length === 0 ? t('debug.promptEmpty') : t('debug.promptNone')}
                </option>
                {promptList.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.display_name || p.name}
                  </option>
                ))}
              </select>
              <button onClick={() => setPanel({ showSystem: !showSystem })}
                className={`text-xs px-2 py-1 rounded-md transition-colors ${showSystem ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
                System
              </button>
            </>
          )}

          {conversation.length > 0 && (
            <button onClick={handleClearChat}
              className="ml-auto text-xs text-zinc-400 dark:text-zinc-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              title={t('debug.clearChat')}>
              {t('debug.clearChat')}
            </button>
          )}
        </div>

        {/* System prompt：手动编辑后取消提示词选中态 */}
        {!imageMode && showSystem && (
          <textarea
            value={systemPrompt}
            onChange={e => {
              setSelectedPromptId('');
              setPanel({ systemPrompt: e.target.value });
            }}
            rows={6}
            placeholder={t('debug.systemPh')}
            className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 resize-y min-h-[7.5rem] max-h-[40vh]"
          />
        )}
        </>
        )}

      </div>

      {/* ── 主体：Agent 模式下左侧智能体列表 + 右侧对话 ── */}
      <div className="flex flex-1 min-h-0 min-w-0">
        {mode === 'agent' && (
          <AgentTabBar
            agents={agents}
            selectedAgent={selectedAgent}
            mainAgentId={mainAgentId}
            onSelect={switchAgent}
            onSetMainAgent={setMainAgent}
            loading={loadingAgents && agents.length === 0}
            runningKeys={runningAgentKeys}
          />
        )}

        <div className="flex flex-col flex-1 min-w-0 min-h-0">
      {/* ── Message list / Agent UI ── */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        {mode === 'llm' ? (
          /* LLM Mode: Chat messages */
          <>
        {conversation.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-zinc-400 dark:text-zinc-400 select-none">
            <p className="text-3xl mb-2">{imageMode ? '🎨' : '🐛'}</p>
            <p className="text-sm">{imageMode ? t('debug.emptyImage') : t('debug.emptyChat')}</p>
          </div>
        )}

        {conversation.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs shrink-0 mt-0.5 mr-2">AI</div>
            )}
            <div className="max-w-[75%]">
              {msg.error ? (
                <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-2xl px-4 py-2.5 text-sm text-red-600 dark:text-red-400">{msg.error}</div>
              ) : msg.role === 'assistant' && msg.images !== undefined ? (
                <div className="rounded-2xl overflow-hidden bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-transparent">
                  {msg.generating ? (
                    <div className="px-4 py-6 flex items-center gap-2 text-sm text-zinc-400 dark:text-zinc-500">
                      <span className="w-4 h-4 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" /> {t('debug.generating')}
                    </div>
                  ) : (() => {
                    const displayImages = (msg.images || []).filter(src => src && src !== B64_OMITTED);
                    const hasOmitted = (msg.images || []).some(src => src === B64_OMITTED);
                    if (displayImages.length > 0) {
                      return (
                    <div className="space-y-2 p-2">
                      {displayImages.map((src, j) => {
                        const imgSrc = src.startsWith('data:') || src.startsWith('http') ? src : `data:image/png;base64,${src}`;
                        return (
                          <div key={j} className="relative group">
                            <img src={imgSrc} alt={`gen-${j}`} className="rounded-xl max-w-full cursor-zoom-in" onClick={() => setLightbox(imgSrc)} />
                            <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={async () => { try { const b = await (await fetch(imgSrc)).blob(); await navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]); } catch {} }}
                                className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">{t('debug.copy')}</button>
                              <button onClick={() => { const a = document.createElement('a'); a.href = imgSrc; a.download = `gen-${Date.now()}.png`; a.click(); }}
                                className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">{t('debug.saveImage')}</button>
                            </div>
                          </div>
                        );
                      })}
                      {hasOmitted && (
                        <p className="px-2 pb-1 text-xs text-zinc-400 dark:text-zinc-500">{t('debug.imageNotRestored')}</p>
                      )}
                    </div>
                      );
                    }
                    if (hasOmitted) {
                      return <div className="px-4 py-3 text-sm text-zinc-400 dark:text-zinc-500">{t('debug.imageNotRestored')}</div>;
                    }
                    return <div className="px-4 py-3 text-sm text-zinc-400 dark:text-zinc-500">{t('debug.noImage')}</div>;
                  })()}
                </div>
              ) : (
                <div className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : 'bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-transparent text-zinc-900 dark:text-zinc-100 rounded-bl-sm'
                }`}>
                  {msg.content}
                  {msg.streaming && <span className="animate-pulse text-blue-300 dark:text-blue-400 ml-0.5">▊</span>}
                </div>
              )}
              {msg.timing && (
                <p className="text-xs text-zinc-400 dark:text-zinc-400 mt-1 px-1">
                  {msg.timing.firstTokenMs != null ? t('debug.firstToken', { ms: msg.timing.firstTokenMs }) : ''}{t('debug.total', { ms: msg.timing.totalMs })}
                </p>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-zinc-500 dark:text-zinc-400 text-xs shrink-0 mt-0.5 ml-2">{t('debug.me')}</div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
          </>
        ) : (
          /* Agent Mode：右侧对话流 */
          <div className="h-full flex flex-col">
            {isHubMode ? (
              /* 聚合入口：由主 Agent 编排 */
              !mainAgent ? (
                <div className="flex-1 flex items-center justify-center text-center text-zinc-400 dark:text-zinc-500">
                  <p className="text-sm">未检测到可用 Agent，请先在 Gateway 纳管</p>
                </div>
              ) : !conversationTurns.length && !currentUserPrompt && !taskSteps.length && !executing ? (
                <div className="flex-1 flex items-start justify-center text-center text-zinc-400 dark:text-zinc-500 px-6 pt-4">
                  <div className="max-w-md">
                    <p className="text-3xl mb-2">✨</p>
                    <p className="text-sm mb-4">
                      聚合入口由<strong className="text-zinc-700 dark:text-zinc-300">主 Agent</strong>接收任务，
                      后续可协调派发至其他 Agent
                    </p>
                    <div className="flex items-center justify-center gap-2 text-sm">
                      <span className="text-zinc-500">主 Agent：</span>
                      <select
                        value={mainAgentId}
                        onChange={e => {
                          const agent = agents.find(a => a.id === e.target.value);
                          if (agent) setMainAgent(agent);
                        }}
                        className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1 text-zinc-900 dark:text-zinc-100"
                      >
                        {agents.filter(a => !a.custom).map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                    {mcpProfiles.length > 0 && (
                      <div className="flex items-center justify-center gap-2 text-sm mt-3">
                        <span className="text-zinc-500">MCP Profile：</span>
                        <select
                          value={mcpProfileId}
                          onChange={e => {
                            setMcpProfileId(e.target.value);
                            saveMcpProfileId(e.target.value);
                          }}
                          className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1 text-zinc-900 dark:text-zinc-100 max-w-[220px]"
                        >
                          {mcpProfiles.map(p => (
                            <option key={p.id} value={p.id}>{p.display_name || p.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <p className="text-xs text-zinc-400 mt-3">
                      也可点击左侧 Agent 旁的 ☆ 设为主 Agent
                    </p>
                  </div>
                </div>
              ) : (
                <ExecutionLog
                  conversationTurns={conversationTurns}
                  userPrompt={currentUserPrompt}
                  steps={taskSteps}
                  status={displayTaskStatus()}
                  result={taskResult}
                  task={currentTask}
                  agentName={`${mainAgent.name}（主 Agent）`}
                  delegations={delegations}
                  agentNames={agentNameMap}
                />
              )
            ) : (
              <ExecutionLog
                conversationTurns={conversationTurns}
                userPrompt={currentUserPrompt}
                steps={taskSteps}
                status={displayTaskStatus()}
                result={taskResult}
                task={currentTask}
                agentName={selectedAgent?.name}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Input bar ── */}
      <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 px-4 py-3 electron-no-drag relative z-[60]">
        {mode === 'llm' ? (
          /* LLM Mode Input */
          <div className="flex gap-2 items-end">
            <textarea ref={textareaRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
              placeholder={imageMode ? t('debug.inputImagePh') : t('debug.inputChatPh')}
              rows={1} style={{ resize: 'none' }}
              className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 overflow-hidden" />
            <button onClick={handleSend} disabled={sending || !input.trim() || !model || !effectiveBase}
              className="shrink-0 w-9 h-9 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-40 rounded-xl flex items-center justify-center transition-colors">
              {sending
                ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                : <span className="text-white text-sm">↑</span>}
            </button>
          </div>
        ) : (
          /* Agent Mode Input */
          <div className="space-y-2">
            {/* 工作目录：底部选择，符合常见 Agent 交互习惯 */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={pickWorkingDir}
                disabled={!activeAgent}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
              >
                📁 选择目录
              </button>
              {isHubMode && mainAgent && (
                <>
                  <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    主：{mainAgent.name}
                  </span>
                  {mcpProfiles.length > 0 && (
                    <select
                      value={mcpProfileId}
                      onChange={e => {
                        setMcpProfileId(e.target.value);
                        saveMcpProfileId(e.target.value);
                      }}
                      className="shrink-0 text-[11px] px-2 py-0.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300"
                      title="MCP Profile"
                    >
                      {mcpProfiles.map(p => (
                        <option key={p.id} value={p.id}>{p.display_name || p.name}</option>
                      ))}
                    </select>
                  )}
                </>
              )}
              <span className={`flex-1 truncate text-xs font-mono ${
                agentWorkingDir
                  ? 'text-zinc-600 dark:text-zinc-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}>
                {agentWorkingDir || '未选择工作目录 — 执行任务前请先选择'}
              </span>
            </div>
            {dirError && (
              <p className="text-xs text-red-500 dark:text-red-400">{dirError}</p>
            )}

            <div className="flex gap-2 items-end">
              <div className="relative flex-1">
                <textarea
                  ref={agentTextareaRef}
                  value={agentPrompt}
                  onChange={e => setAgentPrompt(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (!taskCanStop && activeAgent && agentPrompt.trim()) {
                        executeAgent();
                      }
                    }
                  }}
                  disabled={!activeAgent}
                  placeholder={
                    !activeAgent
                      ? '请先纳管 Agent'
                      : isHubMode
                        ? `向主 Agent ${mainAgent?.name || ''} 描述协同任务…（Cmd/Ctrl+Enter 发送）`
                        : `向 ${selectedAgent.name} 直调任务…（Cmd/Ctrl+Enter 发送）`
                  }
                  rows={2}
                  className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50"
                />
              </div>
              <div className="shrink-0 flex flex-col gap-1.5 items-stretch">
                <div className="flex flex-row gap-1.5">
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(true)}
                    className="flex-1 px-3 h-7 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-xs whitespace-nowrap"
                  >
                    历史会话
                  </button>
                  {(conversationTurns.length > 0 || currentUserPrompt || taskSteps.length > 0 || executing || taskCanStop) && (
                    <button
                      type="button"
                      onClick={startNewAgentSession}
                      className="flex-1 px-3 h-7 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-xs whitespace-nowrap"
                    >
                      新会话
                    </button>
                  )}
                </div>
                {taskCanStop ? (
                  <button
                    type="button"
                    onClick={cancelAgent}
                    className="px-4 h-9 bg-red-600 hover:bg-red-500 text-white rounded-xl flex items-center justify-center gap-2 transition-colors"
                  >
                    <span className="w-3 h-3 bg-white rounded-sm"></span>
                    <span className="text-sm">停止</span>
                  </button>
                ) : canResumeContinue ? (
                  <button
                    type="button"
                    onClick={continueInterruptedAgent}
                    title="从上次中断处续接（保留 CLI 会话上下文）"
                    className="px-4 h-9 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white rounded-xl flex items-center justify-center gap-2 transition-colors"
                  >
                    <span className="text-sm">▶</span>
                    <span className="text-sm">继续</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => executeAgent()}
                    disabled={!activeAgent || !agentPrompt.trim()}
                    className="px-4 h-9 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-40 text-white rounded-xl flex items-center justify-center gap-2 transition-colors"
                  >
                    <span className="text-sm">▶</span>
                    <span className="text-sm">执行</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
      </div>

      {/* ── 历史会话 ── */}
      <AgentSessionHistoryPanel
        open={historyOpen && mode === 'agent'}
        onClose={() => setHistoryOpen(false)}
        agentKey={agentSessionKey(selectedAgent)}
        agentLabel={isHubMode ? `聚合入口 · ${mainAgent?.name || ''}` : selectedAgent?.name}
        listAgentId={isHubMode ? mainAgent?.id : selectedAgent?.id}
        onRestore={restoreHistorySession}
      />

      {/* ── Lightbox ── */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="preview" className="max-w-full max-h-full object-contain" onClick={e => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl leading-none">✕</button>
        </div>
      )}
    </div>
  );
}

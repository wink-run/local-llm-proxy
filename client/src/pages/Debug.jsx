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
  routeTask,
  setStoreSelectedAgentId,
  getStoreSelectedAgentId,
  releaseAllExecutingSessions,
  clearSessionTaskState,
} from '../lib/debug-agent-store';
import { useLang } from '../store/lang';
import AgentTabBar from '../components/AgentTabBar';
import ExecutionLog from '../components/ExecutionLog';

/** 下拉 value：同 id 跨层时用 tier:id，避免 HTML option 重复 value 选中错位 */
function modelSelectValue(m) {
  if (!m) return '';
  const id = m.name || m.id || '';
  return m.tier ? encodeTierModelRoute(m.tier, id) : id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

  // Agent 模式状态
  const [agents, setAgents] = useState([]);
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
  const selectedAgentRef = useRef(null);
  selectedAgentRef.current = selectedAgent;
  const syncSessionToStateRef = useRef(null);

  // 当前生效的 Agent：直调 tab 或聚合入口的主 Agent
  const mainAgent = agents.find(a => a.id === mainAgentId && !a.custom)
    || agents.find(a => !a.custom)
    || null;
  const isHubMode = !selectedAgent;
  const activeAgent = selectedAgent || mainAgent;

  const panel = panels.main;
  const { conversation, input, systemPrompt, showSystem, streamMode, imageMode, imageRatio, imageResolution } = panel;

  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);

  // Load Agents when switching to agent mode
  useEffect(() => {
    if (mode === 'agent' && agents.length === 0) {
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
            const fallback = res.profiles[0].id;
            setMcpProfileId(fallback);
            saveMcpProfileId(fallback);
          }
        }
      })
      .catch(err => console.warn('Failed to load MCP profiles:', err));
  }, [mode]);

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
      }
    }
  }, [agents, mainAgentId]);

  function setMainAgent(agent) {
    if (!agent?.id || agent.custom || agent.type === 'assistant') return;
    setMainAgentId(agent.id);
    saveMainAgentId(agent.id);
  }

  function syncSessionToState(key) {
    const saved = readStoreSnapshot(key);
    setAgentPrompt(saved.agentPrompt || '');
    setCurrentUserPrompt(saved.currentUserPrompt || '');
    setCurrentTask(saved.currentTask || null);
    setTaskSteps(saved.taskSteps || []);
    setTaskResult(saved.taskResult || null);
    setExecuting(!!saved.executing);
    setDelegations(saved.delegations || {});
  }
  syncSessionToStateRef.current = syncSessionToState;

  /** 更新模块级会话；当前在调试页且标签匹配时同步 React state */
  function patchSession(key, patch) {
    patchStoreSession(key, patch);
    if (isDebugRouteRef.current && agentSessionKey(selectedAgentRef.current) === key) {
      syncSessionToState(key);
    }
    return getStoreSession(key);
  }

  const recoverActiveTasks = useCallback(async (syncKey) => {
    if (!window.electronAPI?.agent?.listActiveTasks) return;
    try {
      const res = await window.electronAPI.agent.listActiveTasks();
      if (!res.success || !res.tasks?.length) return;
      for (const task of res.tasks) mergeTaskIntoStore(task);
      syncSessionToStateRef.current?.(syncKey);
    } catch (err) {
      console.warn('[Debug] recoverActiveTasks failed:', err);
    }
  }, []);

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
  }, [location.pathname, selectedAgent, recoverActiveTasks]);

  useEffect(() => {
    saveDebugMode(mode);
  }, [mode]);

  const agentNameMap = useMemo(
    () => Object.fromEntries((agents || []).map(a => [a.id, a.name])),
    [agents],
  );

  // 切换 Agent 标签时保存/恢复会话状态
  function switchAgent(agent) {
    const prevKey = agentSessionKey(selectedAgent);
    patchStoreSession(prevKey, {
      agentPrompt,
      currentUserPrompt,
      currentTask,
      taskSteps,
      taskResult,
      executing,
      delegations,
    });

    const key = agentSessionKey(agent);
    setStoreSelectedAgentId(agent?.id ?? null);
    selectedAgentRef.current = agent;
    setSelectedAgent(agent);
    syncSessionToState(key);
    setDirError('');
  }

  // 监听 Agent 事件：路由到对应标签页（主 Agent / 被派发子 Agent）
  useEffect(() => {
    if (!window.electronAPI?.agent) return;

    const finishTask = async (data) => {
      const key = resolveTaskRoute(data.taskId);
      if (!key) return;

      const statusResult = await window.electronAPI.agent.getTaskStatus(data.taskId);
      if (!statusResult.success) return;

      const status = statusResult.status;
      const ctx = status.context || {};
      patchSession(key, {
        executing: false,
        currentTask: status,
        taskResult: status.result || null,
      });

      if (ctx.parentTaskId) {
        const hub = getStoreSession('__hub__');
        const dels = { ...(hub.delegations || {}) };
        if (dels[data.taskId]) {
          dels[data.taskId] = {
            ...dels[data.taskId],
            status: status.status,
            result: status.result,
          };
          patchSession('__hub__', { delegations: dels });
        }
      }
    };

    const handleDispatched = ({ parentTaskId, childTaskId, agentId, prompt }) => {
      if (!childTaskId || !agentId) return;

      routeTask(childTaskId, agentId);
      if (parentTaskId) routeTask(parentTaskId, '__hub__');

      patchSession(agentId, {
        currentUserPrompt: prompt,
        currentTask: { id: childTaskId, status: 'running', parentTaskId },
        taskSteps: [],
        taskResult: null,
        executing: true,
      });

      if (parentTaskId) {
        const hub = getStoreSession('__hub__');
        patchSession('__hub__', {
          delegations: {
            ...(hub.delegations || {}),
            [childTaskId]: {
              agentId,
              prompt,
              steps: [],
              status: 'running',
              result: null,
            },
          },
        });
      }
    };

    const handleStep = (stepData) => {
      const { taskId, parentTaskId, agentId, stepType } = stepData;

      if (stepType === 'delegation') {
        if (resolveTaskRoute(taskId) === '__hub__') {
          const hub = getStoreSession('__hub__');
          patchSession('__hub__', {
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
            patchSession('__hub__', { delegations: dels });
          }
        }
        return;
      }

      const ownerKey = resolveTaskRoute(taskId, agentId);
      if (ownerKey) {
        const sess = getStoreSession(ownerKey);
        if (!sess.currentTask || sess.currentTask.id === taskId) {
          patchSession(ownerKey, {
            taskSteps: [...(sess.taskSteps || []), stepData],
          });
        }
      }

      if (parentTaskId) {
        const hub = getStoreSession('__hub__');
        const dels = { ...(hub.delegations || {}) };
        const del = dels[taskId] || { agentId, prompt: '', steps: [], status: 'running' };
        del.steps = [...(del.steps || []), stepData];
        dels[taskId] = del;
        patchSession('__hub__', { delegations: dels });
      }
    };

    const handleCancelled = (data) => {
      const key = resolveTaskRoute(data.taskId);
      if (key) {
        patchSession(key, {
          executing: false,
          currentTask: { id: data.taskId, status: 'cancelled' },
        });
      }
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

    return () => {
      removeStep?.();
      removeDispatched?.();
      removeCompleted?.();
      removeFailed?.();
      removeCancelled?.();
    };
  }, []);

  // Load available agents
  async function loadAgents() {
    if (!window.electronAPI?.agent) {
      console.warn('Agent API not available');
      return;
    }
    
    setLoadingAgents(true);
    try {
      const result = await window.electronAPI.agent.list();
      if (result.success) {
        setAgents(result.agents || []);
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      setLoadingAgents(false);
    }
  }

  // Execute agent task
  async function executeAgent() {
    if (!activeAgent || !agentPrompt.trim() || !window.electronAPI?.agent) {
      return;
    }
    if (executing) return;
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
    const prompt = agentPrompt.trim();
    const execKey = agentSessionKey(selectedAgent);

    patchSession(execKey, {
      currentUserPrompt: prompt,
      agentPrompt: '',
      executing: true,
      taskSteps: [],
      taskResult: null,
      currentTask: null,
    });

    // 聚合入口 = 主 Agent 编排；Agent tab = 直调
    const execMode = isHubMode ? 'orchestrator' : 'direct';

    try {
      const result = await window.electronAPI.agent.execute({
        agentId: activeAgent.id,
        prompt,
        options: {
          workingDir: agentWorkingDir.trim(),
          mode: execMode,
          mainAgentId: isHubMode ? activeAgent.id : mainAgentId,
          mcpProfile: isHubMode ? mcpProfileId : undefined,
          sessionKey: execKey,
        },
      });

      if (result.success) {
        routeTask(result.taskId, execKey);
        patchSession(execKey, {
          currentUserPrompt: prompt,
          executing: true,
          taskSteps: [],
          taskResult: null,
          currentTask: { id: result.taskId, status: 'running' },
          agentPrompt: '',
        });
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

    try {
      if (window.electronAPI.agent.cancelAllActive) {
        await window.electronAPI.agent.cancelAllActive();
      } else {
        const taskId = currentTask?.id || readStoreSnapshot(execKey).currentTask?.id;
        if (taskId) await window.electronAPI.agent.cancel(taskId);
      }
    } catch (error) {
      console.error('Failed to cancel agent:', error);
    }

    // 无论后端是否找到进程，都释放 UI 锁，避免卡死
    releaseAllExecutingSessions();
    patchSession(execKey, {
      executing: false,
      currentTask: currentTask?.id
        ? { ...currentTask, status: 'cancelled' }
        : readStoreSnapshot(execKey).currentTask?.id
          ? { ...readStoreSnapshot(execKey).currentTask, status: 'cancelled' }
          : null,
    });
  }

  /** 清空当前标签页对话，便于开启新任务 */
  function startNewAgentSession() {
    const execKey = agentSessionKey(selectedAgent);
    if (executing) {
      cancelAgent().then(() => {
        clearSessionTaskState(execKey);
        syncSessionToState(execKey);
      });
      return;
    }
    clearSessionTaskState(execKey);
    syncSessionToState(execKey);
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

  return (
    <div className="flex flex-col h-screen">

      {/* ── Toolbar ── */}
      <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 px-4 pt-12 pb-2 space-y-2 electron-no-drag relative z-[60]">

        {/* Mode Switcher — electron-no-drag 避免被顶部拖拽条拦截点击 */}
        <div className="flex gap-2 items-center">
          <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-1 bg-zinc-50 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => setMode('llm')}
              className={`
                px-4 py-1.5 text-sm font-medium rounded-md transition-all
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
                px-4 py-1.5 text-sm font-medium rounded-md transition-all
                ${mode === 'agent'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                }
              `}
            >
              🤖 Agent 模式
            </button>
          </div>
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

        {/* System prompt */}
        {!imageMode && showSystem && (
          <textarea value={systemPrompt} onChange={e => setPanel({ systemPrompt: e.target.value })}
            rows={2} placeholder={t('debug.systemPh')}
            className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 resize-none" />
        )}
        </>
        )}

        {/* Agent Mode：顶部 Agent 标签条 */}
        {mode === 'agent' && (
          <AgentTabBar
            agents={agents}
            selectedAgent={selectedAgent}
            mainAgentId={mainAgentId}
            onSelect={switchAgent}
            onSetMainAgent={setMainAgent}
            loading={loadingAgents}
          />
        )}
        {mode === 'agent' && (currentUserPrompt || taskSteps.length > 0 || executing) && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={startNewAgentSession}
              className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              新会话
            </button>
          </div>
        )}
      </div>

      {/* ── Message list / Agent UI ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
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
          /* Agent Mode：全宽对话流 */
          <div className="h-full flex flex-col">
            {isHubMode ? (
              /* 聚合入口：由主 Agent 编排 */
              !mainAgent ? (
                <div className="flex-1 flex items-center justify-center text-center text-zinc-400 dark:text-zinc-500">
                  <p className="text-sm">未检测到可用 Agent，请先在 Gateway 纳管</p>
                </div>
              ) : !currentUserPrompt && !taskSteps.length && !executing ? (
                <div className="flex-1 flex items-center justify-center text-center text-zinc-400 dark:text-zinc-500 px-6">
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
                      也可点击 Agent 标签旁的 ☆ 设为主 Agent
                    </p>
                  </div>
                </div>
              ) : (
                <ExecutionLog
                  userPrompt={currentUserPrompt}
                  steps={taskSteps}
                  status={currentTask?.status}
                  result={taskResult}
                  task={currentTask}
                  agentName={`${mainAgent.name}（主 Agent）`}
                  delegations={delegations}
                  agentNames={agentNameMap}
                />
              )
            ) : (
              <ExecutionLog
                userPrompt={currentUserPrompt}
                steps={taskSteps}
                status={currentTask?.status}
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
              <textarea
                value={agentPrompt}
                onChange={e => setAgentPrompt(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (!executing && activeAgent && agentPrompt.trim()) {
                      executeAgent();
                    }
                  }
                }}
                disabled={!activeAgent}
                placeholder={
                  !activeAgent
                    ? '请先纳管 Agent'
                    : isHubMode
                      ? `向主 Agent ${mainAgent?.name || ''} 描述协同任务… (Cmd/Ctrl+Enter)`
                      : `向 ${selectedAgent.name} 直调任务… (Cmd/Ctrl+Enter)`
                }
                rows={2}
                className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50"
              />
              {executing ? (
                <button
                  type="button"
                  onClick={cancelAgent}
                  className="shrink-0 px-4 h-9 bg-red-600 hover:bg-red-500 text-white rounded-xl flex items-center justify-center gap-2 transition-colors"
                >
                  <span className="w-3 h-3 bg-white rounded-sm"></span>
                  <span className="text-sm">停止</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={executeAgent}
                  disabled={!activeAgent || !agentPrompt.trim()}
                  className="shrink-0 px-4 h-9 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-40 text-white rounded-xl flex items-center justify-center gap-2 transition-colors"
                >
                  <span className="text-sm">▶</span>
                  <span className="text-sm">执行</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

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

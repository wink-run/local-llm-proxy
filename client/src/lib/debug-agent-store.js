/** Debug Agent 模式：模块级会话缓存，避免切换菜单/重挂载后任务 state 丢失 */

export function emptyAgentSession() {
  return {
    agentPrompt: '',
    currentUserPrompt: '',
    currentTask: null,
    taskSteps: [],
    taskResult: null,
    executing: false,
    delegations: {},
    /** 已完成的多轮对话 */
    conversationTurns: [],
    /** CLI 侧 session/thread id（Codex resume 用） */
    cliSessionId: null,
    /** 当前会话绑定的工作目录 */
    sessionWorkingDir: '',
  };
}

export function agentSessionKey(agent) {
  return agent?.id || '__hub__';
}

/** 将 MCP/后端 agentId 映射到 Debug 标签页 session key */
export function resolveSessionKey(agentId, agents = []) {
  const raw = String(agentId || '').trim();
  if (!raw) return null;
  if (raw === '__hub__') return raw;

  const list = agents || [];
  const exact = list.find(a => a.id === raw);
  if (exact) return exact.id;

  const lower = raw.toLowerCase();
  const assistant = list.find(a =>
    a.type === 'assistant' && (
      a.name?.toLowerCase() === lower
      || a.resourceId === raw
      || a.resourceId === raw.replace(/^assistant:/, '')
      || (raw.startsWith('assistant:') && a.id.includes(raw.slice('assistant:'.length)))
    ),
  );
  if (assistant) return assistant.id;

  const cli = list.find(a => a.id === lower || a.name?.toLowerCase() === lower);
  if (cli) return cli.id;

  // 已是 assistant: 前缀的完整 id，即使 agents 尚未加载也保留
  if (raw.startsWith('assistant:')) return raw;

  return raw;
}

const store = {
  sessions: {},
  taskRoutes: {},
  selectedAgentId: null,
};

export function getStoreSession(key) {
  if (!store.sessions[key]) store.sessions[key] = emptyAgentSession();
  return store.sessions[key];
}

export function patchStoreSession(key, patch) {
  const prev = getStoreSession(key);
  store.sessions[key] = { ...prev, ...patch };
  return store.sessions[key];
}

export function routeTask(taskId, sessionKey) {
  if (taskId && sessionKey) store.taskRoutes[taskId] = sessionKey;
}

export function resolveTaskRoute(taskId, agentId, sessionKey, agents = []) {
  const routed = store.taskRoutes[taskId];
  if (routed) return routed;
  const fromSession = sessionKey || resolveSessionKey(agentId, agents);
  if (fromSession) return fromSession;
  return agentId || null;
}

export function setStoreSelectedAgentId(id) {
  store.selectedAgentId = id;
}

export function getStoreSelectedAgentId() {
  return store.selectedAgentId;
}

/** 从任务记录推断应展示在哪个 Agent 标签页 */
export function inferSessionKeyFromTask(status) {
  const ctx = status.context || {};
  if (ctx.sessionKey) return ctx.sessionKey;
  if (ctx.parentTaskId) return status.agent_id;
  if (ctx.mode === 'orchestrator') return '__hub__';
  return status.agent_id;
}

function mapDbSteps(status) {
  return (status.steps || []).map(s => ({
    taskId: status.id,
    stepNumber: s.step_number,
    stepType: s.step_type,
    content: s.content,
    timestamp: s.created_at,
    agentId: status.agent_id,
    parentTaskId: status.context?.parentTaskId || null,
  }));
}

/** 将 DB 步骤行转为 ExecutionLog 步骤 */
export function stepsFromTaskStatus(status) {
  return mapDbSteps(status);
}

/** 将后端任务状态合并进 store（用于恢复运行中任务） */
export function mergeTaskIntoStore(status) {
  if (!status?.id) return;

  const key = inferSessionKeyFromTask(status);
  routeTask(status.id, key);

  const steps = mapDbSteps(status);
  const running = status.status === 'running' || status.status === 'pending';

  patchStoreSession(key, {
    currentUserPrompt: running ? (status.prompt || getStoreSession(key).currentUserPrompt) : '',
    currentTask: status,
    taskSteps: steps.length ? steps : getStoreSession(key).taskSteps,
    executing: running,
    taskResult: running ? null : (status.result || null),
  });

  if (!running && status.prompt) {
    archiveCompletedTurn(key, {
      user: status.prompt,
      steps,
      result: status.result || null,
      status: status.status,
      taskId: status.id,
      cliSessionId: status.result?.cliSessionId || null,
      workingDir: status.context?.workingDir || getStoreSession(key).sessionWorkingDir || '',
      timestamp: status.completed_at || Date.now(),
    });
  }

  if (status.context?.parentTaskId) {
    const hub = getStoreSession('__hub__');
    patchStoreSession('__hub__', {
      delegations: {
        ...(hub.delegations || {}),
        [status.id]: {
          agentId: status.agent_id,
          prompt: status.prompt,
          steps,
          status: status.status,
          result: status.result,
        },
      },
    });
  }
}

export function readStoreSnapshot(sessionKey) {
  return { ...(getStoreSession(sessionKey)) };
}

/** 强制结束所有标签页的 executing 锁（停止按钮兜底） */
export function releaseAllExecutingSessions() {
  for (const key of Object.keys(store.sessions)) {
    const s = store.sessions[key];
    if (!s?.executing) continue;
    store.sessions[key] = {
      ...s,
      executing: false,
      currentTask: s.currentTask
        ? { ...s.currentTask, status: 'cancelled' }
        : null,
    };
  }
}

/** 按 taskId 释放所有标签页的 executing 锁（完成/失败事件兜底） */
export function releaseExecutingForTask(taskId, taskPatch = {}) {
  if (!taskId) return [];
  const touched = [];
  for (const key of Object.keys(store.sessions)) {
    const s = store.sessions[key];
    if (s.currentTask?.id !== taskId) continue;
    store.sessions[key] = {
      ...s,
      executing: false,
      currentTask: s.currentTask
        ? { ...s.currentTask, ...taskPatch }
        : s.currentTask,
    };
    touched.push(key);
  }
  return touched;
}

export function clearSessionTaskState(sessionKey) {
  patchStoreSession(sessionKey, {
    agentPrompt: '',
    currentUserPrompt: '',
    currentTask: null,
    taskSteps: [],
    taskResult: null,
    executing: false,
    delegations: {},
    conversationTurns: [],
    cliSessionId: null,
    sessionWorkingDir: '',
  });
}

/** 任务完成后归档为一轮对话 */
export function archiveCompletedTurn(sessionKey, turn) {
  if (!sessionKey || !turn?.user) return;
  const s = getStoreSession(sessionKey);
  const turns = [...(s.conversationTurns || [])];
  // 同一 taskId 不重复归档
  if (turn.taskId && turns.some(t => t.taskId === turn.taskId)) return;
  turns.push({
    user: turn.user,
    steps: turn.steps || [],
    result: turn.result || null,
    status: turn.status || 'completed',
    taskId: turn.taskId || null,
    timestamp: turn.timestamp || Date.now(),
  });
  patchStoreSession(sessionKey, {
    conversationTurns: turns,
    cliSessionId: turn.cliSessionId || s.cliSessionId || null,
    sessionWorkingDir: turn.workingDir || s.sessionWorkingDir || '',
  });
}

/** 同工作目录下是否可续接 CLI 会话 */
export function shouldContinueCliSession(sessionKey, workingDir) {
  const s = getStoreSession(sessionKey);
  if (!s.conversationTurns?.length) return false;
  const dir = String(workingDir || '').trim();
  if (!dir || s.sessionWorkingDir !== dir) return false;
  const last = s.conversationTurns[s.conversationTurns.length - 1];
  return last?.status === 'completed';
}

/** Debug Agent 列表前端缓存（stale-while-revalidate） */
let agentsListCache = null;

export function getCachedAgentsList() {
  return agentsListCache;
}

export function setCachedAgentsList(agents) {
  agentsListCache = Array.isArray(agents) ? agents : null;
}

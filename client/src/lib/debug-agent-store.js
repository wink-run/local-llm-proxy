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
  };
}

export function agentSessionKey(agent) {
  return agent?.id || '__hub__';
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

export function resolveTaskRoute(taskId, agentId) {
  return store.taskRoutes[taskId] || agentId || null;
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

/** 将后端任务状态合并进 store（用于恢复运行中任务） */
export function mergeTaskIntoStore(status) {
  if (!status?.id) return;

  const key = inferSessionKeyFromTask(status);
  routeTask(status.id, key);

  const steps = mapDbSteps(status);
  const running = status.status === 'running' || status.status === 'pending';

  patchStoreSession(key, {
    currentUserPrompt: status.prompt || getStoreSession(key).currentUserPrompt,
    currentTask: status,
    taskSteps: steps.length ? steps : getStoreSession(key).taskSteps,
    executing: running,
    taskResult: running ? null : (status.result || null),
  });

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

export function clearSessionTaskState(sessionKey) {
  patchStoreSession(sessionKey, {
    agentPrompt: '',
    currentUserPrompt: '',
    currentTask: null,
    taskSteps: [],
    taskResult: null,
    executing: false,
    delegations: {},
  });
}

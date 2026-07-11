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
    /** 用户点击「新会话」后，短暂跳过 DB 历史恢复 */
    skipHistoryRecover: 0,
    /** 当前页面会话实例 ID（新会话/新一轮执行时更新，派发绑定此 ID） */
    sessionInstanceId: '',
    /** 镜像派发的父会话实例 ID（子 Agent 标签用） */
    mirroredSessionInstanceId: '',
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
  /** 派发子任务 → 子 Agent 标签页镜像路由 */
  mirrorRoutes: {},
  /** taskId → 创建时的 sessionInstanceId */
  taskInstances: {},
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

export function createSessionInstanceId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 开启当前标签页的新会话实例（新会话 / 新一轮执行） */
export function beginSessionInstance(sessionKey) {
  const id = createSessionInstanceId();
  patchStoreSession(sessionKey, {
    sessionInstanceId: id,
    mirroredSessionInstanceId: '',
  });
  return id;
}

export function routeTask(taskId, sessionKey, sessionInstanceId) {
  if (taskId && sessionKey) store.taskRoutes[taskId] = sessionKey;
  if (taskId && sessionInstanceId) store.taskInstances[taskId] = sessionInstanceId;
}

export function resolveTaskInstance(taskId) {
  return store.taskInstances[taskId] || null;
}

/** 事件是否属于当前页面最新 session */
export function eventMatchesSession(sessionKey, sessionInstanceId) {
  if (!sessionKey || !sessionInstanceId) return true;
  return getStoreSession(sessionKey).sessionInstanceId === sessionInstanceId;
}

/** 当前 store 会话是否接受该 task 的 sessionInstanceId */
export function sessionTaskInstanceMatches(sess, taskId) {
  if (!sess) return true;
  const taskInstance = resolveTaskInstance(taskId);
  if (!taskInstance) return true;
  if (!sess.sessionInstanceId && !sess.mirroredSessionInstanceId) return true;
  return sess.sessionInstanceId === taskInstance
    || sess.mirroredSessionInstanceId === taskInstance;
}

/** 子 Agent 镜像标签是否接受该 session 实例的事件 */
export function eventMatchesAgentMirror(agentKey, sessionInstanceId) {
  if (!agentKey || !sessionInstanceId) return true;
  const s = getStoreSession(agentKey);
  return s.sessionInstanceId === sessionInstanceId
    || s.mirroredSessionInstanceId === sessionInstanceId;
}

/** 记录子任务在子 Agent 标签页的镜像路由 */
export function routeTaskMirror(taskId, agentTabKey) {
  if (taskId && agentTabKey) store.mirrorRoutes[taskId] = agentTabKey;
}

export function resolveMirrorRoute(taskId) {
  return store.mirrorRoutes[taskId] || null;
}

/** 任务收尾应落在哪个 session（镜像标签优先于父窗口路由） */
export function resolveFinalizeKey(taskId, explicitKey, agents = []) {
  const mirror = resolveMirrorRoute(taskId);
  if (mirror) return mirror;
  if (explicitKey) {
    const s = store.sessions[explicitKey];
    if (s?.currentTask?.id === taskId && s?.currentTask?.parentTaskId) return explicitKey;
  }
  return resolveTaskRoute(taskId, null, null, agents) || explicitKey || null;
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
  // 优先用显式 sessionKey（派发子任务会继承父窗口 key）
  if (ctx.sessionKey) return ctx.sessionKey;
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

/**
 * 归档/收尾时选取更完整的步骤（前端流式通常比 DB 终态摘要更细）。
 */
export function preferRicherSteps(dbSteps = [], storedSteps = []) {
  const stored = Array.isArray(storedSteps) ? storedSteps : [];
  const db = Array.isArray(dbSteps) ? dbSteps : [];
  if (!stored.length) return db;
  if (!db.length) return stored;
  const detailTypes = new Set(['thinking', 'tool_call', 'terminal', 'code_edit', 'system_event']);
  const countDetail = (arr) => arr.filter(s => detailTypes.has(s.stepType)).length;
  const storedDetail = countDetail(stored);
  const dbDetail = countDetail(db);
  if (storedDetail > dbDetail) return stored;
  if (dbDetail > storedDetail) return db;
  if (stored.length > db.length) return stored;
  if (db.length > stored.length) return db;
  if (stored.some(s => s.is_delta || s.is_snapshot)) return stored;
  return db;
}

/**
 * 归档/收尾时合并步骤：派发步骤仅存于前端 taskSteps，并与 DB 步骤合并保留编排细节。
 */
export function resolveArchiveSteps(dbSteps = [], storedSteps = []) {
  const stored = Array.isArray(storedSteps) ? storedSteps : [];
  const db = Array.isArray(dbSteps) ? dbSteps : [];
  const delegSteps = stored.filter(s => s.stepType === 'delegation');
  if (!delegSteps.length) {
    return preferRicherSteps(db, stored);
  }
  const storedOther = stored.filter(s => s.stepType !== 'delegation');
  const dbOther = db.filter(s => s.stepType !== 'delegation');
  const other = preferRicherSteps(dbOther, storedOther);
  return [...delegSteps, ...other].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export function patchDelegation(parentKey, childTaskId, patch) {
  if (!parentKey || !childTaskId) return null;
  const parent = getStoreSession(parentKey);
  const dels = { ...(parent.delegations || {}) };
  dels[childTaskId] = { ...(dels[childTaskId] || {}), ...patch };
  patchStoreSession(parentKey, { delegations: dels });
  return dels[childTaskId];
}

/** 查找某子 Agent 标签相关的 hub 派发记录 */
export function findDelegationsForAgentTab(agentKey, agents = []) {
  if (!agentKey || agentKey === '__hub__') return [];
  const hub = getStoreSession('__hub__');
  const hubInstance = hub.sessionInstanceId;
  const out = [];
  for (const [childId, del] of Object.entries(hub.delegations || {})) {
    // 只同步当前 hub 最新 session 的派发
    if (hubInstance && del.sessionInstanceId && del.sessionInstanceId !== hubInstance) continue;
    const tabKey = resolveSessionKey(del.agentId, agents) || del.agentId;
    if (tabKey === agentKey) {
      out.push({ childId, del, parentKey: '__hub__' });
    }
  }
  return out;
}

/**
 * 从聚合入口 delegations 同步镜像到子 Agent 标签
 * （切换标签时补齐执行中/已完成状态）
 */
export function syncDelegatedMirrorToAgentTab(agentKey, agents = []) {
  if (!agentKey || agentKey === '__hub__') return false;
  const matches = findDelegationsForAgentTab(agentKey, agents);
  if (!matches.length) return false;

  const agentSess = getStoreSession(agentKey);
  // 用户点了「新会话」：不回填已完成的旧派发；仅同步仍在执行的派发
  const fresh = isFreshAgentSession(agentSess);
  const candidates = fresh
    ? matches.filter(m => !['completed', 'failed', 'cancelled'].includes(m.del?.status))
    : matches;
  if (!candidates.length) return false;

  const { childId, del } = candidates[candidates.length - 1];
  const terminal = ['completed', 'failed', 'cancelled'].includes(del.status);
  const turns = agentSess.conversationTurns || [];
  const alreadyArchived = turns.some(t => t.taskId === childId);

  routeTaskMirror(childId, agentKey);

  let steps = del.steps || [];
  if (!steps.length && del.result?.summary) {
    steps = [{
      stepType: 'output',
      content: String(del.result.summary),
      timestamp: Date.now(),
      agentId: del.agentId,
    }];
  }

  if (terminal) {
    if (!alreadyArchived && del.prompt) {
      archiveCompletedTurn(agentKey, {
        user: del.prompt,
        steps,
        result: del.result || null,
        status: del.status === 'cancelled' ? 'failed' : del.status,
        taskId: childId,
        timestamp: Date.now(),
      });
    }
    const after = getStoreSession(agentKey);
    patchStoreSession(agentKey, {
      executing: false,
      currentUserPrompt: '',
      taskSteps: [],
      taskResult: null,
      conversationTurns: after.conversationTurns,
      currentTask: agentSess.currentTask?.id === childId
        ? { id: childId, status: del.status }
        : agentSess.currentTask,
    });
    return true;
  }

  // 执行中：从 delegations 补齐镜像（可落到「新会话」空白页）
  patchStoreSession(agentKey, {
    currentUserPrompt: del.prompt || agentSess.currentUserPrompt,
    currentTask: { id: childId, status: 'running', parentTaskId: '__hub__' },
    taskSteps: steps.length ? steps : agentSess.taskSteps,
    executing: true,
    taskResult: null,
    mirroredSessionInstanceId: del.sessionInstanceId || getStoreSession('__hub__').sessionInstanceId || '',
    skipHistoryRecover: 0,
  });
  return true;
}

/** 派发子任务镜像到子 Agent 标签（与父窗口 delegations 并行展示） */
export function syncDelegatedToAgentTab(agentKey, patch) {
  if (!agentKey || !patch?.taskId) return;
  // 派发进来的子任务即使目标标签刚「新会话」也要显示（认领该会话）；不因 fresh 提前退出。
  const s = getStoreSession(agentKey);
  patchStoreSession(agentKey, {
    currentUserPrompt: patch.prompt ?? s.currentUserPrompt,
    currentTask: patch.currentTask ?? {
      id: patch.taskId,
      status: patch.executing === false ? (patch.status || 'completed') : 'running',
      parentTaskId: patch.parentTaskId || null,
    },
    taskSteps: patch.steps ?? s.taskSteps,
    taskResult: patch.taskResult ?? s.taskResult,
    executing: patch.executing ?? true,
    skipHistoryRecover: 0,
  });
}

/** 将后端任务状态合并进 store（用于恢复运行中任务） */
export function mergeTaskIntoStore(status) {
  if (!status?.id) return;

  const ctx = status.context || {};
  const key = inferSessionKeyFromTask(status);
  if (isFreshAgentSession(getStoreSession(key))) return;

  routeTask(status.id, key);

  const steps = mapDbSteps(status);
  const running = status.status === 'running' || status.status === 'pending';

  // 派发子任务：更新父窗口 delegations，并镜像到子 Agent 标签
  if (ctx.parentTaskId) {
    const parentKey = key || '__hub__';
    patchDelegation(parentKey, status.id, {
      agentId: status.agent_id,
      prompt: status.prompt,
      steps,
      status: status.status,
      result: status.result,
      sessionInstanceId: ctx.sessionInstanceId || getStoreSession(parentKey).sessionInstanceId,
    });

    const agentKey = resolveSessionKey(status.agent_id, []) || status.agent_id;
    if (agentKey && agentKey !== parentKey) {
      routeTaskMirror(status.id, agentKey);
      if (running) {
        syncDelegatedToAgentTab(agentKey, {
          taskId: status.id,
          parentTaskId: ctx.parentTaskId,
          prompt: status.prompt,
          steps,
          executing: true,
        });
      } else if (status.prompt) {
        // 「新会话」空白页不回填已完成的历史派发
        if (isFreshAgentSession(getStoreSession(agentKey))) return;
        archiveCompletedTurn(agentKey, {
          user: status.prompt,
          steps,
          result: status.result || null,
          status: status.status,
          taskId: status.id,
          cliSessionId: status.result?.cliSessionId || null,
          workingDir: ctx.workingDir || getStoreSession(agentKey).sessionWorkingDir || '',
          timestamp: status.completed_at || Date.now(),
        });
        const after = getStoreSession(agentKey);
        patchStoreSession(agentKey, {
          executing: false,
          currentUserPrompt: '',
          taskSteps: [],
          taskResult: null,
          conversationTurns: after.conversationTurns,
        });
      }
    }
    return;
  }

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
      workingDir: ctx.workingDir || getStoreSession(key).sessionWorkingDir || '',
      timestamp: status.completed_at || Date.now(),
    });
    const afterArchive = getStoreSession(key);
    patchStoreSession(key, {
      executing: false,
      currentUserPrompt: '',
      taskSteps: [],
      taskResult: null,
      conversationTurns: afterArchive.conversationTurns,
      cliSessionId: status.result?.cliSessionId || afterArchive.cliSessionId || null,
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
  // currentTask 丢失时，用路由表兜底释放 executing
  const routedKey = store.taskRoutes[taskId];
  if (routedKey && !touched.includes(routedKey)) {
    const s = store.sessions[routedKey];
    if (s?.executing) {
      store.sessions[routedKey] = {
        ...s,
        executing: false,
        currentTask: s.currentTask
          ? { ...s.currentTask, ...taskPatch, id: s.currentTask.id || taskId }
          : { id: taskId, ...taskPatch },
      };
      touched.push(routedKey);
    }
  }
  // 镜像标签页兜底释放
  const mirrorKey = store.mirrorRoutes[taskId];
  if (mirrorKey && !touched.includes(mirrorKey)) {
    const s = store.sessions[mirrorKey];
    if (s?.executing) {
      store.sessions[mirrorKey] = {
        ...s,
        executing: false,
        currentTask: s.currentTask
          ? { ...s.currentTask, ...taskPatch }
          : { id: taskId, ...taskPatch },
      };
      touched.push(mirrorKey);
    }
  }
  return touched;
}

export function clearSessionTaskState(sessionKey) {
  const instanceId = createSessionInstanceId();
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
    skipHistoryRecover: Date.now(),
    sessionInstanceId: instanceId,
    mirroredSessionInstanceId: '',
  });
}

/** 用户刚点击「新会话」后的空白会话（应忽略迟到的任务收尾/恢复） */
export function isFreshAgentSession(sess) {
  if (!sess?.skipHistoryRecover) return false;
  if (Date.now() - sess.skipHistoryRecover > 120_000) return false;
  return !sess.executing
    && !sess.currentUserPrompt
    && !sess.taskSteps?.length
    && !sess.currentTask
    && !sess.conversationTurns?.length;
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
    delegations: turn.delegations || {},
    result: turn.result || null,
    status: turn.status || 'completed',
    taskId: turn.taskId || null,
    timestamp: turn.timestamp || Date.now(),
  });
  patchStoreSession(sessionKey, {
    conversationTurns: turns,
    cliSessionId: turn.cliSessionId || s.cliSessionId || null,
    sessionWorkingDir: normalizeWorkingDir(turn.workingDir || s.sessionWorkingDir || ''),
  });
}

/** 统一工作目录字符串，避免尾斜杠导致续接失败 */
export function normalizeWorkingDir(dir) {
  const s = String(dir || '').trim();
  if (!s) return '';
  return s.replace(/[\\/]+$/, '');
}

/** 同工作目录下是否可续接 CLI 会话 */
export function shouldContinueCliSession(sessionKey, workingDir) {
  const s = getStoreSession(sessionKey);
  const dir = normalizeWorkingDir(workingDir);
  const bound = normalizeWorkingDir(s.sessionWorkingDir);
  if (!dir || !bound || dir !== bound) return false;
  if (!s.conversationTurns?.length) return false;
  const last = s.conversationTurns[s.conversationTurns.length - 1];
  // 仅上一轮成功完成时才续接（避免失败 session 或无效 sessionId）
  if (last?.status !== 'completed') return false;
  return !!(s.cliSessionId || last?.result?.cliSessionId);
}

/** Debug Agent 列表前端缓存（stale-while-revalidate） */
let agentsListCache = null;

export function getCachedAgentsList() {
  return agentsListCache;
}

export function setCachedAgentsList(agents) {
  agentsListCache = Array.isArray(agents) ? agents : null;
}

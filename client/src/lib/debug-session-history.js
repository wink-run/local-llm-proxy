/** Debug Agent / LLM 模式：历史会话本地持久化（新会话清空后仍可恢复） */

import { makeT } from '../i18n.js';

const STORAGE_KEY = 'tokenbank.debug.agentSessions';
const LLM_STORAGE_KEY = 'tokenbank.debug.llmSessions';
const MAX_PER_AGENT = 40;
const MAX_LLM = 40;
const LLM_CHAT_MAX = 200;
const B64_OMITTED = '__b64_omitted__';

function uiT(key, vars) {
  let lang = 'zh';
  try { lang = localStorage.getItem('lang') || 'zh'; } catch { /* ignore */ }
  return makeT(lang)(key, vars);
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, items: [] };
    const data = JSON.parse(raw);
    return {
      version: 1,
      items: Array.isArray(data.items) ? data.items : [],
    };
  } catch {
    return { version: 1, items: [] };
  }
}

function writeStore(data) {
  const payload = JSON.stringify(data);
  try {
    localStorage.setItem(STORAGE_KEY, payload);
    return true;
  } catch {
    // quota 超限：丢掉更旧条目后重试，尽量保住最新完整会话
    try {
      const items = Array.isArray(data.items) ? data.items.slice(0, Math.max(5, Math.floor((data.items || []).length / 2))) : [];
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, items }));
      return true;
    } catch {
      return false;
    }
  }
}

function readLlmStore() {
  try {
    const raw = localStorage.getItem(LLM_STORAGE_KEY);
    if (!raw) return { version: 1, items: [] };
    const data = JSON.parse(raw);
    return {
      version: 1,
      items: Array.isArray(data.items) ? data.items : [],
    };
  } catch {
    return { version: 1, items: [] };
  }
}

function writeLlmStore(data) {
  try {
    localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // quota 超限等：忽略
  }
}

/** 用首轮用户输入生成会话标题 */
export function buildSessionTitle(turns = []) {
  const first = turns.find(t => t?.user)?.user;
  if (!first) return uiT('debug.history.untitledSession');
  const s = String(first).trim().replace(/\s+/g, ' ');
  return s.length > 52 ? `${s.slice(0, 52)}…` : s;
}

/** LLM 对话：用首条用户消息作标题（纯图时用占位） */
export function buildLlmSessionTitle(conversation = []) {
  const first = conversation.find(m =>
    m?.role === 'user' && (String(m.content || '').trim() || (Array.isArray(m.images) && m.images.length > 0))
  );
  if (!first) return uiT('debug.history.untitledSession');
  const text = String(first.content || '').trim().replace(/\s+/g, ' ');
  if (!text) return uiT('debug.history.imageOnlyTitle');
  return text.length > 52 ? `${text.slice(0, 52)}…` : text;
}

function fingerprintTurns(turns = []) {
  const ids = turns.map(t => t.taskId || t.user).filter(Boolean).join('|');
  return ids || String(turns.length);
}

/** 稳定会话键：同一次多轮对话应始终相同（勿用全量 turns 指纹） */
function resolveAgentHistorySessionKey(snapshot = {}) {
  const sid = String(snapshot.cliSessionId || '').trim();
  if (sid) return `cli:${sid}`;
  const turns = snapshot.conversationTurns || [];
  const firstId = String(turns[0]?.taskId || '').trim();
  if (firstId) return `task:${firstId}`;
  const firstUser = String(turns[0]?.user || '').trim().slice(0, 120);
  if (firstUser) return `user:${firstUser}`;
  return null;
}

/** prev 是否为 next 的前缀轮次（同线程续写） */
function turnsAreSameThread(prevTurns = [], nextTurns = []) {
  if (!prevTurns.length || !nextTurns.length) return false;
  if (prevTurns.length > nextTurns.length) return false;
  for (let i = 0; i < prevTurns.length; i += 1) {
    const a = prevTurns[i]?.taskId || prevTurns[i]?.user;
    const b = nextTurns[i]?.taskId || nextTurns[i]?.user;
    if (!a || a !== b) return false;
  }
  return true;
}

function serializeLlmMessage(msg) {
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

function fingerprintLlmConversation(conversation = []) {
  return conversation
    .map(m => `${m.role}:${String(m.content || '').slice(0, 80)}:${(m.images || []).length}`)
    .join('|') || 'empty';
}

function serializeTurnImages(images) {
  if (!Array.isArray(images)) return undefined;
  return images.map(src => {
    if (!src || src === B64_OMITTED) return B64_OMITTED;
    if (String(src).startsWith('http')) return src;
    return B64_OMITTED;
  });
}

function serializeAgentTurn(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  const images = serializeTurnImages(turn.images);
  if (!images) return turn;
  return { ...turn, images };
}

/** 保存当前标签页会话快照（有已完成轮次时） */
export function saveAgentSessionSnapshot(agentKey, snapshot = {}) {
  if (!agentKey) return null;
  const turns = (snapshot.conversationTurns || []).map(serializeAgentTurn);
  if (!turns.length) return null;

  const store = readStore();
  const fp = fingerprintTurns(turns);
  const sessionKey = resolveAgentHistorySessionKey({ ...snapshot, conversationTurns: turns });
  const now = Date.now();

  // 优先按稳定 sessionKey / 同线程前缀合并，避免「每轮一条」
  let existingIdx = -1;
  if (sessionKey) {
    existingIdx = store.items.findIndex(
      it => it.agentKey === agentKey && it.sessionKey === sessionKey,
    );
  }
  if (existingIdx < 0) {
    existingIdx = store.items.findIndex(
      it => it.agentKey === agentKey && (
        it.fingerprint === fp
        || turnsAreSameThread(it.conversationTurns, turns)
      ),
    );
  }

  const entry = {
    id: existingIdx >= 0 ? store.items[existingIdx].id : `hist_${now}_${Math.random().toString(36).slice(2, 7)}`,
    agentKey,
    sessionKey: sessionKey || (existingIdx >= 0 ? store.items[existingIdx].sessionKey : null),
    title: buildSessionTitle(turns),
    fingerprint: fp,
    savedAt: now,
    turnCount: turns.length,
    conversationTurns: turns,
    sessionWorkingDir: snapshot.sessionWorkingDir || '',
    cliSessionId: snapshot.cliSessionId || null,
    source: 'local',
  };

  if (existingIdx >= 0) {
    store.items[existingIdx] = entry;
  } else {
    store.items.unshift(entry);
  }

  // 清掉同线程的旧残片（历史 bug 留下的「1 轮 / 2 轮」重复条）
  const keepId = entry.id;
  store.items = store.items.filter((it) => {
    if (it.id === keepId || it.agentKey !== agentKey) return true;
    if (sessionKey && it.sessionKey === sessionKey) return false;
    if (turnsAreSameThread(it.conversationTurns, turns)) return false;
    return true;
  });

  // 每个 Agent 标签最多保留 N 条
  const perAgent = store.items.filter(it => it.agentKey === agentKey);
  if (perAgent.length > MAX_PER_AGENT) {
    const dropIds = new Set(perAgent.slice(MAX_PER_AGENT).map(it => it.id));
    store.items = store.items.filter(it => !dropIds.has(it.id));
  }

  writeStore(store);
  return entry;
}

/** 合并同线程重复历史（修复旧版「每轮一条」残留） */
function dedupeAgentItems(items = []) {
  const sorted = items.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const kept = [];
  for (const it of sorted) {
    const key = it.sessionKey || resolveAgentHistorySessionKey(it);
    const dupIdx = kept.findIndex((k) => {
      if (k.agentKey !== it.agentKey) return false;
      const kKey = k.sessionKey || resolveAgentHistorySessionKey(k);
      if (key && kKey && key === kKey) return true;
      return turnsAreSameThread(it.conversationTurns, k.conversationTurns)
        || turnsAreSameThread(k.conversationTurns, it.conversationTurns);
    });
    if (dupIdx < 0) {
      kept.push(key && !it.sessionKey ? { ...it, sessionKey: key } : it);
      continue;
    }
    // 保留轮次更多 / 更新更晚的那条
    const cur = kept[dupIdx];
    const itTurns = (it.conversationTurns || []).length;
    const curTurns = (cur.conversationTurns || []).length;
    if (itTurns > curTurns || (itTurns === curTurns && (it.savedAt || 0) > (cur.savedAt || 0))) {
      kept[dupIdx] = { ...it, sessionKey: key || it.sessionKey || cur.sessionKey };
    }
  }
  return kept;
}

/** 列出某 Agent 标签的本地历史会话 */
export function listAgentSessionSnapshots(agentKey) {
  if (!agentKey) return [];
  const store = readStore();
  const before = store.items.length;
  const deduped = dedupeAgentItems(store.items);
  if (deduped.length !== before) {
    store.items = deduped;
    writeStore(store);
  }
  return deduped
    .filter(it => it.agentKey === agentKey)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** 读取单条历史快照 */
export function getAgentSessionSnapshot(id) {
  if (!id) return null;
  return readStore().items.find(it => it.id === id) || null;
}

/** 删除本地历史会话 */
export function deleteAgentSessionSnapshot(id) {
  if (!id) return;
  const store = readStore();
  store.items = store.items.filter(it => it.id !== id);
  writeStore(store);
}

/** 保存 LLM Playground 会话（有用户消息时） */
export function saveLlmSessionSnapshot(snapshot = {}) {
  const conversation = (snapshot.conversation || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-LLM_CHAT_MAX)
    .map(serializeLlmMessage);
  if (!conversation.some(m =>
    m.role === 'user' && (String(m.content || '').trim() || (Array.isArray(m.images) && m.images.length > 0))
  )) return null;

  const store = readLlmStore();
  const fp = fingerprintLlmConversation(conversation);
  // 稳定键：首条用户消息，避免每多一轮就新建一条
  const firstUser = conversation.find(m =>
    m?.role === 'user' && (String(m.content || '').trim() || (Array.isArray(m.images) && m.images.length > 0))
  );
  const sessionKey = firstUser
    ? `u:${String(firstUser.content || '').trim().slice(0, 120)}#${(firstUser.images || []).length}`
    : null;
  const now = Date.now();
  let existingIdx = -1;
  if (sessionKey) {
    existingIdx = store.items.findIndex(it => it.sessionKey === sessionKey);
  }
  // 前缀合并：旧条对话是新条的前缀 → 视为同会话
  if (existingIdx < 0) {
    existingIdx = store.items.findIndex((it) => {
      if (it.fingerprint === fp) return true;
      const prev = it.conversation || [];
      if (!prev.length || prev.length > conversation.length) return false;
      for (let i = 0; i < prev.length; i += 1) {
        if ((prev[i]?.role || '') !== (conversation[i]?.role || '')) return false;
        if (String(prev[i]?.content || '') !== String(conversation[i]?.content || '')) return false;
      }
      return true;
    });
  }
  const turnCount = conversation.filter(m => m.role === 'user').length;

  const entry = {
    id: existingIdx >= 0 ? store.items[existingIdx].id : `llm_${now}_${Math.random().toString(36).slice(2, 7)}`,
    sessionKey: sessionKey || (existingIdx >= 0 ? store.items[existingIdx].sessionKey : null),
    title: buildLlmSessionTitle(conversation),
    fingerprint: fp,
    savedAt: now,
    turnCount,
    conversation,
    systemPrompt: snapshot.systemPrompt || '',
    imageMode: !!snapshot.imageMode,
    source: 'local',
  };

  if (existingIdx >= 0) store.items[existingIdx] = entry;
  else store.items.unshift(entry);

  const keepId = entry.id;
  store.items = store.items.filter((it) => {
    if (it.id === keepId) return true;
    if (sessionKey && it.sessionKey === sessionKey) return false;
    const prev = it.conversation || [];
    if (!prev.length || prev.length > conversation.length) return true;
    for (let i = 0; i < prev.length; i += 1) {
      if ((prev[i]?.role || '') !== (conversation[i]?.role || '')) return true;
      if (String(prev[i]?.content || '') !== String(conversation[i]?.content || '')) return true;
    }
    return false;
  });

  if (store.items.length > MAX_LLM) store.items = store.items.slice(0, MAX_LLM);
  writeLlmStore(store);
  return entry;
}

export function listLlmSessionSnapshots() {
  return readLlmStore().items.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export function getLlmSessionSnapshot(id) {
  if (!id) return null;
  return readLlmStore().items.find(it => it.id === id) || null;
}

export function deleteLlmSessionSnapshot(id) {
  if (!id) return;
  const store = readLlmStore();
  store.items = store.items.filter(it => it.id !== id);
  writeLlmStore(store);
}

export function formatSessionTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

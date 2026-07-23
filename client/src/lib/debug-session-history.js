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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // quota 超限等：忽略
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

/** LLM 对话：用首条用户消息作标题 */
export function buildLlmSessionTitle(conversation = []) {
  const first = conversation.find(m => m?.role === 'user' && String(m.content || '').trim());
  if (!first) return uiT('debug.history.untitledSession');
  const s = String(first.content).trim().replace(/\s+/g, ' ');
  return s.length > 52 ? `${s.slice(0, 52)}…` : s;
}

function fingerprintTurns(turns = []) {
  const ids = turns.map(t => t.taskId || t.user).filter(Boolean).join('|');
  return ids || String(turns.length);
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

/** 保存当前标签页会话快照（有已完成轮次时） */
export function saveAgentSessionSnapshot(agentKey, snapshot = {}) {
  if (!agentKey) return null;
  const turns = snapshot.conversationTurns || [];
  if (!turns.length) return null;

  const store = readStore();
  const fp = fingerprintTurns(turns);
  const now = Date.now();
  const existingIdx = store.items.findIndex(
    it => it.agentKey === agentKey && it.fingerprint === fp,
  );

  const entry = {
    id: existingIdx >= 0 ? store.items[existingIdx].id : `hist_${now}_${Math.random().toString(36).slice(2, 7)}`,
    agentKey,
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

  // 每个 Agent 标签最多保留 N 条
  const perAgent = store.items.filter(it => it.agentKey === agentKey);
  if (perAgent.length > MAX_PER_AGENT) {
    const dropIds = new Set(perAgent.slice(MAX_PER_AGENT).map(it => it.id));
    store.items = store.items.filter(it => !dropIds.has(it.id));
  }

  writeStore(store);
  return entry;
}

/** 列出某 Agent 标签的本地历史会话 */
export function listAgentSessionSnapshots(agentKey) {
  if (!agentKey) return [];
  return readStore()
    .items
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
  if (!conversation.some(m => m.role === 'user' && String(m.content || '').trim())) return null;

  const store = readLlmStore();
  const fp = fingerprintLlmConversation(conversation);
  const now = Date.now();
  const existingIdx = store.items.findIndex(it => it.fingerprint === fp);
  const turnCount = conversation.filter(m => m.role === 'user').length;

  const entry = {
    id: existingIdx >= 0 ? store.items[existingIdx].id : `llm_${now}_${Math.random().toString(36).slice(2, 7)}`,
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

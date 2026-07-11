/** Debug Agent 模式：历史会话本地持久化（新会话清空后仍可恢复） */

const STORAGE_KEY = 'tokenbank.debug.agentSessions';
const MAX_PER_AGENT = 40;

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

/** 用首轮用户输入生成会话标题 */
export function buildSessionTitle(turns = []) {
  const first = turns.find(t => t?.user)?.user;
  if (!first) return '未命名会话';
  const s = String(first).trim().replace(/\s+/g, ' ');
  return s.length > 52 ? `${s.slice(0, 52)}…` : s;
}

function fingerprintTurns(turns = []) {
  const ids = turns.map(t => t.taskId || t.user).filter(Boolean).join('|');
  return ids || String(turns.length);
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

/** Debug Agent / LLM 模式：历史会话本地持久化（新会话清空后仍可恢复） */

import { makeT } from '../i18n.js';
import { serializeImageSrc } from './debug-image-store.js';

const STORAGE_KEY = 'tokenbank.debug.agentSessions';
const LLM_STORAGE_KEY = 'tokenbank.debug.llmSessions';
const MAX_PER_AGENT = 40;
const MAX_LLM = 40;
const LLM_CHAT_MAX = 200;

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

/** 稳定会话键：同一次多轮对话应始终相同（勿用会变的 cliSessionId 抢先） */
function resolveAgentHistorySessionKey(snapshot = {}) {
  // 显式线程 id（内存会话粘性）
  const sticky = String(snapshot.historyThreadId || '').trim();
  if (sticky) return sticky;

  const turns = snapshot.conversationTurns || [];
  // 以首轮 taskId 为轴：中断后续跑即使换了 CLI session，仍归同一条历史
  const firstId = String(turns[0]?.taskId || '').trim();
  if (firstId) return `task:${firstId}`;

  const sid = String(snapshot.cliSessionId || '').trim();
  if (sid) return `cli:${sid}`;

  const firstUser = String(turns[0]?.user || '').trim().slice(0, 120);
  if (firstUser) return `user:${firstUser}`;
  return null;
}

/** 是否像「中断后续跑」占位首轮（不应单独开新历史条） */
function looksLikeResumePrompt(user) {
  const s = String(user || '').trim();
  if (!s) return false;
  if (s === '继续' || s === 'Continue' || s === 'continue') return true;
  return /^(请从上次中断处继续|请继续|从上次中断|Resume from|Please continue from)/i.test(s);
}

function normalizeHistoryDir(dir) {
  return String(dir || '').replace(/[\\/]+$/, '');
}

/** 把「仅含续跑提示」的碎片合并进最近一条同 Agent 历史 */
function findResumeMergeIndex(items, agentKey, turns, workingDir) {
  if (!turns?.length || !looksLikeResumePrompt(turns[0]?.user)) return -1;
  const dir = normalizeHistoryDir(workingDir);
  let bestIdx = -1;
  let bestAt = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (!it || it.agentKey !== agentKey) continue;
    const prev = it.conversationTurns || [];
    if (!prev.length) continue;
    // 已是同线程前缀则走常规合并
    if (turnsAreSameThread(prev, turns) || turnsAreSameThread(turns, prev)) continue;
    if (looksLikeResumePrompt(prev[0]?.user) && prev.length <= 2) continue;
    const itDir = normalizeHistoryDir(it.sessionWorkingDir);
    if (dir && itDir && dir !== itDir) continue;
    const at = it.savedAt || 0;
    if (at >= bestAt) {
      bestAt = at;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * 续聊碎片合并：同 cliSessionId，或同工作目录下「单轮新条」并回最近会话。
 * 避免内存轮次丢失后按新 taskId 另开一条。
 * opts.disallowDirMerge：用户刚点「新会话」时禁止仅按目录合并。
 */
function findContinuationMergeIndex(items, agentKey, turns, workingDir, cliSessionId, opts = {}) {
  if (!turns?.length) return -1;
  const sid = String(cliSessionId || '').trim();
  const dir = normalizeHistoryDir(workingDir);
  const turnIds = new Set(turns.map((t) => t?.taskId).filter(Boolean));

  // 1) 同 CLI session —— 最强信号（--resume 续跑）
  if (sid) {
    const byCli = items.findIndex((it) => (
      it?.agentKey === agentKey
      && String(it.cliSessionId || '').trim() === sid
      && (it.conversationTurns || []).length > 0
      && !turnsAreSameThread(it.conversationTurns, turns)
    ));
    if (byCli >= 0) return byCli;
  }

  // 2) 当前条的 taskId 已出现在某条历史中 → 同会话补档
  if (turnIds.size) {
    const byTask = items.findIndex((it) => {
      if (!it || it.agentKey !== agentKey) return false;
      const prev = it.conversationTurns || [];
      if (!prev.length) return false;
      return prev.some((t) => t?.taskId && turnIds.has(t.taskId));
    });
    if (byTask >= 0) return byTask;
  }

  // 3) 单轮/双轮碎片 + 同工作目录 → 并入最近多轮会话（新会话窗口内跳过）
  if (opts.disallowDirMerge || turns.length > 2) return -1;
  let bestIdx = -1;
  let bestAt = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (!it || it.agentKey !== agentKey) continue;
    const prev = it.conversationTurns || [];
    if (prev.length < 2) continue;
    if (turnsAreSameThread(prev, turns) || turnsAreSameThread(turns, prev)) continue;
    const itDir = normalizeHistoryDir(it.sessionWorkingDir);
    if (!dir || !itDir || dir !== itDir) continue;
    const at = it.savedAt || 0;
    if (at >= bestAt) {
      bestAt = at;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** 合并续跑碎片：按 taskId 去重后，再按时间戳排成时间线 */
function mergeResumeTurns(prevTurns = [], nextTurns = []) {
  const byId = new Map();
  const anon = [];
  for (const t of [...prevTurns, ...nextTurns]) {
    if (!t || typeof t !== 'object') continue;
    if (t.taskId) {
      const prev = byId.get(t.taskId);
      if (prev) {
        byId.set(t.taskId, {
          ...prev,
          ...t,
          // 保留更早的时间戳，避免后写入的 now 打乱顺序
          timestamp: pickEarlierTimestamp(prev.timestamp, t.timestamp),
        });
      } else {
        byId.set(t.taskId, { ...t });
      }
    } else {
      anon.push({ ...t });
    }
  }
  return sortTurnsChronologically([...byId.values(), ...anon]);
}

function pickEarlierTimestamp(a, b) {
  const ta = Number(a) || 0;
  const tb = Number(b) || 0;
  if (ta > 0 && tb > 0) return Math.min(ta, tb);
  return ta || tb || undefined;
}

/** 有 timestamp 的按时间排；缺失则保持稳定相对顺序 */
function sortTurnsChronologically(turns = []) {
  return turns
    .map((t, i) => ({ t, i, ts: Number(t?.timestamp) || 0 }))
    .sort((a, b) => {
      if (a.ts > 0 && b.ts > 0 && a.ts !== b.ts) return a.ts - b.ts;
      return a.i - b.i;
    })
    .map(({ t }) => t);
}

/** 合并前给缺 timestamp 的轮次打上会话级回退时间，便于碎片按时间线归位 */
function stampTurnsForMerge(turns = [], fallbackTs = 0) {
  const base = Number(fallbackTs) || 0;
  return turns.map((t, i) => {
    if (!t || t.timestamp) return t;
    if (!base) return t;
    // 同一会话内用 savedAt + 序号，保持相对先后
    return { ...t, timestamp: base + i };
  });
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
    images: base.images.map(serializeImageSrc),
  };
}

function fingerprintLlmConversation(conversation = []) {
  return conversation
    .map(m => `${m.role}:${String(m.content || '').slice(0, 80)}:${(m.images || []).length}`)
    .join('|') || 'empty';
}

function serializeTurnImages(images) {
  if (!Array.isArray(images)) return undefined;
  return images.map(serializeImageSrc);
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
  let turns = (snapshot.conversationTurns || []).map(serializeAgentTurn);
  if (!turns.length) return null;

  const store = readStore();
  const workingDir = snapshot.sessionWorkingDir || '';
  let sessionKey = resolveAgentHistorySessionKey({ ...snapshot, conversationTurns: turns });
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
        it.fingerprint === fingerprintTurns(turns)
        || turnsAreSameThread(it.conversationTurns, turns)
      ),
    );
  }
  // 中断后续跑若内存轮次被清空，首轮变成「继续」——并回最近一条同 Agent 历史，勿新开会话
  if (existingIdx < 0) {
    const resumeIdx = findResumeMergeIndex(store.items, agentKey, turns, workingDir);
    if (resumeIdx >= 0) {
      existingIdx = resumeIdx;
      const prev = store.items[resumeIdx];
      const merged = mergeResumeTurns(
        stampTurnsForMerge(prev.conversationTurns || [], prev.savedAt),
        stampTurnsForMerge(turns, now),
      );
      turns = merged.map(serializeAgentTurn);
      sessionKey = prev.sessionKey
        || resolveAgentHistorySessionKey({
          ...prev,
          conversationTurns: turns,
        })
        || sessionKey;
    }
  }
  // 同 CLI session / 同目录单轮碎片：并回已有会话（修复「每跟一嘴就新开一条」）
  if (existingIdx < 0) {
    const contIdx = findContinuationMergeIndex(
      store.items,
      agentKey,
      turns,
      workingDir,
      snapshot.cliSessionId,
      { disallowDirMerge: !!snapshot.disallowDirMerge },
    );
    if (contIdx >= 0) {
      existingIdx = contIdx;
      const prev = store.items[contIdx];
      const merged = mergeResumeTurns(
        stampTurnsForMerge(prev.conversationTurns || [], prev.savedAt),
        stampTurnsForMerge(turns, now),
      );
      turns = merged.map(serializeAgentTurn);
      sessionKey = prev.sessionKey
        || resolveAgentHistorySessionKey({
          ...prev,
          conversationTurns: turns,
        })
        || sessionKey;
    }
  }

  // 落盘前再按时间排一次，治愈历史错序
  turns = sortTurnsChronologically(turns).map(serializeAgentTurn);

  const fp = fingerprintTurns(turns);
  const entry = {
    id: existingIdx >= 0 ? store.items[existingIdx].id : `hist_${now}_${Math.random().toString(36).slice(2, 7)}`,
    agentKey,
    sessionKey: sessionKey || (existingIdx >= 0 ? store.items[existingIdx].sessionKey : null),
    title: buildSessionTitle(turns),
    fingerprint: fp,
    savedAt: now,
    turnCount: turns.length,
    conversationTurns: turns,
    sessionWorkingDir: workingDir,
    cliSessionId: snapshot.cliSessionId
      || (existingIdx >= 0 ? store.items[existingIdx].cliSessionId : null)
      || null,
    source: 'local',
  };

  if (existingIdx >= 0) {
    store.items[existingIdx] = entry;
  } else {
    store.items.unshift(entry);
  }

  // 清掉同线程的旧残片（历史 bug 留下的「1 轮 / 2 轮」重复条）
  const keepId = entry.id;
  const entryCli = String(entry.cliSessionId || '').trim();
  const entryDir = normalizeHistoryDir(entry.sessionWorkingDir);
  const entryTaskIds = new Set(turns.map((t) => t?.taskId).filter(Boolean));
  store.items = store.items.filter((it) => {
    if (it.id === keepId || it.agentKey !== agentKey) return true;
    if (sessionKey && it.sessionKey === sessionKey) return false;
    if (turnsAreSameThread(it.conversationTurns, turns)) return false;
    // 同 CLI / 已并入的 taskId 碎片条删掉
    const itCli = String(it.cliSessionId || '').trim();
    if (entryCli && itCli && entryCli === itCli) return false;
    const itTurns = it.conversationTurns || [];
    if (itTurns.length <= 2 && itTurns.some((t) => t?.taskId && entryTaskIds.has(t.taskId))) {
      return false;
    }
    // 同目录单轮碎片且其内容已在本会话中
    const itDir = normalizeHistoryDir(it.sessionWorkingDir);
    if (entryDir && itDir && entryDir === itDir && itTurns.length <= 2) {
      if (itTurns.some((t) => t?.taskId && entryTaskIds.has(t.taskId))) return false;
    }
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
  const DIR_HEAL_MS = 2 * 60 * 60 * 1000; // 2h 内同目录单轮碎片并回多轮
  for (const it of sorted) {
    const key = it.sessionKey || resolveAgentHistorySessionKey(it);
    const sid = String(it.cliSessionId || '').trim();
    const dir = normalizeHistoryDir(it.sessionWorkingDir);
    const itTurns = it.conversationTurns || [];
    const dupIdx = kept.findIndex((k) => {
      if (k.agentKey !== it.agentKey) return false;
      const kKey = k.sessionKey || resolveAgentHistorySessionKey(k);
      if (key && kKey && key === kKey) return true;
      const kSid = String(k.cliSessionId || '').trim();
      if (sid && kSid && sid === kSid) return true;
      if (turnsAreSameThread(it.conversationTurns, k.conversationTurns)
        || turnsAreSameThread(k.conversationTurns, it.conversationTurns)) {
        return true;
      }
      // 治愈已拆开的同目录碎片：短时间内单轮 ↔ 多轮，或两个单轮先捏合
      const kDir = normalizeHistoryDir(k.sessionWorkingDir);
      const kTurns = k.conversationTurns || [];
      if (dir && kDir && dir === kDir) {
        const near = Math.abs((it.savedAt || 0) - (k.savedAt || 0)) <= DIR_HEAL_MS;
        if (near && itTurns.length <= 2 && kTurns.length <= 2) return true;
        if (near && ((itTurns.length <= 2 && kTurns.length >= 2)
          || (kTurns.length <= 2 && itTurns.length >= 2))) {
          return true;
        }
      }
      return false;
    });
    if (dupIdx < 0) {
      kept.push(key && !it.sessionKey ? { ...it, sessionKey: key } : it);
      continue;
    }
    // 以轮次更多的一侧为骨架合并，再按时间戳排成正确对话顺序
    const cur = kept[dupIdx];
    const curTurns = stampTurnsForMerge(cur.conversationTurns || [], cur.savedAt);
    const nxtTurns = stampTurnsForMerge(it.conversationTurns || [], it.savedAt);
    const mergedTurns = mergeResumeTurns(curTurns, nxtTurns);
    const preferIt = nxtTurns.length > curTurns.length
      || (nxtTurns.length === curTurns.length && (it.savedAt || 0) > (cur.savedAt || 0));
    const base = preferIt ? it : cur;
    // 标题用时间线上最早一轮，避免跟聊碎片抢标题
    const titleSource = mergedTurns;
    kept[dupIdx] = {
      ...base,
      conversationTurns: mergedTurns,
      turnCount: mergedTurns.length,
      title: buildSessionTitle(titleSource),
      fingerprint: fingerprintTurns(mergedTurns),
      // sessionKey 优先保留「更早/更多轮」一侧的稳定键
      sessionKey: (curTurns.length >= nxtTurns.length
        ? (cur.sessionKey || key)
        : (it.sessionKey || key))
        || resolveAgentHistorySessionKey({ ...base, conversationTurns: mergedTurns }),
      cliSessionId: it.cliSessionId || cur.cliSessionId || null,
      sessionWorkingDir: it.sessionWorkingDir || cur.sessionWorkingDir || '',
      savedAt: Math.max(it.savedAt || 0, cur.savedAt || 0),
    };
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

/**
 * 续跑前查找应附着的本地历史（同 CLI session 或同工作目录最近一条）。
 * 供内存轮次被清空时回填，避免新开一条。
 */
export function findAgentSessionForContinue(agentKey, { workingDir = '', cliSessionId = '' } = {}) {
  if (!agentKey) return null;
  const list = listAgentSessionSnapshots(agentKey);
  if (!list.length) return null;
  const sid = String(cliSessionId || '').trim();
  if (sid) {
    const byCli = list
      .filter((it) => String(it.cliSessionId || '').trim() === sid)
      // 同 CLI 下优先多轮完整会话
      .sort((a, b) => (b.conversationTurns?.length || 0) - (a.conversationTurns?.length || 0)
        || (b.savedAt || 0) - (a.savedAt || 0));
    if (byCli[0]?.conversationTurns?.length) return byCli[0];
  }
  const dir = normalizeHistoryDir(workingDir);
  if (dir) {
    const byDir = list
      .filter((it) => normalizeHistoryDir(it.sessionWorkingDir) === dir)
      .sort((a, b) => (b.conversationTurns?.length || 0) - (a.conversationTurns?.length || 0)
        || (b.savedAt || 0) - (a.savedAt || 0));
    if (byDir[0]?.conversationTurns?.length) return byDir[0];
  }
  // 无目录线索时：仍优先多轮，避免回填到拆开的单轮碎片
  const ranked = list.slice().sort((a, b) => (b.conversationTurns?.length || 0) - (a.conversationTurns?.length || 0)
    || (b.savedAt || 0) - (a.savedAt || 0));
  return ranked[0]?.conversationTurns?.length ? ranked[0] : null;
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

# Session Manager (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "会话管理" tab to the Gateway page that aggregates sessions across all agents (Claude Code / Codex / Cursor) into one searchable, manageable list, with overlay metadata (favorite/tags/note/archive) and export to a portable session pack (JSON + Markdown).

**Architecture:** Pure logic (row merge, meta join, pack serializers) lives in a new testable `session-manager.js` module. `session-browser.js` gains `listAllSessions()` that fans out over its existing `HANDLERS`. `local-stats.js` gains a `session_meta` overlay table (never touches agent JSONL files). `main.js` exposes three IPC channels under a new `sessions:` namespace; the React `SessionManager` component renders the tab and reuses the existing `SessionTraceModal`.

**Tech Stack:** Electron (Node 22 main process), better-sqlite3, React 18 (Vite), Tailwind, `node:test` for pure-logic unit tests.

---

## File Structure

- Create `client/electron/session-manager.js` — pure helpers (`mergeAgentRows`, `joinSessionsWithMeta`, `buildSessionPackJSON`, `renderSessionPackMarkdown`) + orchestration (`getSessions`, `exportSession`).
- Create `client/electron/__tests__/session-manager.test.js` — `node:test` unit tests for the four pure helpers.
- Modify `client/electron/session-browser.js` — add `listAllSessions(opts)`, export it.
- Modify `client/electron/local-stats.js` — add `session_meta` table + `getSessionMeta` / `setSessionMeta` / `listSessionMeta`, export them.
- Modify `client/electron/main.js` — register `sessions:listAll`, `sessions:setMeta`, `sessions:export` IPC handlers.
- Modify `client/electron/preload.js` — expose `window.electronAPI.sessions.*`.
- Modify `client/src/pages/Gateway.jsx` — add third tab + `SessionManager` / `SessionRow` / `SessionMetaPopover` / `ExportMenu` components (reuse `SessionTraceModal`).
- Modify `client/src/locales/pages-zh.js` and `client/src/locales/pages-en.js` — i18n keys.

**Verification split:** Pure helpers → `node --test`. DB layer, IPC, and React → manual verification by running the app (`better-sqlite3` is electron-rebuilt and won't load under plain node).

---

## Task 1: Pure helpers + unit tests (`session-manager.js`)

**Files:**
- Create: `client/electron/session-manager.js`
- Test: `client/electron/__tests__/session-manager.test.js`

- [ ] **Step 1: Write the failing tests**

Create `client/electron/__tests__/session-manager.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  mergeAgentRows,
  joinSessionsWithMeta,
  buildSessionPackJSON,
  renderSessionPackMarkdown,
} = require('../session-manager');

test('mergeAgentRows tags agent_id and sorts by lastTs desc', () => {
  const out = mergeAgentRows({
    'claude-code': [{ session_id: 'a', lastTs: 100, agent: 'claude-code' }],
    codex: [{ session_id: 'b', lastTs: 300 }, { session_id: 'c', lastTs: 200 }],
  });
  assert.deepEqual(out.map(r => r.session_id), ['b', 'c', 'a']);
  assert.equal(out[0].agent_id, 'codex');
  assert.equal(out[2].agent_id, 'claude-code');
});

test('mergeAgentRows tolerates empty / missing arrays', () => {
  const out = mergeAgentRows({ cursor: [], codex: null });
  assert.deepEqual(out, []);
});

test('joinSessionsWithMeta attaches meta and filters archived by default', () => {
  const rows = [
    { session_id: 'a', agent_id: 'codex', lastTs: 2 },
    { session_id: 'b', agent_id: 'codex', lastTs: 1 },
  ];
  const meta = [
    { agent_id: 'codex', session_id: 'a', favorite: 1, tags: 'design', note: 'hi', archived: 0 },
    { agent_id: 'codex', session_id: 'b', favorite: 0, tags: '', note: '', archived: 1 },
  ];
  const out = joinSessionsWithMeta(rows, meta, { showArchived: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 'a');
  assert.equal(out[0].favorite, true);
  assert.deepEqual(out[0].tags, ['design']);
  assert.equal(out[0].note, 'hi');
});

test('joinSessionsWithMeta keeps archived when showArchived=true', () => {
  const rows = [{ session_id: 'b', agent_id: 'codex' }];
  const meta = [{ agent_id: 'codex', session_id: 'b', archived: 1 }];
  const out = joinSessionsWithMeta(rows, meta, { showArchived: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].archived, true);
});

test('buildSessionPackJSON produces a versioned pack from a trace', () => {
  const trace = {
    project: 'demo', project_path: '/x/demo',
    stats: { steps: 2, tools: 1, tokens: { input: 10, output: 5, cached: 0 } },
    steps: [
      { kind: 'user', label: 'q', text: 'hello', ts: 1000 },
      { kind: 'tool', tool: 'Read', label: 'Read', input: { path: 'a' }, ts: 1001 },
    ],
  };
  const pack = buildSessionPackJSON({ trace, agent_id: 'codex', session_id: 's1' });
  assert.equal(pack.version, 1);
  assert.equal(pack.kind, 'tokenbank.session-pack');
  assert.equal(pack.source.agent_id, 'codex');
  assert.equal(pack.source.project, 'demo');
  assert.equal(pack.messages.length, 2);
  assert.equal(pack.messages[0].role, 'user');
  assert.equal(pack.messages[1].role, 'tool');
  assert.equal(pack.messages[1].tool, 'Read');
});

test('renderSessionPackMarkdown renders headers and bodies', () => {
  const pack = {
    source: { agent_id: 'codex', project: 'demo' },
    messages: [
      { role: 'user', text: 'hello', ts: 1000 },
      { role: 'assistant', text: 'hi there', ts: 1001 },
      { role: 'tool', tool: 'Read', input: 'path=a', ts: 1002 },
    ],
  };
  const md = renderSessionPackMarkdown(pack);
  assert.match(md, /# demo/);
  assert.match(md, /## USER/);
  assert.match(md, /hello/);
  assert.match(md, /## AI/);
  assert.match(md, /Read/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test client/electron/__tests__/session-manager.test.js`
Expected: FAIL — `Cannot find module '../session-manager'`.

- [ ] **Step 3: Write the minimal implementation**

Create `client/electron/session-manager.js`:

```js
// client/electron/session-manager.js
// 跨 agent 会话聚合 + 叠加层合并 + 会话包导出（纯逻辑可单测；IO 在 orchestration 段）。
'use strict';

/** 将 {agentId: rows[]} 展平为单数组，打上 agent_id，按 lastTs 倒序。 */
function mergeAgentRows(resultsByAgent = {}) {
  const out = [];
  for (const [agentId, rows] of Object.entries(resultsByAgent)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      out.push({ ...r, agent_id: r.agent_id || r.agent || agentId });
    }
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean);
  if (typeof tags === 'string' && tags.trim()) {
    return tags.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** 用叠加层元数据 left-join 会话行；默认过滤 archived。 */
function joinSessionsWithMeta(rows = [], metaRows = [], { showArchived = false } = {}) {
  const byKey = new Map();
  for (const m of metaRows || []) byKey.set(`${m.agent_id}::${m.session_id}`, m);
  const out = [];
  for (const r of rows) {
    const m = byKey.get(`${r.agent_id}::${r.session_id}`) || {};
    const archived = !!m.archived;
    if (archived && !showArchived) continue;
    out.push({
      ...r,
      favorite: !!m.favorite,
      tags: parseTags(m.tags),
      note: m.note || '',
      archived,
    });
  }
  return out;
}

const ROLE_BY_KIND = { user: 'user', tool: 'tool' };

/** trace.steps → 可移植会话包（JSON）。 */
function buildSessionPackJSON({ trace = {}, agent_id, session_id } = {}) {
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  return {
    version: 1,
    kind: 'tokenbank.session-pack',
    exported_at: new Date().toISOString(),
    source: {
      agent_id: agent_id || null,
      session_id: session_id || null,
      project: trace.project || null,
      project_path: trace.project_path || trace.cwd || null,
    },
    stats: trace.stats || {},
    messages: steps.map(s => {
      const role = ROLE_BY_KIND[s.kind] || 'assistant';
      const msg = { role, ts: s.ts ?? null, text: s.text || '' };
      if (s.kind === 'tool') {
        msg.tool = s.tool || s.label || null;
        if (s.input != null) msg.input = s.input;
      }
      return msg;
    }),
  };
}

function roleHeading(role) {
  if (role === 'user') return '## USER';
  if (role === 'tool') return '## TOOL';
  return '## AI';
}

/** 会话包 → 人可读 Markdown transcript。 */
function renderSessionPackMarkdown(pack = {}) {
  const src = pack.source || {};
  const lines = [`# ${src.project || src.session_id || 'session'}`, ''];
  if (src.agent_id) lines.push(`> agent: \`${src.agent_id}\``, '');
  for (const m of pack.messages || []) {
    lines.push(roleHeading(m.role));
    if (m.role === 'tool') {
      lines.push('', '```', `${m.tool || 'tool'}`,
        typeof m.input === 'string' ? m.input : JSON.stringify(m.input ?? '', null, 2), '```', '');
    } else {
      lines.push('', m.text || '', '');
    }
  }
  return lines.join('\n');
}

module.exports = {
  mergeAgentRows, joinSessionsWithMeta, buildSessionPackJSON, renderSessionPackMarkdown,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test client/electron/__tests__/session-manager.test.js`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add client/electron/session-manager.js client/electron/__tests__/session-manager.test.js
git commit -m "feat(sessions): pure helpers for aggregation, meta-join, pack export"
```

---

## Task 2: `session_meta` overlay table + accessors (`local-stats.js`)

**Files:**
- Modify: `client/electron/local-stats.js` (SCHEMA near line 90–119; `module.exports` at line 528)

No automated test (better-sqlite3 is electron-rebuilt). Verified in Task 7 by running the app.

- [ ] **Step 1: Add the table to the schema**

In `client/electron/local-stats.js`, find the `SCHEMA` string (the `CREATE TABLE` block ending before the `MIGRATIONS` array near line 90). Append this table definition inside `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS session_meta (
  agent_id   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  favorite   INTEGER DEFAULT 0,
  tags       TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  archived   INTEGER DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (agent_id, session_id)
);
```

- [ ] **Step 2: Add accessor functions**

In `client/electron/local-stats.js`, add these functions above `module.exports` (line 528). They guard on `db` being initialized, matching the file's existing style:

```js
/** 列出所有会话叠加层元数据（供聚合 left-join）。 */
function listSessionMeta() {
  if (!db) return [];
  try {
    return db.prepare(
      'SELECT agent_id, session_id, favorite, tags, note, archived FROM session_meta'
    ).all();
  } catch (e) {
    console.error('[local-stats] listSessionMeta failed:', e.message);
    return [];
  }
}

/** 读取单条会话元数据。 */
function getSessionMeta(agent_id, session_id) {
  if (!db) return null;
  try {
    return db.prepare(
      'SELECT agent_id, session_id, favorite, tags, note, archived FROM session_meta WHERE agent_id = ? AND session_id = ?'
    ).get(agent_id, session_id) || null;
  } catch (e) {
    console.error('[local-stats] getSessionMeta failed:', e.message);
    return null;
  }
}

/** Upsert 会话元数据；仅写入传入的字段，其余沿用旧值。返回合并后的行。 */
function setSessionMeta({ agent_id, session_id, favorite, tags, note, archived } = {}) {
  if (!db || !agent_id || !session_id) return null;
  try {
    const prev = getSessionMeta(agent_id, session_id) || {};
    const next = {
      favorite: favorite != null ? (favorite ? 1 : 0) : (prev.favorite || 0),
      tags:     tags != null ? (Array.isArray(tags) ? tags.join(',') : String(tags)) : (prev.tags || ''),
      note:     note != null ? String(note) : (prev.note || ''),
      archived: archived != null ? (archived ? 1 : 0) : (prev.archived || 0),
    };
    db.prepare(
      'INSERT INTO session_meta (agent_id, session_id, favorite, tags, note, archived, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(agent_id, session_id) DO UPDATE SET ' +
      'favorite=excluded.favorite, tags=excluded.tags, note=excluded.note, ' +
      'archived=excluded.archived, updated_at=excluded.updated_at'
    ).run(agent_id, session_id, next.favorite, next.tags, next.note, next.archived, Date.now());
    return getSessionMeta(agent_id, session_id);
  } catch (e) {
    console.error('[local-stats] setSessionMeta failed:', e.message);
    return null;
  }
}
```

- [ ] **Step 3: Export the new functions**

In `client/electron/local-stats.js`, update `module.exports` (line 528) to add the three functions:

```js
module.exports = {
  init, record, queryDashboard, queryByApiKey, queryByApp, queryByDataSource,
  queryAppDetail, queryAppStatsInPeriod, querySessionDetail,
  getImportState, setImportState, resetSessionData, close,
  listSessionMeta, getSessionMeta, setSessionMeta,
};
```

- [ ] **Step 4: Sanity-check syntax**

Run: `node -e "require('./client/electron/session-manager.js'); console.log('session-manager loads')"`
Expected: prints `session-manager loads` (this only checks the pure module; `local-stats.js` requires the electron build, verified later).

- [ ] **Step 5: Commit**

```bash
git add client/electron/local-stats.js
git commit -m "feat(sessions): session_meta overlay table + accessors"
```

---

## Task 3: `listAllSessions` aggregation (`session-browser.js`)

**Files:**
- Modify: `client/electron/session-browser.js` (`HANDLERS` at line 992; `module.exports` at line 1176)

- [ ] **Step 1: Add `listAllSessions`**

In `client/electron/session-browser.js`, add this function right after `listActivity` (line 1002), reusing the existing `HANDLERS` and `mergeAgentRows` from session-manager:

```js
/** 跨所有 agent 聚合会话原始行（含 agent_id，按 lastTs 倒序）。不读叠加层。 */
function listAllSessions(opts = {}) {
  const { mergeAgentRows } = require('./session-manager');
  const resultsByAgent = {};
  for (const agentId of Object.keys(HANDLERS)) {
    try { resultsByAgent[agentId] = HANDLERS[agentId].list(opts) || []; }
    catch { resultsByAgent[agentId] = []; }
  }
  return mergeAgentRows(resultsByAgent);
}
```

- [ ] **Step 2: Export it**

In `client/electron/session-browser.js`, update `module.exports` (line 1176):

```js
module.exports = {
  listActivity, getTrace, mergeActivityWithStats, enrichTraceWithDb,
  enrichRecentDetail, assistantLineLabel, extractContext, shortProjectName, normalizeActivityRow,
  listAllSessions,
};
```

- [ ] **Step 3: Sanity-check require graph**

Run: `node -e "const sm=require('./client/electron/session-manager'); console.log(typeof sm.mergeAgentRows)"`
Expected: prints `function` (confirms session-browser's `require('./session-manager')` target resolves).

- [ ] **Step 4: Commit**

```bash
git add client/electron/session-browser.js
git commit -m "feat(sessions): listAllSessions cross-agent aggregation"
```

---

## Task 4: Orchestration — `getSessions` + `exportSession` (`session-manager.js`)

**Files:**
- Modify: `client/electron/session-manager.js`

These functions wire pure helpers to the DB + filesystem. No unit test (touches IO); verified by running the app.

- [ ] **Step 1: Add orchestration functions**

In `client/electron/session-manager.js`, add before `module.exports`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 聚合会话 + 叠加层 + 过滤。返回供 UI 渲染的会话数组。 */
function getSessions(deps, opts = {}) {
  const { sessionBrowser, localStats } = deps;
  const rows = sessionBrowser.listAllSessions(opts);
  const meta = localStats.listSessionMeta();
  return joinSessionsWithMeta(rows, meta, { showArchived: !!opts.showArchived });
}

/** 导出单会话为 JSON 包或 Markdown，写入默认目录，返回落盘信息。 */
function exportSession(deps, { agent_id, session_id, format = 'json' } = {}) {
  const { sessionBrowser } = deps;
  if (!agent_id || !session_id) return { error: 'missing_params' };
  const trace = sessionBrowser.getTrace(agent_id, session_id);
  if (!trace || trace.error) return { error: 'trace_unavailable' };

  const pack = buildSessionPackJSON({ trace, agent_id, session_id });
  const dir = path.join(os.homedir(), '.tokenbank', 'session-packs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const base = `${(pack.source.project || 'session')}-${session_id.slice(0, 8)}`.replace(/[^\w.-]+/g, '_');
  if (format === 'copy') {
    // 仅返回 Markdown 内容供渲染进程复制到剪贴板，不落盘。
    return { ok: true, format, content: renderSessionPackMarkdown(pack) };
  }
  if (format === 'markdown') {
    const content = renderSessionPackMarkdown(pack);
    const file = path.join(dir, `${base}.md`);
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, file, format, content };
  }
  const content = JSON.stringify(pack, null, 2);
  const file = path.join(dir, `${base}.json`);
  fs.writeFileSync(file, content, 'utf8');
  return { ok: true, file, format, content };
}
```

- [ ] **Step 2: Update exports**

In `client/electron/session-manager.js`, update `module.exports`:

```js
module.exports = {
  mergeAgentRows, joinSessionsWithMeta, buildSessionPackJSON, renderSessionPackMarkdown,
  getSessions, exportSession,
};
```

- [ ] **Step 3: Re-run pure tests (ensure no regression)**

Run: `node --test client/electron/__tests__/session-manager.test.js`
Expected: PASS — all 6 tests still green (adding IO functions must not break pure exports).

- [ ] **Step 4: Commit**

```bash
git add client/electron/session-manager.js
git commit -m "feat(sessions): getSessions + exportSession orchestration"
```

---

## Task 5: IPC handlers + preload bridge

**Files:**
- Modify: `client/electron/main.js` (near the `apps:sessionTrace` handler, line 1768)
- Modify: `client/electron/preload.js` (the `apps:` block ends ~line 152)

- [ ] **Step 1: Register IPC handlers**

In `client/electron/main.js`, immediately after the `apps:sessionTrace` handler (ends at line ~1774), add. Note `sessionBrowser` and `localStats` are already required at the top of the file:

```js
  const sessionManager = require('./session-manager');
  const _sessionDeps = { sessionBrowser, localStats };

  ipcMain.handle('sessions:listAll', (_e, opts = {}) => {
    try { return sessionManager.getSessions(_sessionDeps, opts); }
    catch (e) { console.error('[sessions:listAll]', e.message); return []; }
  });

  ipcMain.handle('sessions:setMeta', (_e, payload = {}) => {
    try { return localStats.setSessionMeta(payload); }
    catch (e) { console.error('[sessions:setMeta]', e.message); return null; }
  });

  ipcMain.handle('sessions:export', (_e, payload = {}) => {
    try { return sessionManager.exportSession(_sessionDeps, payload); }
    catch (e) { console.error('[sessions:export]', e.message); return { error: 'export_failed' }; }
  });
```

- [ ] **Step 2: Expose the preload bridge**

In `client/electron/preload.js`, add a `sessions` namespace next to the `apps` block (after the `apps: { ... }` object closes, ~line 152):

```js
  sessions: {
    listAll: (opts)    => ipcRenderer.invoke('sessions:listAll', opts),
    setMeta: (payload) => ipcRenderer.invoke('sessions:setMeta', payload),
    export:  (payload) => ipcRenderer.invoke('sessions:export', payload),
  },
```

- [ ] **Step 3: Verify the app still boots**

Run: `cd client && npm run dev`
Expected: Electron window opens with no console error mentioning `sessions:` or `session-manager`. Close the app after confirming. (If `better-sqlite3` ABI error appears, run `npm run rebuild` first.)

- [ ] **Step 4: Commit**

```bash
git add client/electron/main.js client/electron/preload.js
git commit -m "feat(sessions): IPC handlers + preload bridge"
```

---

## Task 6: i18n keys

**Files:**
- Modify: `client/src/locales/pages-zh.js` (tab keys at lines 15–16)
- Modify: `client/src/locales/pages-en.js` (matching keys)

- [ ] **Step 1: Add Chinese keys**

In `client/src/locales/pages-zh.js`, after `'gateway.tab.routes': '🔀 场景路由',` (line 16) add:

```js
  'gateway.tab.sessions': '💬 会话管理',
  'gateway.sessions.search': '搜索项目名 / 首条提问…',
  'gateway.sessions.all': '全部',
  'gateway.sessions.favOnly': '收藏',
  'gateway.sessions.showArchived': '显示归档',
  'gateway.sessions.empty': '暂无会话',
  'gateway.sessions.desktopOnly': '会话管理仅在桌面版可用',
  'gateway.sessions.statSessions': '会话',
  'gateway.sessions.statAgents': '智能体',
  'gateway.sessions.statFav': '收藏',
  'gateway.sessions.tag': '标签',
  'gateway.sessions.note': '备注',
  'gateway.sessions.archive': '归档',
  'gateway.sessions.unarchive': '取消归档',
  'gateway.sessions.export': '导出',
  'gateway.sessions.exportJson': '导出 JSON 包',
  'gateway.sessions.exportMd': '导出 Markdown',
  'gateway.sessions.copyMd': '复制 Markdown',
  'gateway.sessions.exported': '已导出到 {file}',
  'gateway.sessions.copied': '已复制到剪贴板',
  'gateway.sessions.exportFailed': '导出失败',
  'gateway.sessions.save': '保存',
```

- [ ] **Step 2: Add English keys**

In `client/src/locales/pages-en.js`, after the matching `'gateway.tab.routes'` line add:

```js
  'gateway.tab.sessions': '💬 Sessions',
  'gateway.sessions.search': 'Search project / first prompt…',
  'gateway.sessions.all': 'All',
  'gateway.sessions.favOnly': 'Favorites',
  'gateway.sessions.showArchived': 'Show archived',
  'gateway.sessions.empty': 'No sessions yet',
  'gateway.sessions.desktopOnly': 'Session manager is desktop-only',
  'gateway.sessions.statSessions': 'sessions',
  'gateway.sessions.statAgents': 'agents',
  'gateway.sessions.statFav': 'favorites',
  'gateway.sessions.tag': 'Tags',
  'gateway.sessions.note': 'Note',
  'gateway.sessions.archive': 'Archive',
  'gateway.sessions.unarchive': 'Unarchive',
  'gateway.sessions.export': 'Export',
  'gateway.sessions.exportJson': 'Export JSON pack',
  'gateway.sessions.exportMd': 'Export Markdown',
  'gateway.sessions.copyMd': 'Copy Markdown',
  'gateway.sessions.exported': 'Exported to {file}',
  'gateway.sessions.copied': 'Copied to clipboard',
  'gateway.sessions.exportFailed': 'Export failed',
  'gateway.sessions.save': 'Save',
```

- [ ] **Step 3: Commit**

```bash
git add client/src/locales/pages-zh.js client/src/locales/pages-en.js
git commit -m "feat(sessions): i18n keys for session manager"
```

---

## Task 7: React — tab + SessionManager components

**Files:**
- Modify: `client/src/pages/Gateway.jsx` (tab array line 2793; `mainTab` state line 2567; add components near `SessionTraceModal` at line 751)

Reuses existing `SessionTraceModal`, `DetailSection`-style markup, and `fmtN` helpers. Verified by running the app.

- [ ] **Step 1: Add the SessionManager component tree**

In `client/src/pages/Gateway.jsx`, add these components just below the `SessionTraceModal` definition (after line 873). The component is desktop-only (gated on `window.electronAPI?.sessions`):

```jsx
/** 会话管理面板：跨 agent 聚合 + 搜索/过滤 + 收藏/标签/归档 + 导出 */
function SessionManager() {
  const { t } = useLang();
  const [rows, setRows]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [q, setQ]                 = useState('');
  const [agentFilter, setAgent]   = useState('all');
  const [favOnly, setFavOnly]     = useState(false);
  const [showArchived, setShowA]  = useState(false);
  const [traceRow, setTraceRow]   = useState(null);
  const [notice, setNotice]       = useState('');
  const fmtN = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n ?? 0));

  const reload = useCallback(() => {
    if (!window.electronAPI?.sessions) { setLoading(false); return; }
    setLoading(true);
    window.electronAPI.sessions.listAll({ showArchived })
      .then(r => { setRows(Array.isArray(r) ? r : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [showArchived]);

  useEffect(() => { reload(); }, [reload]);

  const setMeta = async (row, patch) => {
    await window.electronAPI.sessions.setMeta({
      agent_id: row.agent_id, session_id: row.session_id, ...patch,
    });
    reload();
  };

  const flash = msg => { setNotice(msg); setTimeout(() => setNotice(''), 2500); };

  const doExport = async (row, format) => {
    const res = await window.electronAPI.sessions.export({
      agent_id: row.agent_id, session_id: row.session_id, format,
    });
    if (res?.error || !res?.ok) { flash(t('gateway.sessions.exportFailed')); return; }
    if (format === 'copy') {
      try { await navigator.clipboard.writeText(res.content); flash(t('gateway.sessions.copied')); }
      catch { flash(t('gateway.sessions.exportFailed')); }
      return;
    }
    flash(t('gateway.sessions.exported').replace('{file}', res.file));
  };

  const agents = Array.from(new Set(rows.map(r => r.agent_id)));
  const filtered = rows.filter(r => {
    if (agentFilter !== 'all' && r.agent_id !== agentFilter) return false;
    if (favOnly && !r.favorite) return false;
    if (q) {
      const hay = `${r.project || ''} ${r.context || ''} ${(r.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });
  const favCount = rows.filter(r => r.favorite).length;

  if (!window.electronAPI?.sessions) {
    return <div className="px-5 py-16 text-center text-xs text-zinc-400">{t('gateway.sessions.desktopOnly')}</div>;
  }

  return (
    <div>
      {traceRow && (
        <SessionTraceModal app={null} sessionId={traceRow.session_id}
          traceAgentId={traceRow.agent_id} onClose={() => setTraceRow(null)} />
      )}

      {/* 操作栏 */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder={t('gateway.sessions.search')}
            className="w-full text-xs pl-3 pr-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800" />
        </div>
        <button onClick={() => setAgent('all')}
          className={`text-xs px-3 py-1.5 rounded-full ${agentFilter === 'all' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'border border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
          {t('gateway.sessions.all')}
        </button>
        {agents.map(a => (
          <button key={a} onClick={() => setAgent(a)}
            className={`text-xs px-3 py-1.5 rounded-full ${agentFilter === a ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'border border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
            {a}
          </button>
        ))}
        <button onClick={() => setFavOnly(v => !v)}
          className={`text-xs px-3 py-1.5 rounded-full ${favOnly ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400' : 'border border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
          ★ {t('gateway.sessions.favOnly')}
        </button>
        <label className="text-xs text-zinc-500 flex items-center gap-1 ml-1">
          <input type="checkbox" checked={showArchived} onChange={e => setShowA(e.target.checked)} />
          {t('gateway.sessions.showArchived')}
        </label>
        <div className="ml-auto flex gap-3 text-xs text-zinc-400">
          <span><strong className="text-zinc-700 dark:text-zinc-200">{rows.length}</strong> {t('gateway.sessions.statSessions')}</span>
          <span><strong className="text-zinc-700 dark:text-zinc-200">{agents.length}</strong> {t('gateway.sessions.statAgents')}</span>
          <span><strong className="text-zinc-700 dark:text-zinc-200">{favCount}</strong> {t('gateway.sessions.statFav')}</span>
        </div>
      </div>

      {notice && <div className="px-5 py-1.5 text-xs text-green-600 dark:text-green-400">{notice}</div>}

      {/* 列表 */}
      <div className="max-h-[60vh] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {loading ? (
          <div className="px-5 py-16 text-center text-xs text-zinc-400">…</div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-16 text-center text-xs text-zinc-400">{t('gateway.sessions.empty')}</div>
        ) : filtered.map(row => (
          <SessionRow key={`${row.agent_id}-${row.session_id}`} row={row} fmtN={fmtN}
            onTrace={() => setTraceRow(row)} onMeta={patch => setMeta(row, patch)} onExport={fmt => doExport(row, fmt)} />
        ))}
      </div>
    </div>
  );
}

/** 单会话行 */
function SessionRow({ row, fmtN, onTrace, onMeta, onExport }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const fmtTime = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div className="px-5 py-2.5">
      <div className="grid grid-cols-[6rem_minmax(0,1.4fr)_3.5rem_3.5rem_5rem_5.5rem] gap-2 items-center text-xs">
        <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 text-center truncate">{row.agent_id}</span>
        <div className="min-w-0">
          <div className="font-semibold text-zinc-700 dark:text-zinc-200 truncate flex items-center gap-1">
            <button onClick={() => onMeta({ favorite: !row.favorite })}
              className={row.favorite ? 'text-amber-500' : 'text-zinc-300 hover:text-amber-400'}>★</button>
            {row.project || '—'}
            {(row.tags || []).map(tg => (
              <span key={tg} className="text-xs font-normal px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{tg}</span>
            ))}
          </div>
          <div className="text-zinc-400 truncate">{row.context || '—'}</div>
        </div>
        <div className="text-right tabular-nums text-zinc-600 dark:text-zinc-300">{row.calls ?? 0}</div>
        <div className="text-right tabular-nums text-zinc-600 dark:text-zinc-300">{fmtN(row.tokens)}</div>
        <div className="text-right text-zinc-400">{fmtTime(row.lastTs)}</div>
        <div className="flex gap-2 justify-end text-zinc-400 relative">
          <button title={t('gateway.sessions.tag')} onClick={() => setEditing(v => !v)} className="hover:text-zinc-600">✎</button>
          <button title={t('gateway.sessions.export')} onClick={() => setExportOpen(v => !v)} className="hover:text-zinc-600">⤓</button>
          <button title="trace" onClick={onTrace} className="hover:text-zinc-600">▸</button>
          {exportOpen && (
            <div className="absolute right-0 top-5 z-10 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 text-xs w-40">
              <button onClick={() => { onExport('json'); setExportOpen(false); }} className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700">{t('gateway.sessions.exportJson')}</button>
              <button onClick={() => { onExport('markdown'); setExportOpen(false); }} className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700">{t('gateway.sessions.exportMd')}</button>
              <button onClick={() => { onExport('copy'); setExportOpen(false); }} className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700">{t('gateway.sessions.copyMd')}</button>
            </div>
          )}
        </div>
      </div>
      {editing && (
        <SessionMetaPopover row={row} onSave={patch => { onMeta(patch); setEditing(false); }} onArchive={() => { onMeta({ archived: !row.archived }); setEditing(false); }} />
      )}
    </div>
  );
}

/** 行内标签 + 备注编辑 */
function SessionMetaPopover({ row, onSave, onArchive }) {
  const { t } = useLang();
  const [tags, setTags] = useState((row.tags || []).join(', '));
  const [note, setNote] = useState(row.note || '');
  return (
    <div className="mt-2 ml-[6.5rem] flex items-center gap-2 flex-wrap">
      <input value={tags} onChange={e => setTags(e.target.value)} placeholder={t('gateway.sessions.tag')}
        className="text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 w-40" />
      <input value={note} onChange={e => setNote(e.target.value)} placeholder={t('gateway.sessions.note')}
        className="text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 flex-1 min-w-[120px]" />
      <button onClick={() => onSave({ tags: tags.split(',').map(s => s.trim()).filter(Boolean), note })}
        className="text-xs px-3 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white">{t('gateway.sessions.save')}</button>
      <button onClick={onArchive} className="text-xs px-3 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500">
        {row.archived ? t('gateway.sessions.unarchive') : t('gateway.sessions.archive')}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify `useCallback` is imported**

In `client/src/pages/Gateway.jsx`, check the top-of-file React import. If it is `import { useState, useEffect } from 'react';` (or similar without `useCallback`), add `useCallback` to that import list.

Run: `head -5 client/src/pages/Gateway.jsx`
Expected: confirm `useCallback` is present in the import after editing.

- [ ] **Step 3: Add the third tab**

In `client/src/pages/Gateway.jsx`, change the tab array at line 2793 from:

```jsx
          {[t('gateway.tab.apps'), t('gateway.tab.routes')].map((tabLabel, i) => (
```

to:

```jsx
          {[t('gateway.tab.apps'), t('gateway.tab.routes'), t('gateway.tab.sessions')].map((tabLabel, i) => (
```

- [ ] **Step 4: Render the panel for `mainTab === 2`**

In `client/src/pages/Gateway.jsx`, after the `{mainTab === 1 && ( ... )}` block closes (the 场景路由 block ending near line 2880+), add:

```jsx
        {/* Tab2: 会话管理 */}
        {mainTab === 2 && <SessionManager />}
```

- [ ] **Step 5: Run the app and verify the tab end-to-end**

Run: `cd client && npm run dev`
Expected behavior to confirm manually:
- A third tab "💬 会话管理" appears next to 应用列表 / 场景路由.
- Clicking it lists sessions from Claude Code / Codex / Cursor with agent badges, project, context, calls/tokens, time.
- Search filters; agent chips filter; ★ toggles favorite and persists after a tab switch; ✎ saves tags/note; archive hides the row (and "显示归档" brings it back).
- ⤓ → "导出 JSON 包" / "导出 Markdown" writes a file under `~/.tokenbank/session-packs/` and shows the green notice; "复制 Markdown" copies to clipboard.
- ▸ opens the existing Session Trace modal for that row.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Gateway.jsx
git commit -m "feat(sessions): session manager tab + components in Gateway"
```

---

## Self-Review Notes

- **Spec coverage:** tab placement (Task 7), cross-agent aggregation (Task 3), overlay table favorite/tags/note/archive (Task 2), JSON + Markdown export (Tasks 1/4), trace reuse (Task 7), desktop-only empty state (Task 7), i18n (Task 6). All spec sections mapped.
- **Type consistency:** row keys (`agent_id`, `session_id`, `project`, `context`, `calls`, `tokens`, `lastTs`, `favorite`, `tags[]`, `note`, `archived`) are produced in Tasks 1/3 and consumed unchanged in Task 7. Export `format` values: `'json' | 'markdown' | 'copy'`, all three handled by `exportSession` (Task 4); `copy` returns Markdown `content` without writing a file, and React copies it to the clipboard.
- **No automated React/DB tests** by design — pure logic is unit-tested; UI/DB verified by running the app per the project's conventions (no JS test harness exists).

# 豆包只读会话源纳管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把豆包接入 TokenBank 为一个独立的只读会话源 app——后台解本地 Cookie 调 web 私有 API 拉会话，落盘供画像挖掘，不导用量、不投射、不 MCP、不 Skill。

**Architecture:** 仿 Trae Work「export→trace」范式，但采集端从「读本地日志」换成「解 Cookie 调云端 REST」。新增 4 个 JS 模块（cookies 解密、API 解析、后台同步、trace 适配器）+ 2 处接线（trace registry、telemetry sync）+ 2 段 YAML 声明（session-scans 检测项、app-handlers 独立 app）。能力关键字用 `session_trace`（非 `session_import`）以精确排除用量导入。

**Tech Stack:** Node.js（Electron 主进程）、内建 `crypto`、`better-sqlite3`（已在 client/package.json，`^12.10.0`）、`child_process`（调 `security` 取钥匙串密钥）、`node:test` + `node:assert`（测试）。

## Global Constraints

- **能力集刻意最小**：handler `capabilities: [session_trace]`。**禁止** `session_import`（会连带打开 `session_usage_import` 导用量）、`gateway_proxy`、`resource_project`。
- **不依赖 Python / pycryptodome**：Cookie 解密全用 Node 内建 `crypto`。
- **两份镜像必须同步**：`client/electron/config/*.yaml` 与 `server/static/defaults/*.yaml` 每次改动同时改。
- **落盘截断**：单条消息文本 `>300` 字截断（含 AI 回复）。落盘目录 `~/.tokenbank/doubao-sessions/`。
- **只读**：仅对 `www.doubao.com` 用户已登录会话做只读 GET/POST 拉取，无任何对外发送。
- **失败静默**：豆包未安装/未登录/取密钥被拒/Cookie 失效 → 记 reason 并 no-op，不抛异常、不刷错误日志。
- **测试运行**：工作目录 `client/`，单文件 `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/<file>.test.js`；全量用 `npm test`。
- **API 常量**（已实测）：
  - 网关 query：`aid=497858&device_platform=web&language=zh&samantha_web=1&version_code=20800`
  - `POST https://www.doubao.com/alice/conversation/list` body `{index,batch_size,conversation_types:[]}` → `data.conversation_list[]`（每项 `conversation_id`/`name`/`bot_id`/`message_index`/`update_time`）
  - `POST https://www.doubao.com/alice/message/index_list` body `{conversation_id,message_index_list:[...],is_reverse:false}` → `data.message_list[]`（每项 `index`/`user_type`(1=用户,2=豆包)/`content_type`(1=纯文本,9999=块)/`content`）
  - 请求头需带 `Cookie`、`Origin: https://www.doubao.com`、`Referer: https://www.doubao.com/chat/`、`Content-Type: application/json`。
  - Cookie 解密（macOS）：钥匙串 `security find-generic-password -w -s "Doubao Safe Storage"` 取密码 → `PBKDF2-SHA1(pw,'saltysalt',1003,16)` → `AES-128-CBC`（IV=16 个空格 `0x20`）→ 去 PKCS7 填充 → 跳过前 32 字节（SHA256 域前缀）。Cookies 库路径 `~/Library/Application Support/Doubao/Default/Cookies`。

---

## File Structure

- `client/electron/doubao-cookies.js` — Cookie 库读取 + Chromium v10 解密（纯函数可测）。
- `client/electron/doubao-api.js` — API 响应解析：会话清单、消息文本抽取、角色映射、300 字截断（纯函数，网络无关）。
- `client/electron/doubao-session-sync.js` — 后台同步编排：解 Cookie → 调 API → 增量落盘 `sessions.jsonl` + `sync-state.json`（依赖注入，可 mock）。
- `client/electron/session-trace/doubao-trace.js` — trace 适配器：读 `sessions.jsonl` → `{steps:[{kind,text,ts}]}`。
- `client/electron/session-trace/registry.js` — 注册 `doubao-trace` profile（改）。
- `client/electron/session-telemetry-sync.js` — 调 `syncDoubaoSessions()`（改）。
- `client/electron/config/session-scans.yaml` + `server/static/defaults/session-scans.yaml` — 加 `doubao` 检测项（改）。
- `client/electron/config/app-handlers.yaml` + `server/static/defaults/app-handlers.yaml` — 加 `doubao-stats` 独立 app（改）。
- 测试：`client/electron/__tests__/doubao-cookies.test.js`、`doubao-api.test.js`、`doubao-session-sync.test.js`、`doubao-trace.test.js`、`doubao-entity-caps.test.js`。

---

## Task 1: Cookie 解密模块 `doubao-cookies.js`

**Files:**
- Create: `client/electron/doubao-cookies.js`
- Test: `client/electron/__tests__/doubao-cookies.test.js`

**Interfaces:**
- Produces:
  - `deriveKey(password: string|Buffer) → Buffer`（PBKDF2-SHA1，1003 轮，16 字节）
  - `decryptChromiumValue(enc: Buffer, key: Buffer) → string|null`（v10/v11 解密，跳 32 字节前缀；非 v10/v11 或失败返回 null）
  - `doubaoCookiesPath() → string`
  - `loadDoubaoCookies(opts?: { cookiesPath?: string, keyFetch?: () => Buffer|null }) → { jar: Record<string,string>|null, reason: string }`（reason ∈ `'ok'|'not_installed'|'no_key'|'read_error'`；只保留 latin-1 可编码的值）

- [ ] **Step 1: 写失败测试**（固定密钥+密文向量，验证 PBKDF2 与解密逻辑，不碰真钥匙串）

创建 `client/electron/__tests__/doubao-cookies.test.js`：

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { deriveKey, decryptChromiumValue } = require('../doubao-cookies');

// 用同一套算法自造一条 v10 密文，确保 decrypt 能还原
function makeV10(plain, key) {
  const iv = Buffer.alloc(16, 0x20);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  const prefix = Buffer.alloc(32, 7); // 模拟 32 字节 SHA256 域前缀
  const body = Buffer.concat([c.update(Buffer.concat([prefix, Buffer.from(plain, 'utf8')])), c.final()]);
  return Buffer.concat([Buffer.from('v10'), body]);
}

test('deriveKey 出 16 字节', () => {
  const k = deriveKey('secret');
  assert.equal(k.length, 16);
});

test('decryptChromiumValue 还原 v10 明文并跳过 32 字节前缀', () => {
  const key = deriveKey('secret');
  const enc = makeV10('sessionid-abc123', key);
  assert.equal(decryptChromiumValue(enc, key), 'sessionid-abc123');
});

test('decryptChromiumValue 对非 v10 返回 null', () => {
  const key = deriveKey('secret');
  assert.equal(decryptChromiumValue(Buffer.from('plainvalue'), key), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-cookies.test.js`
Expected: FAIL — `Cannot find module '../doubao-cookies'`

- [ ] **Step 3: 写实现**

创建 `client/electron/doubao-cookies.js`：

```javascript
// doubao-cookies.js — 豆包桌面版 Cookie 读取 + Chromium v10 解密（macOS）
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const IV = Buffer.alloc(16, 0x20);           // 16 个空格
const SALT = 'saltysalt';
const PREFIX_LEN = 32;                        // Chromium >=v10 的 SHA256 域前缀

function deriveKey(password) {
  const pw = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
  return crypto.pbkdf2Sync(pw, SALT, 1003, 16, 'sha1');
}

function decryptChromiumValue(enc, key) {
  if (!Buffer.isBuffer(enc) || enc.length < 3) return null;
  const tag = enc.slice(0, 3).toString('latin1');
  if (tag !== 'v10' && tag !== 'v11') return null;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, IV);
    d.setAutoPadding(false);
    let out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
    const pad = out[out.length - 1];          // 去 PKCS7 填充
    if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
    if (out.length > PREFIX_LEN) out = out.slice(PREFIX_LEN);
    return out.toString('utf8');
  } catch {
    return null;
  }
}

function doubaoCookiesPath() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Doubao', 'Default', 'Cookies');
}

function keychainKey() {
  try {
    const pw = execFileSync('security', ['find-generic-password', '-w', '-s', 'Doubao Safe Storage'], {
      encoding: 'utf8',
    }).trim();
    return pw ? deriveKey(pw) : null;
  } catch {
    return null;
  }
}

function latin1Safe(v) {
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) > 255) return false;
  return true;
}

function loadDoubaoCookies(opts = {}) {
  const cookiesPath = opts.cookiesPath || doubaoCookiesPath();
  if (!fs.existsSync(cookiesPath)) return { jar: null, reason: 'not_installed' };
  const key = (opts.keyFetch || keychainKey)();
  if (!key) return { jar: null, reason: 'no_key' };

  const tmp = path.join(os.tmpdir(), `db-ck-${process.pid}-${Date.now()}`);
  let db;
  try {
    fs.copyFileSync(cookiesPath, tmp);           // 拷贝避免锁
    const Database = require('better-sqlite3');
    db = new Database(tmp, { readonly: true });
    const rows = db.prepare(
      "select name, encrypted_value from cookies where host_key like '%doubao.com'"
    ).all();
    const jar = {};
    for (const r of rows) {
      const val = decryptChromiumValue(r.encrypted_value, key);
      if (val != null && latin1Safe(val)) jar[r.name] = val;
    }
    return { jar, reason: 'ok' };
  } catch {
    return { jar: null, reason: 'read_error' };
  } finally {
    try { if (db) db.close(); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = {
  deriveKey,
  decryptChromiumValue,
  doubaoCookiesPath,
  loadDoubaoCookies,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-cookies.test.js`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add client/electron/doubao-cookies.js client/electron/__tests__/doubao-cookies.test.js
git commit -m "feat(doubao): Cookie 库读取 + Chromium v10 解密（Node crypto）"
```

---

## Task 2: API 响应解析 `doubao-api.js`

**Files:**
- Create: `client/electron/doubao-api.js`
- Test: `client/electron/__tests__/doubao-api.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `GATEWAY_QS: string`（网关 query 串，不含前导 `?`）
  - `TEXT_CLIP = 300`
  - `clip(text: string, max=TEXT_CLIP) → string`
  - `messageRole(userType: number) → 'user'|'assistant'`
  - `extractMessageText(msg: object) → string`（`content_type===1` 取 `JSON.parse(content).text`；块类型取首个含 `text` 的 block）
  - `parseConversations(data: object) → Array<{conversation_id, title, message_index, update_time}>`
  - `messageToRow(conversationId: string, title: string, msg: object) → {conversation_id,title,index,ts,role,text}`

- [ ] **Step 1: 写失败测试**

创建 `client/electron/__tests__/doubao-api.test.js`：

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  clip, messageRole, extractMessageText, parseConversations, messageToRow,
} = require('../doubao-api');

test('clip 截断到 300 字', () => {
  const long = 'x'.repeat(500);
  assert.equal(clip(long).length, 300);
  assert.equal(clip('short'), 'short');
});

test('messageRole 映射 user_type', () => {
  assert.equal(messageRole(1), 'user');
  assert.equal(messageRole(2), 'assistant');
});

test('extractMessageText 处理纯文本 content_type=1', () => {
  const msg = { content_type: 1, content: JSON.stringify({ text: '你好豆包' }) };
  assert.equal(extractMessageText(msg), '你好豆包');
});

test('extractMessageText 处理块类型取首个 text', () => {
  const blocks = [{ block_type: 10000, content: JSON.stringify({ text: '# 标题\n正文' }) }];
  const msg = { content_type: 9999, content: JSON.stringify(blocks) };
  assert.equal(extractMessageText(msg), '# 标题\n正文');
});

test('parseConversations 取会话元数据', () => {
  const data = { conversation_list: [
    { conversation_id: '111', name: '会话A', message_index: 12, update_time: 1776664759 },
  ] };
  const out = parseConversations(data);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { conversation_id: '111', title: '会话A', message_index: 12, update_time: 1776664759 });
});

test('messageToRow 组行 + 截断 + 角色', () => {
  const msg = { index: 5, user_type: 2, content_type: 1, content: JSON.stringify({ text: 'y'.repeat(400) }), create_time: 1776664759 };
  const row = messageToRow('111', '会话A', msg);
  assert.equal(row.conversation_id, '111');
  assert.equal(row.title, '会话A');
  assert.equal(row.index, 5);
  assert.equal(row.role, 'assistant');
  assert.equal(row.text.length, 300);
  assert.equal(row.ts, 1776664759);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-api.test.js`
Expected: FAIL — `Cannot find module '../doubao-api'`

- [ ] **Step 3: 写实现**

创建 `client/electron/doubao-api.js`：

```javascript
// doubao-api.js — 豆包 web 私有 API 响应解析（纯函数，网络无关）
'use strict';

const GATEWAY_QS = 'aid=497858&device_platform=web&language=zh&samantha_web=1&version_code=20800';
const TEXT_CLIP = 300;

function clip(text, max = TEXT_CLIP) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) : s;
}

function messageRole(userType) {
  return Number(userType) === 1 ? 'user' : 'assistant';
}

function extractMessageText(msg) {
  if (!msg || msg.content == null) return '';
  const raw = msg.content;
  if (Number(msg.content_type) === 1) {
    try { return String(JSON.parse(raw).text || ''); } catch { return ''; }
  }
  // 块类型：content 是 block 数组，取首个能解出 text 的 block
  let blocks;
  try { blocks = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }
  if (!Array.isArray(blocks)) return '';
  for (const b of blocks) {
    const inner = b && b.content;
    if (typeof inner === 'string') {
      try { const t = JSON.parse(inner).text; if (t) return String(t); } catch {}
    }
  }
  return '';
}

function parseConversations(data) {
  const list = (data && data.conversation_list) || [];
  const out = [];
  for (const c of list) {
    if (!c || !c.conversation_id) continue;
    out.push({
      conversation_id: String(c.conversation_id),
      title: String(c.name || ''),
      message_index: Number(c.message_index || 0) || 0,
      update_time: Number(c.update_time || 0) || 0,
    });
  }
  return out;
}

function messageToRow(conversationId, title, msg) {
  return {
    conversation_id: String(conversationId),
    title: String(title || ''),
    index: Number(msg.index || 0) || 0,
    ts: Number(msg.create_time || msg.create_time_ms || 0) || 0,
    role: messageRole(msg.user_type),
    text: clip(extractMessageText(msg)),
  };
}

module.exports = {
  GATEWAY_QS,
  TEXT_CLIP,
  clip,
  messageRole,
  extractMessageText,
  parseConversations,
  messageToRow,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-api.test.js`
Expected: PASS（6 个测试）

- [ ] **Step 5: 提交**

```bash
git add client/electron/doubao-api.js client/electron/__tests__/doubao-api.test.js
git commit -m "feat(doubao): web API 响应解析（会话清单/消息文本/角色/截断）"
```

---

## Task 3: 后台同步编排 `doubao-session-sync.js`

**Files:**
- Create: `client/electron/doubao-session-sync.js`
- Test: `client/electron/__tests__/doubao-session-sync.test.js`

**Interfaces:**
- Consumes: `doubao-api.js` 的 `GATEWAY_QS`/`parseConversations`/`messageToRow`；`doubao-cookies.js` 的 `loadDoubaoCookies`（默认依赖，测试时注入替身）。
- Produces:
  - `EXPORT_DIR: string`（`~/.tokenbank/doubao-sessions`）、`EXPORT_FILE='sessions.jsonl'`、`STATE_FILE='sync-state.json'`
  - `pendingIndexBatches(lastIndex: number, currentIndex: number, batch=20) → number[][]`（纯函数：`(lastIndex, currentIndex]` 分批）
  - `syncDoubaoSessions(opts?: { force?: boolean, deps?: {...}, exportDir?: string }) → { synced: number, reason: string }`
    - `deps.loadCookies() → { jar, reason }`
    - `deps.httpPostJson(path: string, body: object, cookieHeader: string) → object`（返回 API JSON；抛错代表网络失败）
    - `deps.now() → number`（毫秒时间戳，节流用）

- [ ] **Step 1: 写失败测试**（mock cookies + httpPostJson，断言落盘、增量、截断、失败 no-op）

创建 `client/electron/__tests__/doubao-session-sync.test.js`：

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pendingIndexBatches, syncDoubaoSessions } = require('../doubao-session-sync');

function tmpDir() {
  const d = path.join(os.tmpdir(), `db-sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('pendingIndexBatches 切 (last, current] 分批', () => {
  assert.deepEqual(pendingIndexBatches(0, 5, 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(pendingIndexBatches(5, 5, 20), []);
  assert.deepEqual(pendingIndexBatches(10, 3, 20), []); // current < last 视为无新增
});

function makeDeps({ jar = { sessionid: 's' }, cookieReason = 'ok', convs, messagesByCid }) {
  return {
    loadCookies: () => ({ jar, reason: cookieReason }),
    now: () => 1_000_000,
    httpPostJson: (p, body) => {
      if (p.startsWith('/alice/conversation/list')) {
        return { code: 0, data: { conversation_list: convs, has_more: false } };
      }
      if (p.startsWith('/alice/message/index_list')) {
        const idxs = body.message_index_list;
        const all = messagesByCid[body.conversation_id] || [];
        return { code: 0, data: { message_list: all.filter(m => idxs.includes(m.index)) } };
      }
      throw new Error('unexpected path ' + p);
    },
  };
}

test('首次全量落盘 sessions.jsonl + sync-state.json', () => {
  const dir = tmpDir();
  const deps = makeDeps({
    convs: [{ conversation_id: '111', name: '会话A', message_index: 2, update_time: 100 }],
    messagesByCid: {
      '111': [
        { index: 1, user_type: 1, content_type: 1, content: JSON.stringify({ text: '问题' }), create_time: 100 },
        { index: 2, user_type: 2, content_type: 1, content: JSON.stringify({ text: '回答' }), create_time: 101 },
      ],
    },
  });
  const res = syncDoubaoSessions({ force: true, exportDir: dir, deps });
  assert.equal(res.reason, 'ok');
  assert.equal(res.synced, 2);
  const lines = fs.readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].role, 'user');
  assert.equal(lines[0].text, '问题');
  assert.equal(lines[1].role, 'assistant');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf8'));
  assert.equal(state['111'], 2);
});

test('增量：已同步到 2，只拉新段 3', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'sync-state.json'), JSON.stringify({ '111': 2 }));
  const deps = makeDeps({
    convs: [{ conversation_id: '111', name: '会话A', message_index: 3, update_time: 200 }],
    messagesByCid: { '111': [
      { index: 3, user_type: 1, content_type: 1, content: JSON.stringify({ text: '追问' }), create_time: 200 },
    ] },
  });
  const res = syncDoubaoSessions({ force: true, exportDir: dir, deps });
  assert.equal(res.synced, 1);
  const lines = fs.readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].index, 3);
});

test('无 Cookie 时 no-op', () => {
  const dir = tmpDir();
  const deps = makeDeps({ jar: null, cookieReason: 'not_installed' });
  const res = syncDoubaoSessions({ force: true, exportDir: dir, deps });
  assert.equal(res.synced, 0);
  assert.equal(res.reason, 'not_installed');
  assert.equal(fs.existsSync(path.join(dir, 'sessions.jsonl')), false);
});

test('API 鉴权失败码 → 标记 auth_expired', () => {
  const dir = tmpDir();
  const deps = makeDeps({ convs: [], messagesByCid: {} });
  deps.httpPostJson = () => ({ code: 710012014, message: 'not login' });
  const res = syncDoubaoSessions({ force: true, exportDir: dir, deps });
  assert.equal(res.reason, 'auth_expired');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-session-sync.test.js`
Expected: FAIL — `Cannot find module '../doubao-session-sync'`

- [ ] **Step 3: 写实现**

创建 `client/electron/doubao-session-sync.js`：

```javascript
// doubao-session-sync.js — 后台解 Cookie 调豆包 web API，增量落盘会话（供画像 trace）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { GATEWAY_QS, parseConversations, messageToRow } = require('./doubao-api');
const { loadDoubaoCookies } = require('./doubao-cookies');

const EXPORT_DIR = path.join(os.homedir(), '.tokenbank', 'doubao-sessions');
const EXPORT_FILE = 'sessions.jsonl';
const STATE_FILE = 'sync-state.json';
const INDEX_BATCH = 20;
const THROTTLE_MS = 10 * 60 * 1000;          // 非 force 最小同步间隔
const MAX_MSG_PER_RUN = 400;                 // 单会话单轮最多补录条数（超大会话分轮）

let _lastRunAt = 0;

function pendingIndexBatches(lastIndex, currentIndex, batch = INDEX_BATCH) {
  const out = [];
  if (!(currentIndex > lastIndex)) return out;
  let cur = [];
  for (let i = lastIndex + 1; i <= currentIndex; i++) {
    cur.push(i);
    if (cur.length >= batch) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

function readState(exportDir) {
  try { return JSON.parse(fs.readFileSync(path.join(exportDir, STATE_FILE), 'utf8')) || {}; }
  catch { return {}; }
}

function writeState(exportDir, state) {
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(path.join(exportDir, STATE_FILE), JSON.stringify(state));
}

function appendRows(exportDir, rows) {
  if (!rows.length) return;
  fs.mkdirSync(exportDir, { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(path.join(exportDir, EXPORT_FILE), text);
}

// 默认真实 HTTP：POST JSON 到 www.doubao.com，带 Cookie，gzip 解压
function httpPostJson(p, body, cookieHeader) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'www.doubao.com',
      path: p,
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        Cookie: cookieHeader,
        Origin: 'https://www.doubao.com',
        Referer: 'https://www.doubao.com/chat/',
        'Accept-Encoding': 'gzip',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try { if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf); } catch {}
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

function isAuthError(resp) {
  const code = Number(resp && resp.code);
  return code !== 0 && code >= 700000000;      // 豆包鉴权/业务错误码段
}

async function syncDoubaoSessions(opts = {}) {
  const exportDir = opts.exportDir || EXPORT_DIR;
  const deps = opts.deps || {};
  const loadCookies = deps.loadCookies || loadDoubaoCookies;
  const post = deps.httpPostJson || httpPostJson;
  const now = deps.now || Date.now;

  if (!opts.force && now() - _lastRunAt < THROTTLE_MS) return { synced: 0, reason: 'throttled' };
  _lastRunAt = now();

  const { jar, reason } = loadCookies();
  if (!jar) return { synced: 0, reason };       // not_installed / no_key / read_error
  const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  const qs = (p) => `${p}?${GATEWAY_QS}`;

  // 1) 拉会话清单（分页）
  const convs = [];
  let index = 0;
  for (let page = 0; page < 20; page++) {
    let resp;
    try { resp = await post(qs('/alice/conversation/list'), { index, batch_size: 50, conversation_types: [] }, cookieHeader); }
    catch { return { synced: 0, reason: 'network_error' }; }
    if (isAuthError(resp)) return { synced: 0, reason: 'auth_expired' };
    const page_convs = parseConversations(resp.data || {});
    convs.push(...page_convs);
    if (!page_convs.length || !(resp.data && resp.data.has_more)) break;
    index += page_convs.length;
  }

  // 2) 逐会话增量拉消息
  const state = readState(exportDir);
  let synced = 0;
  for (const c of convs) {
    const last = Number(state[c.conversation_id] || 0);
    let batches = pendingIndexBatches(last, c.message_index);
    if (!batches.length) continue;
    // 单轮上限：超大会话分轮，取靠后的段优先补齐到当前
    const flat = batches.flat();
    const capped = flat.slice(Math.max(0, flat.length - MAX_MSG_PER_RUN));
    batches = pendingIndexBatches(capped[0] - 1, capped[capped.length - 1]);

    let maxDone = last;
    for (const idxs of batches) {
      let resp;
      try { resp = await post(qs('/alice/message/index_list'), { conversation_id: c.conversation_id, message_index_list: idxs, is_reverse: false }, cookieHeader); }
      catch { return { synced, reason: 'network_error' }; }
      if (isAuthError(resp)) return { synced, reason: 'auth_expired' };
      const msgs = (resp.data && resp.data.message_list) || [];
      const rows = msgs.map((m) => messageToRow(c.conversation_id, c.title, m));
      appendRows(exportDir, rows);
      synced += rows.length;
      for (const m of msgs) maxDone = Math.max(maxDone, Number(m.index || 0));
    }
    state[c.conversation_id] = Math.max(last, maxDone);
    writeState(exportDir, state);
  }

  return { synced, reason: 'ok' };
}

module.exports = {
  EXPORT_DIR,
  EXPORT_FILE,
  STATE_FILE,
  pendingIndexBatches,
  syncDoubaoSessions,
};
```

> 注：`syncDoubaoSessions` 是 async；测试用例里 `await` 或直接读返回（`node:test` 支持 async）。若测试同步断言，需把测试函数改为 `async` 并 `await syncDoubaoSessions(...)`。**实现完成后，把 Task 3 测试里的调用改为 `const res = await syncDoubaoSessions(...)` 并给测试函数加 `async`。**

- [ ] **Step 4: 调整测试为 async 并运行确认通过**

将 `doubao-session-sync.test.js` 中 4 个调用 `syncDoubaoSessions` 的测试函数签名改为 `async (…)` 且 `const res = await syncDoubaoSessions(...)`（`pendingIndexBatches` 那条纯同步不变）。

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-session-sync.test.js`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add client/electron/doubao-session-sync.js client/electron/__tests__/doubao-session-sync.test.js
git commit -m "feat(doubao): 后台增量同步（解 Cookie 调 API 落盘 + sync-state + 节流/失败处理）"
```

---

## Task 4: trace 适配器 `session-trace/doubao-trace.js`

**Files:**
- Create: `client/electron/session-trace/doubao-trace.js`
- Test: `client/electron/__tests__/doubao-trace.test.js`

**Interfaces:**
- Consumes: `./shared` 的 `extractContext`/`clipTraceText`/`buildTraceStats`；`doubao-session-sync.js` 的 `EXPORT_DIR`/`EXPORT_FILE`。
- Produces（对齐 registry 适配器契约，见 `kimi-code-trace.js`）：
  - `agentId = 'doubao'`、`profile = 'doubao-trace'`
  - `buildStepsFromRows(rows: Array) → Array<{idx, kind:'user'|'assistant', text, ts}>`（按 index 排序）
  - `list(opts?: {limit?, sinceDays?}) → Array<{session_id, project, context, calls, tokens, lastTs, agent}>`
  - `trace(sessionId: string) → {session_id, agent, project, steps, stats}|{error, steps:[]}`

- [ ] **Step 1: 写失败测试**（用行数组直接验证 steps 划分，不碰真实文件）

创建 `client/electron/__tests__/doubao-trace.test.js`：

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildStepsFromRows } = require('../session-trace/doubao-trace');

test('buildStepsFromRows 按 index 排序并分 user/assistant', () => {
  const rows = [
    { conversation_id: '111', title: 'A', index: 2, ts: 101, role: 'assistant', text: '回答' },
    { conversation_id: '111', title: 'A', index: 1, ts: 100, role: 'user', text: '问题' },
  ];
  const steps = buildStepsFromRows(rows);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, 'user');
  assert.equal(steps[0].text, '问题');
  assert.equal(steps[1].kind, 'assistant');
  assert.equal(steps[1].text, '回答');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-trace.test.js`
Expected: FAIL — `Cannot find module '../session-trace/doubao-trace'`

- [ ] **Step 3: 写实现**

创建 `client/electron/session-trace/doubao-trace.js`：

```javascript
// session-trace/doubao-trace.js — 豆包 sessions.jsonl 适配器（trace-only，无用量）
'use strict';

const fs = require('fs');
const path = require('path');
const { extractContext, clipTraceText, buildTraceStats } = require('./shared');
const { EXPORT_DIR, EXPORT_FILE } = require('../doubao-session-sync');

const AGENT_ID = 'doubao';
const PROFILE = 'doubao-trace';

function exportFile() {
  return path.join(EXPORT_DIR, EXPORT_FILE);
}

/** 读全部行 → 按 conversation_id 分组 */
function readGrouped() {
  const groups = new Map();
  let text;
  try { text = fs.readFileSync(exportFile(), 'utf8'); } catch { return groups; }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch { continue; }
    const cid = r.conversation_id;
    if (!cid) continue;
    if (!groups.has(cid)) groups.set(cid, { title: r.title || '', rows: [] });
    groups.get(cid).rows.push(r);
  }
  return groups;
}

function buildStepsFromRows(rows) {
  const sorted = [...rows].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  return sorted.map((r, i) => ({
    idx: i,
    kind: r.role === 'user' ? 'user' : 'assistant',
    label: r.role === 'user' ? 'User' : '豆包',
    ts: Number(r.ts || 0) * (Number(r.ts || 0) < 1e12 ? 1000 : 1),
    text: clipTraceText(String(r.text || '')),
  }));
}

function list({ limit = 50, sinceDays = 30 } = {}) {
  const sinceMs = Date.now() - (sinceDays || 30) * 86400 * 1000;
  const out = [];
  for (const [cid, g] of readGrouped()) {
    const steps = buildStepsFromRows(g.rows);
    if (!steps.length) continue;
    const lastTs = steps.reduce((m, s) => Math.max(m, s.ts || 0), 0);
    if (lastTs && lastTs < sinceMs) continue;
    const firstUser = steps.find((s) => s.kind === 'user');
    out.push({
      session_id: cid,
      project: g.title || '豆包',
      project_path: '豆包',
      context: extractContext(firstUser ? firstUser.text : (g.title || '(无用户消息)')),
      calls: steps.filter((s) => s.kind === 'assistant').length,
      tokens: 0,
      inTok: 0,
      outTok: 0,
      lastTs: Math.floor((lastTs || 0) / 1000),
      agent: AGENT_ID,
    });
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

function trace(sessionId) {
  const g = readGrouped().get(String(sessionId));
  if (!g) return { error: 'not_found', steps: [], meta: {} };
  const steps = buildStepsFromRows(g.rows);
  const stats = buildTraceStats(steps, { filePath: exportFile(), rawLines: [] });
  return {
    session_id: String(sessionId),
    agent: AGENT_ID,
    project: g.title || '豆包',
    project_path: '豆包',
    steps,
    stats,
  };
}

module.exports = {
  agentId: AGENT_ID,
  profile: PROFILE,
  list,
  trace,
  buildStepsFromRows,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-trace.test.js`
Expected: PASS（1 个测试）

- [ ] **Step 5: 提交**

```bash
git add client/electron/session-trace/doubao-trace.js client/electron/__tests__/doubao-trace.test.js
git commit -m "feat(doubao): trace 适配器（sessions.jsonl → steps，trace-only 无用量）"
```

---

## Task 5: 注册 trace profile（registry.js）

**Files:**
- Modify: `client/electron/session-trace/registry.js`（顶部 require + `PROFILE_ADAPTERS` + `AGENT_ID_TO_PROFILE`）

**Interfaces:**
- Consumes: `doubao-trace.js` 的 `{ profile:'doubao-trace', agentId:'doubao' }`

- [ ] **Step 1: 加 require**（在 `const kimiCodeTrace = require('./kimi-code-trace');` 后一行）

```javascript
const doubaoTrace = require('./doubao-trace');
```

- [ ] **Step 2: 注册进 `PROFILE_ADAPTERS`**（在 `[kimiCodeTrace.profile]: kimiCodeTrace,` 后一行）

```javascript
  [doubaoTrace.profile]: doubaoTrace,
```

- [ ] **Step 3: 注册进 `AGENT_ID_TO_PROFILE`**（在 `[kimiCodeTrace.agentId]: kimiCodeTrace.profile,` 后一行）

```javascript
  [doubaoTrace.agentId]: doubaoTrace.profile,
```

- [ ] **Step 4: 运行既有 trace 测试确认无回归**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/session-trace.test.js electron/__tests__/doubao-trace.test.js`
Expected: PASS（无报错，doubao profile 可被 registry 解析）

- [ ] **Step 5: 提交**

```bash
git add client/electron/session-trace/registry.js
git commit -m "feat(doubao): 注册 doubao-trace profile 到 trace registry"
```

---

## Task 6: 接线后台同步（session-telemetry-sync.js）

**Files:**
- Modify: `client/electron/session-telemetry-sync.js`（require + 在 `syncTraeSessions()` 调用处旁加 `syncDoubaoSessions()`）

**Interfaces:**
- Consumes: `doubao-session-sync.js` 的 `syncDoubaoSessions`

- [ ] **Step 1: 加 require**（在 `const { syncTraeSessions } = require('./trae-session-sync');` 后一行）

```javascript
const { syncDoubaoSessions } = require('./doubao-session-sync');
```

- [ ] **Step 2: 在 trae 同步旁触发豆包同步**

定位 `session-telemetry-sync.js:50` 附近的：

```javascript
    try { traeSynced = syncTraeSessions(); } catch (e) { console.error('[trae-session-sync]', e.message); }
```

在其**后**新增。当前函数 `syncSessionTelemetry(localStats, opts = {})` 在第 37 行已有 `const force = !!(opts && opts.force);`，直接复用这个 `force` 局部变量；豆包 sync 是 async，用 `.catch` 吞错不阻塞主流程：

```javascript
    try {
      Promise.resolve(syncDoubaoSessions({ force }))
        .then((r) => { if (r && r.reason && r.reason !== 'ok' && r.reason !== 'throttled') console.log('[doubao-sync]', r.reason); })
        .catch((e) => console.error('[doubao-sync]', e.message));
    } catch (e) { console.error('[doubao-sync]', e.message); }
```

- [ ] **Step 3: 冒烟验证模块可加载**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 node -e "require('./electron/session-telemetry-sync'); console.log('loaded ok')"`
Expected: 输出 `loaded ok`（无 require 报错）

- [ ] **Step 4: 提交**

```bash
git add client/electron/session-telemetry-sync.js
git commit -m "feat(doubao): 后台同步接入 session-telemetry pass（旁挂 trae 同步）"
```

---

## Task 7: 独立 app 声明 + 检测项（YAML 两份镜像 + 能力测试）

**Files:**
- Modify: `client/electron/config/session-scans.yaml` + `server/static/defaults/session-scans.yaml`（加 `doubao` 检测项）
- Modify: `client/electron/config/app-handlers.yaml` + `server/static/defaults/app-handlers.yaml`（加 `doubao-stats`）
- Test: `client/electron/__tests__/doubao-entity-caps.test.js`

**Interfaces:**
- Consumes: `app-handlers.js` 的 `expandEntity`

- [ ] **Step 1: 写能力失败测试**（断言只 trace、无用量/网关/投射）

创建 `client/electron/__tests__/doubao-entity-caps.test.js`：

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { expandEntity } = require('../app-handlers');

test('doubao-stats 展开为 trace-only 实体', () => {
  const e = expandEntity({ id: 'doubao', handler: 'doubao-stats', vars: {} });
  assert.equal(e.session_trace, true, 'session_trace 应为 true');
  assert.equal(e.session_usage_import, false, 'session_usage_import 应为 false');
  assert.equal(e.gateway_proxy, false, 'gateway_proxy 应为 false');
  assert.equal(e.resource_project, false, 'resource_project 应为 false');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-entity-caps.test.js`
Expected: FAIL — `未知 handler: doubao-stats`

- [ ] **Step 3: 加 `doubao-stats` handler**（`client/electron/config/app-handlers.yaml`，紧接 `trae-work-stats:` 段之后，缩进对齐同级 handler）

```yaml
  doubao-stats:
    label: 豆包
    label_zh: 豆包
    # 官方订阅账号；仅解本地 Cookie 拉会话供画像，不导用量、不代理、不投射
    default_icon: "🫘"
    default_name: 豆包
    capabilities: [session_trace]
    session:
      source_id: doubao
      standalone: true
      route_bindable: false
      activity_agent_id: doubao
      trace_agent_id: doubao
      trace:
        profile: doubao-trace
```

- [ ] **Step 4: 同步到 server 镜像**

把 Step 3 完全相同的 `doubao-stats:` 段加进 `server/static/defaults/app-handlers.yaml` 的对应位置（同为 `trae-work-stats` 之后）。

- [ ] **Step 5: 加 `doubao` 检测项**（`client/electron/config/session-scans.yaml`，`scans:` 下紧接 `trae-work:` 段之后。仅用于安装检测 + app 元数据，`session_usage_import: false` 保证 [session-import.js:237](../../client/electron/session-import.js#L237) 短路不导用量，`glob: ''` 不扫任何文件）

```yaml
  doubao:
    data_source: session-doubao
    agent_id: doubao
    billing_type: subscription
    direct_only: true
    session_usage_import: false   # 只作检测/元数据，绝不导用量
    app_name: 豆包
    app_icon: 🫘
    # 检测根：豆包桌面版已安装并登录的信号
    root: ~/Library/Application Support/Doubao
    glob: ''
    format: jsonl
```

- [ ] **Step 6: 同步到 server 镜像**

把 Step 5 完全相同的 `doubao:` 段加进 `server/static/defaults/session-scans.yaml` 对应位置（`trae-work` 之后）。

- [ ] **Step 7: 运行能力测试 + 全量测试确认通过**

Run: `cd client && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/__tests__/doubao-entity-caps.test.js`
Expected: PASS（4 个断言）

Run: `cd client && npm test`
Expected: 全量 PASS（无回归）

- [ ] **Step 8: 提交**

```bash
git add client/electron/config/session-scans.yaml server/static/defaults/session-scans.yaml \
        client/electron/config/app-handlers.yaml server/static/defaults/app-handlers.yaml \
        client/electron/__tests__/doubao-entity-caps.test.js
git commit -m "feat(doubao): 独立 app doubao-stats 声明 + 检测项（trace-only 两份镜像同步）"
```

---

## Self-Review 记录

- **Spec 覆盖**：① Cookie 解密→Task1；② API 解析→Task2；③ 后台同步/增量/失败→Task3；④ trace 适配器→Task4；⑤ registry 接线→Task5；⑥ telemetry 接线→Task6；⑦ 独立 app 声明 + capability `session_trace` + 检测→Task7。隐私（300 截断）在 Task2 `clip`/Task3 落盘；「不进用量」由 Task7 `session_trace` cap + `session_usage_import:false` 双保险。全部有任务对应。
- **占位符扫描**：无 TBD/TODO；每个代码步骤给出完整代码。
- **类型一致性**：`syncDoubaoSessions` async（Task3 备注已提示测试改 await）；`buildStepsFromRows`、`EXPORT_DIR/EXPORT_FILE`、`profile='doubao-trace'`/`agentId='doubao'` 在 Task3/4/5/7 间一致；`loadDoubaoCookies` 返回 `{jar,reason}` 在 Task1 定义、Task3 消费一致。
- **待实现期确认**：Task6 的 `opts.force` 取值按 `session-telemetry-sync` 实际函数签名微调（已在步骤内注明兜底 `false`）。

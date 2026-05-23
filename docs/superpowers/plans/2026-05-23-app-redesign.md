# App Redesign: Token 盘点 + 三板块重组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重组客户端架构，以本地网关为核心，用 Token 盘点替代积分为主视角，P2P 贡献网络降级为供给源之一。

**Architecture:** Electron 主进程新增 `local-gateway.js`（Node.js HTTP 服务监听 :11430），路由顺序：免费层 → P2P 层 → 付费层。路由日志和每日统计写入内存（统计持久化到 config.json）。React 渲染层新增四页：Token 盘点（新主页）、网关、供给源、贡献；删除旧 Agent.jsx。

**Tech Stack:** Electron 28, React 18, Tailwind CSS, Node.js built-in `http`/`https`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| **Create** | `client/electron/local-gateway.js` | HTTP :11430 server, routing, log, stats |
| **Modify** | `client/electron/main.js` | require gateway, add IPC handlers |
| **Modify** | `client/electron/preload.js` | expose `gateway` namespace |
| **Create** | `client/src/pages/TokenDashboard.jsx` | 新主页：用量盘点 + 积分 section |
| **Create** | `client/src/pages/Gateway.jsx` | 网关状态 + 路由日志 |
| **Create** | `client/src/pages/Providers.jsx` | 三层供给源管理 |
| **Create** | `client/src/pages/Contribute.jsx` | 贡献节点（从 Agent.jsx 拆出） |
| **Modify** | `client/src/components/Sidebar.jsx` | 新导航结构 |
| **Modify** | `client/src/App.jsx` | 新路由 |
| **Delete** | `client/src/pages/Agent.jsx` | 拆解后废弃 |

---

## Provider Config Schema（写入 config.json `providers` 字段）

```json
{
  "gateway": { "port": 11430, "strategy": "cost", "enabled": true },
  "providers": [
    { "id": "ollama",         "label": "Ollama（本地）",  "base_url": "http://127.0.0.1:11434/v1", "token": "", "enabled": true,  "type": "free" },
    { "id": "groq",           "label": "Groq",            "base_url": "https://api.groq.com/openai/v1",          "token": "", "enabled": false, "type": "free" },
    { "id": "github-models",  "label": "GitHub Models",   "base_url": "https://models.github.azure.com",         "token": "", "enabled": false, "type": "free" },
    { "id": "tokenbank-p2p",  "label": "P2P 分享网络",    "base_url": "",                                         "token": "", "enabled": true,  "type": "p2p"  },
    { "id": "openai",         "label": "OpenAI",          "base_url": "https://api.openai.com/v1",               "token": "", "enabled": false, "type": "paid" },
    { "id": "anthropic-paid", "label": "Anthropic",       "base_url": "https://api.anthropic.com/v1",            "token": "", "enabled": false, "type": "paid" }
  ]
}
```

---

## Task 1：local-gateway.js — HTTP 代理核心

**Files:**
- Create: `client/electron/local-gateway.js`

- [ ] **Step 1: 创建文件，写入完整实现**

```javascript
// client/electron/local-gateway.js
'use strict';

const http  = require('http');
const https = require('https');

// ── In-memory state ───────────────────────────────────────────────────────────

const LOG_MAX = 100;
const log = []; // circular, newest last

let _strategy  = 'cost';   // 'cost' | 'quality'
let _getConfig = null;     // () => config object (set at start)
let _server    = null;
let _port      = 11430;

// Daily stats reset when date changes
let _stats = newDayStats();

function newDayStats() {
  return {
    date: today(),
    calls: 0,
    errors: 0,
    by_provider: {},  // id → { calls, tokens }
    by_model:    {},  // name → { calls, tokens }
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ensureTodayStats() {
  if (_stats.date !== today()) _stats = newDayStats();
}

// ── Provider helpers ──────────────────────────────────────────────────────────

function orderedProviders() {
  const cfg = _getConfig ? _getConfig() : {};
  const providers = (cfg.providers || []).filter(p => p.enabled && p.base_url);
  const typeOrder = _strategy === 'cost'
    ? ['free', 'p2p', 'paid']
    : ['paid', 'p2p', 'free'];
  return typeOrder.flatMap(t => providers.filter(p => p.type === t));
}

// ── HTTP proxy ────────────────────────────────────────────────────────────────

function proxyRequest(provider, reqPath, body, res) {
  return new Promise((resolve, reject) => {
    const base     = (provider.base_url || '').replace(/\/$/, '');
    const fullUrl  = base + reqPath;
    let u;
    try { u = new URL(fullUrl); }
    catch { return reject(new Error('invalid_url')); }

    const mod      = u.protocol === 'https:' ? https : http;
    const bodyStr  = JSON.stringify(body);
    const headers  = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method:  'POST',
      headers,
      timeout: 120_000,
    };

    const t0 = Date.now();

    const proxyReq = mod.request(opts, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        proxyRes.resume();
        return reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode }));
      }
      res.writeHead(proxyRes.statusCode, {
        'Content-Type':          proxyRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control':         'no-cache',
        'X-Accel-Buffering':     'no',
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res);
      proxyRes.on('end',   () => resolve({ provider: provider.id, latency: Date.now() - t0 }));
      proxyRes.on('error', reject);
    });

    proxyReq.on('error',   reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

async function route(model, reqPath, body, res) {
  ensureTodayStats();
  const providers = orderedProviders();
  const t0 = Date.now();
  let lastErr = null;

  for (const provider of providers) {
    try {
      const result = await proxyRequest(provider, reqPath, body, res);
      // record success
      const entry = {
        ts: t0, model, via: provider.id, via_label: provider.label,
        latency_ms: result.latency, status: 'ok',
      };
      pushLog(entry);
      recordStats(provider.id, model);
      return;
    } catch (err) {
      lastErr = err;
      // try next provider
    }
  }

  // All providers failed
  pushLog({ ts: t0, model, via: null, latency_ms: Date.now() - t0, status: 'error', error: lastErr?.message });
  _stats.errors++;
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'all_providers_failed', detail: lastErr?.message }));
}

function pushLog(entry) {
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
}

function recordStats(providerId, model) {
  _stats.calls++;
  const ps = _stats.by_provider[providerId] || { calls: 0, tokens: 0 };
  ps.calls++;
  _stats.by_provider[providerId] = ps;

  if (model) {
    const ms = _stats.by_model[model] || { calls: 0, tokens: 0 };
    ms.calls++;
    _stats.by_model[model] = ms;
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, anthropic-version');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { method, url } = req;

  // Health
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: _port, strategy: _strategy }));
    return;
  }

  // Models list — return stub
  if (method === 'GET' && (url === '/v1/models' || url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }

  // Chat completions (OpenAI + Anthropic)
  const isChatPath   = url === '/v1/chat/completions' || url === '/v1/messages';
  if (!isChatPath || method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const model = body.model || '';
    try {
      await route(model, url, body, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(port, getConfig) {
  if (_server) return;
  _port      = port || 11430;
  _getConfig = getConfig;
  _server    = http.createServer(handleRequest);
  _server.listen(_port, '127.0.0.1', () => {
    console.log(`[gateway] listening on 127.0.0.1:${_port}`);
  });
  _server.on('error', (err) => {
    console.error('[gateway] server error:', err.message);
  });
}

function stop() {
  if (!_server) return;
  _server.close();
  _server = null;
}

function setStrategy(s) {
  if (s === 'cost' || s === 'quality') _strategy = s;
}

function getStatus() {
  return { running: !!_server, port: _port, strategy: _strategy };
}

function getLog() {
  return [...log].reverse(); // newest first
}

function getDailyStats() {
  ensureTodayStats();
  return { ..._stats };
}

module.exports = { start, stop, setStrategy, getStatus, getLog, getDailyStats };
```

- [ ] **Step 2: 手动验证语法**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
node -e "const g = require('./electron/local-gateway'); console.log(typeof g.start, typeof g.getStatus);"
```

Expected: `function function`

- [ ] **Step 3: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/electron/local-gateway.js
git commit -m "feat(gateway): add local HTTP proxy with cost/quality routing"
```

---

## Task 2：main.js + preload.js — IPC 集成

**Files:**
- Modify: `client/electron/main.js`
- Modify: `client/electron/preload.js`

- [ ] **Step 1: 在 main.js 顶部 require gateway**

在 `const agent = require('./agent-worker');` 后添加一行：

```javascript
const gateway = require('./local-gateway');
```

- [ ] **Step 2: 在 main.js 的 `registerIPC()` 函数末尾添加 gateway IPC handlers**

在 `ipcMain.handle('update:install', ...)` 之后，函数 `}` 闭合之前添加：

```javascript
  ipcMain.handle('gateway:status',      () => gateway.getStatus());
  ipcMain.handle('gateway:getLog',      () => gateway.getLog());
  ipcMain.handle('gateway:getDailyStats', () => gateway.getDailyStats());
  ipcMain.handle('gateway:setStrategy', (_e, strategy) => { gateway.setStrategy(strategy); return { ok: true }; });

  ipcMain.handle('gateway:testProvider', async (_e, { base_url, token }) => {
    try {
      const result = await nodeRequest(
        base_url.replace(/\/$/, '') + '/models',
        'GET',
        token ? { Authorization: `Bearer ${token}` } : {},
        null,
      );
      return { ok: result.status >= 200 && result.status < 400, status: result.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
```

- [ ] **Step 3: 在 main.js `app.whenReady()` 中启动网关**

在 `registerIPC();` 之后添加：

```javascript
  gateway.start(11430, readAgentConfig);
```

- [ ] **Step 4: 在 preload.js contextBridge 末尾添加 gateway namespace**

在 `updater: { ... },` 之后，`});` 之前添加：

```javascript
  gateway: {
    status:       () => ipcRenderer.invoke('gateway:status'),
    getLog:       () => ipcRenderer.invoke('gateway:getLog'),
    getDailyStats: () => ipcRenderer.invoke('gateway:getDailyStats'),
    setStrategy:  (s) => ipcRenderer.invoke('gateway:setStrategy', s),
    testProvider: (p)  => ipcRenderer.invoke('gateway:testProvider', p),
  },
```

- [ ] **Step 5: 启动开发服务器验证网关运行**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client && npm run dev
```

App 启动后在 DevTools Console 执行：

```javascript
await window.electronAPI.gateway.status()
// Expected: { running: true, port: 11430, strategy: "cost" }
```

另开终端验证 HTTP：

```bash
curl http://127.0.0.1:11430/health
# Expected: {"ok":true,"port":11430,"strategy":"cost"}
```

- [ ] **Step 6: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/electron/main.js client/electron/preload.js
git commit -m "feat(gateway): wire IPC handlers and auto-start gateway on app ready"
```

---

## Task 3：Sidebar + App — 新导航结构

**Files:**
- Modify: `client/src/components/Sidebar.jsx`
- Modify: `client/src/App.jsx`

- [ ] **Step 1: 更新 Sidebar.jsx 的 NAV 数组和 User card**

将 `Sidebar.jsx` 中的 `NAV` 数组替换为：

```javascript
  const NAV = [
    { to: '/gateway',   icon: '🔀', label: '网关' },
    { to: '/providers', icon: '⚡', label: '供给源' },
    { to: '/contribute',icon: '💪', label: '贡献' },
    { to: '/network',   icon: '🌐', label: t('nav.network') },
    { to: '/debug',     icon: '🐛', label: t('nav.debug') },
  ];
```

User card 文案更新——将现有的：
```jsx
<p className="text-xs font-medium text-blue-500 dark:text-blue-400 mt-0.5">
  💎 {Math.floor(user.credits_balance ?? 0).toLocaleString()} 积分
</p>
```
替换为：
```jsx
<p className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">
  💎 {Math.floor(user.credits_balance ?? 0).toLocaleString()} 积分
</p>
```

（颜色降级，不再是主角）

- [ ] **Step 2: 更新 App.jsx 路由**

将 `App.jsx` 中的 import 区更新（替换所有 page imports）：

```javascript
import Profile    from './pages/Profile';
import TokenDashboard from './pages/TokenDashboard';
import Gateway    from './pages/Gateway';
import Providers  from './pages/Providers';
import Contribute from './pages/Contribute';
import Network    from './pages/Network';
import Config     from './pages/Config';
import Debug      from './pages/Debug';
```

将 `<Routes>` 内容替换为：

```jsx
<Routes>
  <Route path="/"          element={user ? <TokenDashboard /> : <Navigate to="/config" replace />} />
  <Route path="/gateway"   element={user ? <Gateway />        : <Navigate to="/config" replace />} />
  <Route path="/providers" element={user ? <Providers />      : <Navigate to="/config" replace />} />
  <Route path="/contribute"element={user ? <Contribute />     : <Navigate to="/config" replace />} />
  <Route path="/profile"   element={user ? <Profile />        : <Navigate to="/config" replace />} />
  <Route path="/network"   element={<Network />} />
  <Route path="/config"    element={<Config />} />
  <Route path="/debug"     element={<Debug />} />
  <Route path="*"          element={<Navigate to={user ? '/' : '/config'} replace />} />
</Routes>
```

注意：Profile 保留在 `/profile` 路由（暂时不删，等 TokenDashboard 完成后再清理）。

- [ ] **Step 3: Commit（此时新页面文件尚未创建，App 会报错，先不启动）**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/components/Sidebar.jsx client/src/App.jsx
git commit -m "feat(nav): restructure navigation for three-module design"
```

---

## Task 4：Gateway.jsx — 网关状态页

**Files:**
- Create: `client/src/pages/Gateway.jsx`

- [ ] **Step 1: 创建文件，写入完整实现**

```jsx
// client/src/pages/Gateway.jsx
import React, { useEffect, useState, useCallback } from 'react';
import { getServerUrl } from '../config';
import { listKeys } from '../api/client';

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function CopyButton({ text, label = '复制' }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <button onClick={copy}
      className="shrink-0 text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
      {copied ? '已复制 ✓' : label}
    </button>
  );
}

function StrategyToggle({ strategy, onChange }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      {['cost', 'quality'].map((s) => (
        <button key={s} onClick={() => onChange(s)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            strategy === s
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}>
          {s === 'cost' ? '省钱优先' : '质量优先'}
        </button>
      ))}
    </div>
  );
}

const VIA_LABELS = {
  ollama: 'Ollama',
  groq: 'Groq',
  'github-models': 'GitHub Models',
  'tokenbank-p2p': 'P2P 网络',
  openai: 'OpenAI',
  'anthropic-paid': 'Anthropic',
};

export default function Gateway() {
  const [status, setStatus]     = useState(null);
  const [stats, setStats]       = useState(null);
  const [logEntries, setLog]    = useState([]);
  const [ccStatus, setCcStatus] = useState(null);
  const [ccMsg, setCcMsg]       = useState('');
  const [ccBusy, setCcBusy]     = useState(false);

  const localBase = status?.port ? `http://localhost:${status.port}/v1` : 'http://localhost:11430/v1';

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.gateway) return;
    const [s, st, lg] = await Promise.all([
      window.electronAPI.gateway.status(),
      window.electronAPI.gateway.getDailyStats(),
      window.electronAPI.gateway.getLog(),
    ]);
    setStatus(s);
    setStats(st);
    setLog(lg.slice(0, 20));
  }, []);

  useEffect(() => {
    refresh();
    window.electronAPI?.claude?.status().then(r => setCcStatus(r?.configured));
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleStrategy(s) {
    await window.electronAPI?.gateway?.setStrategy(s);
    setStatus(prev => prev ? { ...prev, strategy: s } : prev);
  }

  async function handleClaudeConfigure() {
    setCcBusy(true); setCcMsg('');
    try {
      const keysRes = await listKeys().catch(() => ({ data: { keys: [] } }));
      const activeKey = (keysRes.data.keys || []).find(k => k.is_active);
      if (!activeKey) { setCcMsg('请先在供给源页面创建并启用 API Key'); return; }
      await window.electronAPI.claude.configure(localBase, activeKey.key, []);
      setCcStatus(true);
      setCcMsg('配置成功，重启 Claude Code 生效');
      setTimeout(() => setCcMsg(''), 4000);
    } finally { setCcBusy(false); }
  }

  const totalCalls  = stats?.calls ?? 0;
  const providerEntries = Object.entries(stats?.by_provider ?? {})
    .sort((a, b) => b[1].calls - a[1].calls);
  const freeCalls   = providerEntries
    .filter(([id]) => !['tokenbank-p2p', 'openai', 'anthropic-paid'].includes(id))
    .reduce((s, [, v]) => s + v.calls, 0);
  const freeRatio   = totalCalls > 0 ? Math.round((freeCalls / totalCalls) * 100) : 0;

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">本地网关</h1>
        {status && (
          <div className="flex items-center gap-3">
            <span className={`flex items-center gap-1.5 text-sm ${status.running ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>
              <span className={`w-2 h-2 rounded-full ${status.running ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`} />
              {status.running ? `运行中 :${status.port}` : '已停止'}
            </span>
            <StrategyToggle strategy={status.strategy} onChange={handleStrategy} />
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="今日调用" value={totalCalls} sub="次请求" />
        <StatCard label="免费路由占比" value={`${freeRatio}%`} sub={`${freeCalls} 次走免费层`} />
        <StatCard label="供给来源" value={providerEntries.length} sub="活跃 Provider" />
      </div>

      {/* Endpoint card */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">接入配置</h2>
        <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">本地网关地址（将 AI 工具指向此地址）</p>
            <p className="font-mono text-sm text-gray-800 dark:text-gray-200">{localBase}</p>
          </div>
          <CopyButton text={localBase} />
        </div>
        <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-900 rounded-xl px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {ccStatus !== null && (
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${ccStatus ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}`}>
                {ccStatus ? 'Claude Code 已配置' : 'Claude Code 未配置'}
              </span>
            )}
            {ccMsg && <span className={`text-xs truncate ${ccMsg.includes('成功') ? 'text-green-600 dark:text-green-400' : 'text-yellow-600'}`}>{ccMsg}</span>}
          </div>
          {window.electronAPI?.claude && (
            <button onClick={handleClaudeConfigure} disabled={ccBusy}
              className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
              {ccBusy ? '配置中…' : '一键配置'}
            </button>
          )}
        </div>
      </div>

      {/* Route log */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">路由明细</h2>
        {logEntries.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">暂无请求记录。将 AI 工具的 base_url 指向 {localBase} 后开始使用。</p>
        ) : (
          <div className="space-y-1.5">
            {logEntries.map((e, i) => (
              <div key={i} className="flex items-center gap-3 text-xs px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                <span className="font-mono text-gray-500 dark:text-gray-500 shrink-0 w-12">
                  {new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{e.model || '—'}</span>
                <span className="text-gray-400 dark:text-gray-500 shrink-0">→</span>
                <span className={`shrink-0 font-medium ${e.status === 'ok' ? 'text-blue-600 dark:text-blue-400' : 'text-red-500'}`}>
                  {e.status === 'ok' ? (VIA_LABELS[e.via] || e.via || '—') : '失败'}
                </span>
                <span className="text-gray-400 dark:text-gray-500 shrink-0">{e.latency_ms}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/pages/Gateway.jsx
git commit -m "feat(gateway): add Gateway status and route log page"
```

---

## Task 5：Providers.jsx — 供给源管理

**Files:**
- Create: `client/src/pages/Providers.jsx`

- [ ] **Step 1: 创建文件，写入完整实现**

```jsx
// client/src/pages/Providers.jsx
import React, { useEffect, useState, useCallback } from 'react';

const DEFAULT_PROVIDERS = [
  { id: 'ollama',         label: 'Ollama（本地）',  base_url: 'http://127.0.0.1:11434/v1', token: '', enabled: true,  type: 'free', hint: '自动检测本地 Ollama，无需 API Key' },
  { id: 'groq',           label: 'Groq',            base_url: 'https://api.groq.com/openai/v1',         token: '', enabled: false, type: 'free', hint: '免费申请：console.groq.com' },
  { id: 'github-models',  label: 'GitHub Models',   base_url: 'https://models.github.azure.com',        token: '', enabled: false, type: 'free', hint: '使用 GitHub PAT（Fine-grained）' },
  { id: 'tokenbank-p2p',  label: 'P2P 分享网络',    base_url: '',                                        token: '', enabled: true,  type: 'p2p',  hint: '消耗积分使用社区共享算力' },
  { id: 'openai',         label: 'OpenAI',          base_url: 'https://api.openai.com/v1',              token: '', enabled: false, type: 'paid', hint: '付费 API Key，直接计费' },
  { id: 'anthropic-paid', label: 'Anthropic',       base_url: 'https://api.anthropic.com/v1',           token: '', enabled: false, type: 'paid', hint: '付费 API Key，直接计费' },
];

const TYPE_LABELS = { free: '免费层', p2p: 'P2P 分享网络', paid: '付费层（兜底）' };
const TYPE_ORDER  = ['free', 'p2p', 'paid'];

function ProviderCard({ provider, onUpdate, onTest }) {
  const [showToken, setShowToken] = useState(false);
  const [testing,   setTesting]   = useState(false);
  const [testMsg,   setTestMsg]   = useState('');

  async function handleTest() {
    if (!provider.base_url) { setTestMsg('请先填写 Base URL'); return; }
    setTesting(true); setTestMsg('');
    const result = await onTest(provider.base_url, provider.token);
    setTestMsg(result.ok ? '✓ 连接成功' : `✗ ${result.error || `HTTP ${result.status}`}`);
    setTimeout(() => setTestMsg(''), 3000);
    setTesting(false);
  }

  const isOllama = provider.id === 'ollama';
  const isP2P    = provider.type === 'p2p';

  return (
    <div className={`bg-white dark:bg-gray-800 border rounded-2xl p-4 space-y-3 transition-opacity ${provider.enabled ? 'border-gray-100 dark:border-transparent' : 'border-gray-100 dark:border-gray-700 opacity-60'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${provider.enabled ? 'bg-green-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{provider.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {testMsg && <span className={`text-xs ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{testMsg}</span>}
          {!isP2P && (
            <button onClick={handleTest} disabled={testing}
              className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
              {testing ? '测试中…' : '测试'}
            </button>
          )}
          <div onClick={() => onUpdate(provider.id, { enabled: !provider.enabled })}
            className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors ${provider.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${provider.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </div>
      </div>

      {provider.hint && <p className="text-xs text-gray-400 dark:text-gray-500">{provider.hint}</p>}

      {!isOllama && !isP2P && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key</label>
            <div className="flex gap-2">
              <input
                value={provider.token}
                onChange={e => onUpdate(provider.id, { token: e.target.value })}
                type={showToken ? 'text' : 'password'}
                placeholder="填写后启用"
                autoComplete="off"
                className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
              />
              <button type="button" onClick={() => setShowToken(v => !v)}
                className="shrink-0 px-2.5 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                {showToken ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isP2P && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          P2P 网络使用你的平台 API Key（在供给源页面右下角创建），消耗积分调用社区算力。
          积分余额不足时自动跳过此层。
        </p>
      )}
    </div>
  );
}

export default function Providers() {
  const [providers, setProviders] = useState(DEFAULT_PROVIDERS);
  const [saving,    setSaving]    = useState(false);
  const [savedMsg,  setSavedMsg]  = useState('');

  useEffect(() => {
    window.electronAPI?.config.read().then(cfg => {
      if (cfg?.providers?.length) {
        setProviders(prev => prev.map(def => {
          const saved = cfg.providers.find(p => p.id === def.id);
          return saved ? { ...def, ...saved } : def;
        }));
      }
    });
  }, []);

  const updateProvider = useCallback((id, patch) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const cfg = (await window.electronAPI?.config.read()) || {};
      await window.electronAPI?.config.write({ ...cfg, providers });
      setSavedMsg('已保存');
      setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  async function testProvider(base_url, token) {
    if (!window.electronAPI?.gateway) return { ok: false, error: 'gateway not ready' };
    return window.electronAPI.gateway.testProvider({ base_url, token });
  }

  const grouped = TYPE_ORDER.map(type => ({
    type,
    label: TYPE_LABELS[type],
    items: providers.filter(p => p.type === type),
  }));

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">供给源</h1>
        <div className="flex items-center gap-3">
          {savedMsg && <span className="text-sm text-green-600 dark:text-green-400">{savedMsg}</span>}
          <button onClick={save} disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors">
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 -mt-4">
        网关按层级顺序路由请求：免费层 → P2P 层 → 付费层。每层内按配置顺序尝试，失败自动降级。
      </p>

      {/* Routing order visualization */}
      <div className="flex items-center gap-2 text-xs">
        {TYPE_ORDER.map((type, i) => (
          <React.Fragment key={type}>
            <span className={`px-3 py-1.5 rounded-lg font-medium ${
              type === 'free' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' :
              type === 'p2p'  ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' :
                                'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300'
            }`}>{TYPE_LABELS[type]}</span>
            {i < 2 && <span className="text-gray-400">→</span>}
          </React.Fragment>
        ))}
        <span className="text-gray-400 ml-1">（省钱优先顺序）</span>
      </div>

      {grouped.map(({ type, label, items }) => (
        <section key={type} className="space-y-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{label}</h2>
          <div className="space-y-3">
            {items.map(p => (
              <ProviderCard key={p.id} provider={p} onUpdate={updateProvider} onTest={testProvider} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/pages/Providers.jsx
git commit -m "feat(providers): add three-tier provider management page"
```

---

## Task 6：Contribute.jsx — 贡献页

**Files:**
- Create: `client/src/pages/Contribute.jsx`

- [ ] **Step 1: 创建文件**

从 `Agent.jsx` 提取贡献 Tab 的内容，完整如下：

```jsx
// client/src/pages/Contribute.jsx
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getStats, getSettlements } from '../api/client';
import RateChart from '../components/RateChart';
import { LLM_PROVIDER_PRESETS, matchPresetId } from '../data/llmProviderPresets';

function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function emptyGroup() {
  return { base_url: '', token: '', showToken: false, models: [] };
}

function ContributionConfigCard() {
  const [cfg,       setCfg]       = useState(null);
  const [editing,   setEditing]   = useState(false);
  const [groups,    setGroups]    = useState([emptyGroup()]);
  const [nodeName,  setNodeName]  = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [savedMsg,  setSavedMsg]  = useState('');
  const [scanning,  setScanning]  = useState(false);
  const [presetId,  setPresetId]  = useState('custom');

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then(async (saved) => {
      const hasGroups = saved?.model_groups?.length > 0;
      const hasLegacy = saved?.llm_base_url;
      if (hasGroups || hasLegacy) { setCfg(saved); }
      else {
        try {
          const results = await window.electronAPI.config.scan();
          const best = results[0];
          if (best?.base_url) {
            const updated = { ...(saved || {}), llm_base_url: best.base_url, llm_token: best.token || '', models: best.models || [] };
            await window.electronAPI.config.write(updated);
            setCfg(updated); return;
          }
        } catch {}
        setCfg(saved || {}); setEditing(true);
      }
    });
  }, []);

  function openEdit() {
    let parsed;
    if (cfg?.model_groups?.length) {
      parsed = cfg.model_groups.map(g => ({
        base_url: g.base_url || '', token: g.token || '', showToken: false,
        models: (g.models || []).map(m => typeof m === 'string' ? { name: m, type: 'chat' } : m),
      }));
    } else {
      const models = (cfg?.models || []).map(m => typeof m === 'string' ? { name: m, type: 'chat' } : { name: m.name, type: m.type || 'chat' });
      parsed = [{ base_url: cfg?.llm_base_url || '', token: cfg?.llm_token || '', showToken: false, models }];
    }
    if (parsed.length === 0) parsed = [emptyGroup()];
    setGroups(parsed);
    setNodeName(cfg?.name || '');
    setAutoStart(!!cfg?.auto_start);
    setPresetId(matchPresetId(parsed[0]?.base_url));
    setEditing(true);
  }

  async function autoScan() {
    if (!window.electronAPI) return;
    setScanning(true);
    try {
      const results = await window.electronAPI.config.scan();
      const best = results[0];
      if (best?.base_url) {
        const current = (await window.electronAPI.config.read()) || {};
        const updated = { ...current, llm_base_url: best.base_url, llm_token: best.token || '', models: best.models || [] };
        await window.electronAPI.config.write(updated); setCfg(updated);
        setSavedMsg('已自动配置'); setTimeout(() => setSavedMsg(''), 2000);
      } else { setSavedMsg('未找到配置'); setTimeout(() => setSavedMsg(''), 2000); }
    } finally { setScanning(false); }
  }

  function applyPreset(pid) {
    setPresetId(pid);
    const preset = LLM_PROVIDER_PRESETS.find(p => p.id === pid);
    if (!preset || !preset.baseUrl) return;
    setGroups(prev => prev.map((g, i) => i === 0 ? {
      ...g, base_url: preset.baseUrl,
      models: preset.defaultModels.map(n => ({ name: n, type: 'chat' })),
    } : g));
  }

  async function save() {
    if (!window.electronAPI) return;
    setSaving(true);
    try {
      const model_groups = groups.map(({ base_url, token, models }) => ({ base_url, token, models: models.filter(m => m.name.trim()) }));
      const allModels = model_groups.flatMap(g => g.models);
      const first = model_groups[0] || {};
      const current = (await window.electronAPI.config.read()) || {};
      const updated = { ...current, model_groups, llm_base_url: first.base_url || '', llm_token: first.token || '', models: allModels, name: nodeName, auto_start: autoStart };
      await window.electronAPI.config.write(updated); setCfg(updated); setEditing(false);
      setSavedMsg('已保存'); setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  function updateGroup(idx, patch) { setGroups(prev => prev.map((g, i) => i === idx ? { ...g, ...patch } : g)); }
  function updateGroupModel(gIdx, mIdx, patch) {
    setGroups(prev => prev.map((g, i) => i === gIdx ? { ...g, models: g.models.map((m, j) => j === mIdx ? { ...m, ...patch } : m) } : g));
  }
  function removeGroupModel(gIdx, mIdx) {
    setGroups(prev => prev.map((g, i) => i === gIdx ? { ...g, models: g.models.filter((_, j) => j !== mIdx) } : g));
  }

  const viewGroups = cfg?.model_groups?.length ? cfg.model_groups : (cfg?.llm_base_url ? [{ base_url: cfg.llm_base_url, models: cfg?.models || [] }] : []);
  const configured = viewGroups.some(g => g.base_url && g.models?.length > 0);
  const canSave    = groups.some(g => g.base_url.trim());

  if (!editing) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${configured ? 'bg-green-400' : 'bg-yellow-400'}`} />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">贡献节点配置</span>
            {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={autoScan} disabled={scanning}
              className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 disabled:opacity-50 transition-colors">
              {scanning ? '扫描中…' : '自动配置'}
            </button>
            <button onClick={openEdit}
              className="px-3 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 transition-colors">
              手动配置
            </button>
          </div>
        </div>
        {configured ? (
          <div className="mt-3 space-y-2 text-xs text-gray-500 dark:text-gray-400">
            {viewGroups.map((g, i) => {
              const ms = (g.models || []).map(m => typeof m === 'string' ? m : `${m.name}(${m.type === 'image' ? '图像' : '对话'})`).join(', ');
              return (
                <div key={i} className="bg-gray-50 dark:bg-gray-700/40 rounded-xl px-3 py-2 space-y-0.5">
                  <p className="font-mono truncate text-gray-600 dark:text-gray-300">{g.base_url}</p>
                  {ms && <p className="text-gray-400 dark:text-gray-500">{ms}</p>}
                </div>
              );
            })}
            {cfg?.name && <p><span className="text-gray-400 inline-block w-12">节点</span>{cfg.name}</p>}
            <p><span className="text-gray-400 inline-block w-12">自启动</span>{cfg?.auto_start ? '开启' : '关闭'}</p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-yellow-600 dark:text-yellow-400">未找到可用配置，请点击「手动配置」填写。</p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">贡献节点配置</span>
        {configured && <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">取消</button>}
      </div>

      {/* Preset selector */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">快速选择 Provider</label>
        <select value={presetId} onChange={e => applyPreset(e.target.value)}
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500">
          {LLM_PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      {groups.map((g, gIdx) => (
        <div key={gIdx} className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">分组 {gIdx + 1}</span>
            {groups.length > 1 && <button type="button" onClick={() => setGroups(prev => prev.filter((_, i) => i !== gIdx))} className="text-xs text-red-400 hover:text-red-600">删除分组</button>}
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Base URL</label>
            <input value={g.base_url} onChange={e => updateGroup(gIdx, { base_url: e.target.value })} placeholder="http://127.0.0.1:11434/v1"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key（可选）</label>
            <div className="flex gap-2">
              <input value={g.token} onChange={e => updateGroup(gIdx, { token: e.target.value })} placeholder="无则留空"
                type={g.showToken ? 'text' : 'password'} autoComplete="off"
                className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
              <button type="button" onClick={() => updateGroup(gIdx, { showToken: !g.showToken })}
                className="shrink-0 px-3 py-2 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 hover:dark:bg-gray-700">
                {g.showToken ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">模型</label>
            <div className="space-y-1.5 mb-2">
              {g.models.map((m, mIdx) => (
                <div key={mIdx} className="flex items-center gap-2">
                  <input value={m.name} onChange={e => updateGroupModel(gIdx, mIdx, { name: e.target.value })} placeholder="模型 ID"
                    className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
                  <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-600 shrink-0">
                    {['chat', 'image'].map(t => (
                      <button key={t} type="button" onClick={() => updateGroupModel(gIdx, mIdx, { type: t })}
                        className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${m.type === t ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                        {t === 'chat' ? '对话' : '图像'}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={() => removeGroupModel(gIdx, mIdx)} className="text-gray-400 hover:text-red-500 text-lg leading-none px-1">×</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => updateGroup(gIdx, { models: [...g.models, { name: '', type: 'chat' }] })}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加模型</button>
          </div>
        </div>
      ))}

      <button type="button" onClick={() => setGroups(prev => [...prev, emptyGroup()])}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ 添加分组</button>

      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">节点名称</label>
        <input value={nodeName} onChange={e => setNodeName(e.target.value)} placeholder="留空使用主机名"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
      </div>

      <label className="flex items-center gap-3 cursor-pointer select-none">
        <div onClick={() => setAutoStart(v => !v)} className={`relative w-10 h-6 rounded-full transition-colors ${autoStart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoStart ? 'translate-x-5' : 'translate-x-1'}`} />
        </div>
        <span className="text-sm text-gray-700 dark:text-gray-300">启动应用时自动运行贡献节点</span>
      </label>

      <button onClick={save} disabled={saving || !canSave}
        className="px-5 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
        {saving ? '保存中…' : '保存配置'}
      </button>
    </div>
  );
}

export default function Contribute() {
  const [running,     setRunning]     = useState(false);
  const [stats,       setStats]       = useState(null);
  const [chartData,   setChartData]   = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [logs,        setLogs]        = useState([]);
  const logRef = useRef(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.agent.getStatus().then(({ running: r }) => setRunning(r));
    const disposeStatus = window.electronAPI.agent.onStatus(({ running: r, error }) => {
      setRunning(r);
      if (error) setLogs(prev => [...prev.slice(-99), `[error] ${error}`]);
    });
    const disposeLog = window.electronAPI.agent.onLog(line => setLogs(prev => [...prev.slice(-99), line.trimEnd()]));
    return () => { disposeStatus?.(); disposeLog?.(); };
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  useEffect(() => {
    function poll() {
      getStats().then(r => {
        setStats(r.data);
        const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setChartData(prev => [...prev.slice(-29), { time: t, value: r.data.contribute_req_per_min ?? 0 }]);
      }).catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSettlements().then(r => setSettlements((r.data.settlements || []).slice(0, 10))).catch(() => {});
  }, []);

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">贡献</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 -mt-4">
        将你的本地算力或 API Key 共享到 P2P 网络，赚取积分用于消费其他模型。
      </p>

      {/* Start/Stop */}
      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-400 dark:bg-gray-600'}`} />
          <span className="text-lg font-medium text-gray-700 dark:text-gray-200">{running ? '贡献中' : '已停止'}</span>
        </div>
        <div className="flex gap-3">
          <button onClick={() => window.electronAPI?.agent.start()} disabled={running}
            className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">启动</button>
          <button onClick={() => window.electronAPI?.agent.stop()} disabled={!running}
            className="px-5 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">停止</button>
        </div>
      </div>

      <ContributionConfigCard />

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">贡献速率</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.contribute_req_per_min ?? 0}</p>
            <p className="text-xs text-gray-400">req/min</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">活跃请求</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_requests ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">在线节点</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_workers ?? 0}</p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-4">
        <p className="text-sm text-gray-400 mb-2">贡献请求速率 (req/min)</p>
        <RateChart data={chartData} />
      </div>

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">最近结算</h2>
        {settlements.length === 0 ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">暂无结算记录</p>
        ) : (
          <div className="space-y-2">
            {settlements.map(s => (
              <div key={s.id ?? s.period_end}
                className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 grid grid-cols-5 gap-2 text-sm items-center">
                <span className="text-gray-400 text-xs">{s.period_end?.slice(0, 16)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.output_tokens ?? 0).toLocaleString()} tok</span>
                <span className="text-yellow-500 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-600 dark:text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">Agent 日志</h2>
        <div ref={logRef} className="bg-gray-100 dark:bg-gray-900 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
          {logs.length === 0 ? <span className="text-gray-400">（日志为空）</span> : logs.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/pages/Contribute.jsx
git commit -m "feat(contribute): extract contribution page from Agent.jsx"
```

---

## Task 7：TokenDashboard.jsx — Token 盘点主页

**Files:**
- Create: `client/src/pages/TokenDashboard.jsx`

- [ ] **Step 1: 创建文件，写入完整实现**

```jsx
// client/src/pages/TokenDashboard.jsx
import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../store/index';
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder, spin, getSpinStatus } from '../api/client';

const PROVIDER_COLORS = {
  ollama:         { bg: 'bg-green-500',  label: 'Ollama（本地）',   type: 'free' },
  groq:           { bg: 'bg-emerald-500',label: 'Groq',             type: 'free' },
  'github-models':{ bg: 'bg-teal-500',   label: 'GitHub Models',    type: 'free' },
  'tokenbank-p2p':{ bg: 'bg-blue-500',   label: 'P2P 网络',         type: 'p2p'  },
  openai:         { bg: 'bg-orange-500', label: 'OpenAI',           type: 'paid' },
  'anthropic-paid':{ bg: 'bg-red-500',   label: 'Anthropic',        type: 'paid' },
};

const TX_LABEL = { contribute: '贡献', consume: '消耗', referral: '推荐', purchase: '充值', adjust: '调整', spin: '转盘' };
const ORDER_STATUS = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };

// ── Sub-components ────────────────────────────────────────────────────────────

function ProviderBar({ id, calls, totalCalls }) {
  const meta  = PROVIDER_COLORS[id] || { bg: 'bg-gray-400', label: id };
  const pct   = totalCalls > 0 ? (calls / totalCalls) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-28 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate">{meta.label}</div>
      <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full ${meta.bg}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-16 shrink-0 text-right">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{calls} 次</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">{Math.round(pct)}%</span>
      </div>
      <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full ${
        meta.type === 'free' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
        meta.type === 'p2p'  ? 'bg-blue-100  dark:bg-blue-900/30  text-blue-700  dark:text-blue-400'  :
                               'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400'
      }`}>
        {meta.type === 'free' ? '免费' : meta.type === 'p2p' ? '积分' : '付费'}
      </span>
    </div>
  );
}

function CheckinCard({ onSuccess }) {
  const [status,   setStatus]   = useState(null);
  const [checking, setChecking] = useState(false);
  const [msg,      setMsg]      = useState('');

  useEffect(() => { getCheckinStatus().then(r => setStatus(r.data)).catch(() => {}); }, []);

  async function handleCheckin() {
    setChecking(true); setMsg('');
    try {
      const r = await checkin();
      setMsg(`+${r.data.credits} 积分`);
      setStatus(s => ({ ...s, checked_in_today: true }));
      onSuccess?.();
    } catch (e) { setMsg(e.response?.data?.detail || '签到失败'); }
    finally { setChecking(false); }
  }

  const done = status?.checked_in_today;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xl select-none">📅</span>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日签到</p>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {status === null ? '加载中…' : done ? `今日已签到 +${status.credits_today} 积分` : `签到得 ${status.reward} 积分`}
      </p>
      {msg && <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</span>}
      <button onClick={handleCheckin} disabled={checking || done}
        className={`py-1.5 rounded-lg text-sm font-medium transition-colors ${done ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 cursor-default' : 'bg-blue-600 hover:bg-blue-500 text-white'} disabled:opacity-60`}>
        {checking ? '签到中…' : done ? '已签到 ✓' : '签到'}
      </button>
    </div>
  );
}

function SpinCard({ onSuccess }) {
  const [status,  setStatus]  = useState(null);
  const [spinning,setSpinning]= useState(false);
  const [msg,     setMsg]     = useState('');

  useEffect(() => { getSpinStatus().then(r => setStatus(r.data)).catch(() => {}); }, []);

  async function handleSpin() {
    if (spinning || status?.spins_left === 0) return;
    setSpinning(true); setMsg('');
    try {
      const r = await spin();
      setMsg(`+${r.data.credits} 积分`);
      setStatus(s => ({ ...s, spins_left: r.data.spins_left }));
      onSuccess?.();
    } catch (e) { setMsg(e.response?.data?.detail || '抽奖失败'); }
    finally { setSpinning(false); }
  }

  const exhausted = status?.spins_left === 0;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xl select-none">🎡</span>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日转盘</p>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {status === null ? '加载中…' : exhausted ? '今日次数已用完' : `今日剩余 ${status.spins_left} 次`}
      </p>
      {msg && <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</span>}
      <button onClick={handleSpin} disabled={spinning || exhausted || !status}
        className={`py-1.5 rounded-lg text-sm font-medium transition-colors ${exhausted ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 cursor-default' : 'bg-blue-600 hover:bg-blue-500 text-white'} disabled:opacity-60`}>
        {spinning ? '抽奖中…' : exhausted ? '明日再来' : '抽奖'}
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TokenDashboard() {
  const { user, refreshUser } = useAuth();
  const [stats,    setStats]    = useState(null);
  const [logEntries, setLog]    = useState([]);
  const [txs,      setTxs]      = useState([]);
  const [orders,   setOrders]   = useState([]);
  const [adminInfo,setAdminInfo]= useState('');
  const [contact,  setContact]  = useState('');
  const [note,     setNote]     = useState('');
  const [submitting,setSubmitting]=useState(false);
  const [orderMsg, setOrderMsg] = useState('');
  const [orderMsgOk,setOrderMsgOk]=useState(false);
  const [creditsOpen,setCreditsOpen]=useState(false);

  const loadData = useCallback(async () => {
    if (!window.electronAPI?.gateway) return;
    const [s, lg] = await Promise.all([
      window.electronAPI.gateway.getDailyStats(),
      window.electronAPI.gateway.getLog(),
    ]);
    setStats(s);
    setLog(lg.slice(0, 5));
  }, []);

  useEffect(() => {
    refreshUser();
    loadData();
    getTransactions().then(r => setTxs(r.data.transactions || [])).catch(() => {});
    getPurchaseOrders().then(r => { setOrders(r.data.orders || []); if (r.data.contact_info) setAdminInfo(String(r.data.contact_info)); }).catch(() => {});
    const id = setInterval(loadData, 10_000);
    return () => clearInterval(id);
  }, [loadData, refreshUser]);

  if (!user) return null;

  const totalCalls = stats?.calls ?? 0;
  const providerEntries = Object.entries(stats?.by_provider ?? {}).sort((a, b) => b[1].calls - a[1].calls);
  const modelEntries    = Object.entries(stats?.by_model    ?? {}).sort((a, b) => b[1].calls - a[1].calls);
  const freeCalls = providerEntries
    .filter(([id]) => !['tokenbank-p2p', 'openai', 'anthropic-paid'].includes(id))
    .reduce((s, [, v]) => s + v.calls, 0);

  async function handleOrder(e) {
    e.preventDefault();
    if (!contact.trim()) return;
    setSubmitting(true); setOrderMsg('');
    try {
      const r = await createPurchaseOrder(0, `联系方式：${contact.trim()}${note.trim() ? `；${note.trim()}` : ''}`);
      setOrderMsgOk(true); setOrderMsg('申请已提交，管理员将与你联系。');
      if (r.data.contact_info) setAdminInfo(String(r.data.contact_info));
      setOrders(prev => [r.data.order, ...prev]); setContact(''); setNote('');
    } catch (err) {
      setOrderMsgOk(false); setOrderMsg(err.response?.data?.detail || '提交失败');
    } finally { setSubmitting(false); }
  }

  return (
    <div className="p-8 space-y-8">

      {/* Hero */}
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-blue-700 flex items-center justify-center text-xl font-bold text-white shrink-0">
          {(user.nickname || user.email || '?')[0].toUpperCase()}
        </div>
        <div>
          <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{user.nickname}</p>
          <p className="text-sm text-gray-400 truncate">{user.email}</p>
        </div>
      </div>

      {/* Today usage */}
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 rounded-2xl p-6 space-y-2">
        <p className="text-sm text-blue-300">今日 Token 使用</p>
        <p className="text-4xl font-bold text-white">{totalCalls} <span className="text-xl font-normal text-blue-300">次调用</span></p>
        <p className="text-sm text-blue-300">
          {freeCalls} 次走免费层（{totalCalls > 0 ? Math.round(freeCalls / totalCalls * 100) : 0}%）·
          {totalCalls - freeCalls} 次走积分/付费层
        </p>
      </div>

      {/* Provider breakdown */}
      {providerEntries.length > 0 && (
        <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">供给来源分布</h2>
          <div className="space-y-2.5">
            {providerEntries.map(([id, { calls }]) => (
              <ProviderBar key={id} id={id} calls={calls} totalCalls={totalCalls} />
            ))}
          </div>
        </section>
      )}

      {/* Model breakdown */}
      {modelEntries.length > 0 && (
        <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">模型使用分布</h2>
          <div className="space-y-2.5">
            {modelEntries.slice(0, 6).map(([name, { calls }]) => (
              <div key={name} className="flex items-center gap-3 text-sm">
                <div className="w-36 shrink-0 text-xs text-gray-600 dark:text-gray-400 truncate font-mono">{name}</div>
                <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                  <div className="h-2 rounded-full bg-blue-400" style={{ width: `${totalCalls > 0 ? (calls / totalCalls) * 100 : 0}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">{calls} 次</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent route log */}
      {logEntries.length > 0 && (
        <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-5 space-y-2">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">最近调用</h2>
          <div className="space-y-1.5">
            {logEntries.map((e, i) => {
              const meta = PROVIDER_COLORS[e.via] || {};
              return (
                <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-900">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="text-gray-500 shrink-0">{new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="flex-1 text-gray-700 dark:text-gray-300 truncate font-mono">{e.model || '—'}</span>
                  <span className="text-gray-400">→</span>
                  <span className="text-blue-600 dark:text-blue-400 shrink-0">{meta.label || e.via || '—'}</span>
                  <span className="text-gray-400 shrink-0">{e.latency_ms}ms</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Daily rewards */}
      <div className="grid grid-cols-2 gap-4">
        <CheckinCard onSuccess={refreshUser} />
        <SpinCard    onSuccess={refreshUser} />
      </div>

      {/* Credits (collapsible) */}
      <section className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl overflow-hidden">
        <button onClick={() => setCreditsOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold text-gray-700 dark:text-gray-200">积分账户</span>
            <span className="text-sm font-bold text-blue-600 dark:text-blue-400">💎 {Math.floor(user.credits_balance ?? 0).toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-gray-400">
              <span className="text-green-600 dark:text-green-400">+{Math.floor(user.credits_earned ?? 0).toLocaleString()}</span>
              <span className="mx-1">/</span>
              <span className="text-red-500 dark:text-red-400">-{Math.floor(user.credits_spent ?? 0).toLocaleString()}</span>
            </div>
            <span className="text-gray-400 text-sm">{creditsOpen ? '▲' : '▼'}</span>
          </div>
        </button>

        {creditsOpen && (
          <div className="px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700">
            {/* Recent transactions */}
            <div className="pt-4 space-y-2">
              <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">积分流水</h3>
              {txs.length === 0 ? (
                <p className="text-sm text-gray-400">暂无记录</p>
              ) : txs.slice(0, 8).map(tx => (
                <div key={tx.id} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="text-gray-700 dark:text-gray-300">{TX_LABEL[tx.type] || tx.type}{tx.model_name ? ` · ${tx.model_name}` : ''}</span>
                    <span className="text-xs text-gray-400 ml-2">{tx.created_at?.slice(0, 16)}</span>
                  </div>
                  <span className={`font-medium ${(tx.delta ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                    {(tx.delta ?? 0) >= 0 ? '+' : ''}{(tx.delta ?? 0).toFixed(1)}
                  </span>
                </div>
              ))}
            </div>

            {/* Purchase */}
            <div className="border-t border-gray-100 dark:border-gray-700 pt-4 space-y-3">
              <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">申领积分</h3>
              <form onSubmit={handleOrder} className="space-y-2">
                <input value={contact} onChange={e => setContact(e.target.value)} placeholder="联系方式（手机/微信/邮箱）" required
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400" />
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="备注（可选）"
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400" />
                <button type="submit" disabled={submitting || !contact.trim()}
                  className="w-full py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white">
                  {submitting ? '提交中…' : '提交申领'}
                </button>
              </form>
              {orderMsg && <p className={`text-sm ${orderMsgOk ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{orderMsg}</p>}
              {adminInfo && <div className="text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded-lg px-3 py-2 whitespace-pre-wrap">{adminInfo}</div>}
            </div>
          </div>
        )}
      </section>

    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/pages/TokenDashboard.jsx
git commit -m "feat(dashboard): add Token 盘点 home page with usage breakdown"
```

---

## Task 8：清理 + 全路由冒烟测试

**Files:**
- Delete: `client/src/pages/Agent.jsx`

- [ ] **Step 1: 删除旧 Agent.jsx**

```bash
rm /Users/ully/githubprojects/local-llm-proxy/client/src/pages/Agent.jsx
```

- [ ] **Step 2: 启动 dev server 验证无报错**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client && npm run dev
```

DevTools Console 不应有红色错误。

- [ ] **Step 3: 逐页验证**

| 路由 | 验证点 |
|------|--------|
| `/` (Token 盘点) | 显示今日调用数（初始为 0）、供给来源分布区块、积分折叠区块可展开 |
| `/gateway` | 显示「运行中 :11430」、策略切换可点击 |
| `/providers` | 三层 Provider 列表显示，Ollama 卡片显示 enabled=true，保存按钮可用 |
| `/contribute` | 显示启动/停止按钮，节点配置卡片正常 |
| `/network` | 在线节点数显示正常 |

- [ ] **Step 4: 验证网关实际路由**

在 Providers 页配置以下外部 Provider（添加到免费层 custom 或直接编辑 config.json）：
- Base URL: `http://49.51.47.124:3000/`
- API Key: `sk-F0eM1NRniM661RgdA2C8B83dD3824f628b4725F4663b195c`
- 启用状态: true
- 类型: free

然后在终端执行真实路由请求：

```bash
curl -s http://127.0.0.1:11430/health
# Expected: {"ok":true,"port":11430,"strategy":"cost"}

curl -s -X POST http://127.0.0.1:11430/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"glm-4.5-flash","messages":[{"role":"user","content":"say hi"}],"stream":false}' \
  | head -c 200
# Expected: JSON response with choices[0].message.content
```

打开 `/gateway` 页，路由明细应出现该条请求记录（via: 外部 Provider，状态: ok）。

- [ ] **Step 5: 最终 commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add -A
git commit -m "feat: complete app redesign - Token 盘点 + three-module nav"
```

---

## 验证清单（完成标准）

- [ ] `curl http://127.0.0.1:11430/health` 返回 `{"ok":true}`
- [ ] 网关路由一个真实请求（Ollama 在线时），Gateway 页出现路由记录
- [ ] Token 盘点页供给来源分布展示该条记录（刷新间隔 10s）
- [ ] Providers 页配置外部 Provider（http://49.51.47.124:3000/ + glm-4.5-flash），测试按钮返回「✓ 连接成功」
- [ ] Contribute 页节点配置和启动/停止功能正常
- [ ] Agent.jsx 已删除，无残留引用

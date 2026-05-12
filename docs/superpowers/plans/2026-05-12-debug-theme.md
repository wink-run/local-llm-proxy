# Debug Page + Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a model API debug page (test local LLM or global network) and a light/dark/system theme system to the Electron client.

**Architecture:** Theme uses Tailwind `darkMode: 'class'` — a `ThemeContext` applies/removes the `dark` class on `<html>` and persists the choice (`light`/`dark`/`system`) in localStorage; system mode listens to `prefers-color-scheme`. The debug page uses the browser `fetch` API directly for streaming SSE responses; local LLM config is read via `window.electronAPI.config.read()`.

**Tech Stack:** React 18, Tailwind CSS 3 (class dark mode), browser Fetch API (streaming SSE), existing IPC bridge.

---

## File Map

**Modified:**
- `client/tailwind.config.js` — add `darkMode: 'class'`
- `client/src/App.jsx` — wrap with `ThemeProvider`, import `Debug` page, add `/debug` route
- `client/src/components/Sidebar.jsx` — add 🐛 Debug nav item; update all classes with `dark:` variants
- `client/src/pages/Config.jsx` — add theme selector section at bottom; update classes
- `client/src/pages/Profile.jsx` — add `dark:` variants to all classes
- `client/src/pages/Agent.jsx` — add `dark:` variants to all classes
- `client/src/pages/Network.jsx` — add `dark:` variants to all classes
- `client/src/index.css` — add color-transition to body

**Created:**
- `client/src/store/theme.jsx` — ThemeContext: `theme` state, `setTheme`, system listener
- `client/src/pages/Debug.jsx` — debug page: source picker, model dropdown, message input, streaming response

---

## Color mapping (light → dark)

| Light class | Dark variant |
|---|---|
| `bg-gray-50` | `dark:bg-gray-950` |
| `bg-white` | `dark:bg-gray-900` |
| `bg-gray-100` | `dark:bg-gray-800` |
| `bg-gray-200` | `dark:bg-gray-700` |
| `border-gray-200` | `dark:border-gray-800` |
| `border-gray-300` | `dark:border-gray-700` |
| `text-gray-900` | `dark:text-gray-100` |
| `text-gray-700` | `dark:text-gray-300` |
| `text-gray-500` | `dark:text-gray-400` |
| `text-gray-400` | `dark:text-gray-500` |

---

## Task 1: Tailwind dark mode + ThemeContext

**Files:**
- Modify: `client/tailwind.config.js`
- Create: `client/src/store/theme.jsx`
- Modify: `client/src/index.css`

- [ ] **Step 1: Enable Tailwind class dark mode**

Replace `client/tailwind.config.js` entirely:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: { extend: {} },
  plugins: [],
};
```

- [ ] **Step 2: Add color transition to body in `client/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

* { box-sizing: border-box; }

body {
  transition: background-color 0.15s ease, color 0.15s ease;
}
```

- [ ] **Step 3: Create `client/src/store/theme.jsx`**

```jsx
import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext(null);

function applyTheme(theme) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', useDark);
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(
    () => localStorage.getItem('theme') || 'system'
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Keep system mode in sync with OS changes
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  function setTheme(t) {
    localStorage.setItem('theme', t);
    setThemeState(t);
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npx vite build 2>&1 | tail -5
```

Expected: `✓ built in`

- [ ] **Step 5: Commit**

```bash
git add client/tailwind.config.js client/src/store/theme.jsx client/src/index.css
git commit -m "feat: add ThemeContext with light/dark/system modes and Tailwind class dark mode"
```

---

## Task 2: Wire ThemeProvider into App + apply dark class

**Files:**
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Update `client/src/App.jsx`**

```jsx
import React from 'react';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import { ThemeProvider } from './store/theme';
import Sidebar from './components/Sidebar';
import Profile from './pages/Profile';
import Agent from './pages/Agent';
import Network from './pages/Network';
import Config from './pages/Config';
import Debug from './pages/Debug';

function Layout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-500 dark:text-gray-400">
        加载中…
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {user && <Sidebar />}
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={user ? <Profile /> : <Navigate to="/config" replace />} />
          <Route path="/agent" element={user ? <Agent /> : <Navigate to="/config" replace />} />
          <Route path="/network" element={<Network />} />
          <Route path="/config" element={<Config />} />
          <Route path="/debug" element={<Debug />} />
          <Route path="*" element={<Navigate to={user ? '/' : '/config'} replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <Layout />
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npx vite build 2>&1 | tail -5
```

Expected: `✓ built in`

- [ ] **Step 3: Commit**

```bash
git add client/src/App.jsx
git commit -m "feat: wire ThemeProvider into App shell and add /debug route"
```

---

## Task 3: Theme Sidebar + add Debug nav item

**Files:**
- Modify: `client/src/components/Sidebar.jsx`

- [ ] **Step 1: Replace `client/src/components/Sidebar.jsx`**

```jsx
import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../store/index';

const NAV = [
  { to: '/', icon: '👤', label: '我的账户' },
  { to: '/agent', icon: '⚙️', label: 'Agent' },
  { to: '/network', icon: '🌐', label: '网络' },
  { to: '/debug', icon: '🐛', label: '调试' },
  { to: '/config', icon: '🔧', label: '设置' },
];

export default function Sidebar() {
  const { user } = useAuth();
  return (
    <aside className="w-16 flex flex-col items-center py-6 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 gap-2 shrink-0">
      <div className="mb-4 text-xl select-none">🤖</div>
      {NAV.map(({ to, icon, label }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            'w-12 h-12 flex items-center justify-center rounded-xl text-xl transition-colors ' +
            (isActive
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white')
          }
        >
          {icon}
        </NavLink>
      ))}
      <div className="mt-auto text-xs text-gray-400 dark:text-gray-600 text-center leading-tight px-1 truncate w-full">
        {user?.nickname}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npx vite build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Sidebar.jsx
git commit -m "feat: add Debug nav item to Sidebar and apply light/dark theme classes"
```

---

## Task 4: Theme existing pages (Profile, Agent, Network)

**Files:**
- Modify: `client/src/pages/Profile.jsx`
- Modify: `client/src/pages/Agent.jsx`
- Modify: `client/src/pages/Network.jsx`

Apply the color mapping table: every existing dark-only class gets a light-mode base + `dark:` variant.

- [ ] **Step 1: Update Profile.jsx — replace all dark-only classes**

Key replacements throughout the file:
- `bg-gray-800` → `bg-white dark:bg-gray-800`
- `text-gray-100` → `text-gray-900 dark:text-gray-100`
- `text-gray-300` → `text-gray-700 dark:text-gray-300`
- `text-gray-500` → `text-gray-400 dark:text-gray-500`
- `text-gray-400` → `text-gray-500 dark:text-gray-400`
- `text-green-400` stays (works on both)
- `text-red-400` stays

Full replacement for `client/src/pages/Profile.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import { useAuth } from '../store/index';
import { getTransactions } from '../api/client';

const TX_LABEL = {
  contribute: '贡献',
  consume: '消耗',
  referral: '推荐',
  purchase: '充值',
  adjust: '调整',
};

function StatCard({ label, value }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-transparent">
      <p className="text-xs text-gray-500 dark:text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}

export default function Profile() {
  const { user, refreshUser } = useAuth();
  const [txs, setTxs] = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(true);
  const [txError, setTxError] = useState(false);

  useEffect(() => {
    refreshUser();
    getTransactions()
      .then((r) => setTxs(r.data.transactions || []))
      .catch(() => { setTxError(true); })
      .finally(() => setLoadingTxs(false));
  }, []);

  if (!user) return null;

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-blue-700 flex items-center justify-center text-2xl font-bold text-white shrink-0">
          {(user.nickname || user.email || '?')[0].toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-xl font-bold text-gray-900 dark:text-gray-100 truncate">{user.nickname}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-blue-700 to-blue-900 rounded-2xl p-6">
        <p className="text-sm text-blue-300 mb-1">积分余额</p>
        <p className="text-5xl font-bold text-white">
          {Math.floor(user.credits_balance ?? 0).toLocaleString()}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <StatCard label="累计贡献积分" value={Math.floor(user.credits_earned ?? 0).toLocaleString()} />
        <StatCard label="累计消耗积分" value={Math.floor(user.credits_spent ?? 0).toLocaleString()} />
      </div>

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">积分流水</h2>
        {loadingTxs ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">加载中…</p>
        ) : txError ? (
          <p className="text-red-400 text-sm">加载失败，请刷新重试</p>
        ) : txs.length === 0 ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">暂无记录</p>
        ) : (
          <div className="space-y-2">
            {txs.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3"
              >
                <div>
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {TX_LABEL[tx.type] || tx.type}
                    {tx.model_name ? ` · ${tx.model_name}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">{tx.created_at?.slice(0, 16)}</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-medium ${(tx.delta ?? 0) >= 0 ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                    {(tx.delta ?? 0) >= 0 ? '+' : ''}{(tx.delta ?? 0).toFixed(1)}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">余额 {(tx.balance ?? 0).toFixed(1)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Update Agent.jsx — replace dark-only classes**

Full replacement for `client/src/pages/Agent.jsx`:

```jsx
import React, { useEffect, useState, useRef } from 'react';
import { getStats, getSettlements } from '../api/client';
import RateChart from '../components/RateChart';

function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export default function Agent() {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [logs, setLogs] = useState([]);
  const logRef = useRef(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.agent.getStatus().then(({ running: r }) => setRunning(r));
    const disposeStatus = window.electronAPI.agent.onStatus(({ running: r, error }) => {
      setRunning(r);
      if (error) setLogs((prev) => [...prev.slice(-99), `[error] ${error}`]);
    });
    const disposeLog = window.electronAPI.agent.onLog((line) =>
      setLogs((prev) => [...prev.slice(-99), line.trimEnd()])
    );
    return () => { disposeStatus?.(); disposeLog?.(); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    function poll() {
      getStats()
        .then((r) => {
          setStats(r.data);
          const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          setChartData((prev) => [...prev.slice(-29), { time: t, value: r.data.contribute_req_per_min ?? 0 }]);
        })
        .catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSettlements()
      .then((r) => setSettlements((r.data.settlements || []).slice(0, 10)))
      .catch(() => {});
  }, []);

  const handleStart = () => window.electronAPI?.agent.start();
  const handleStop = () => window.electronAPI?.agent.stop();

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Agent</h1>

      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-400 dark:bg-gray-600'}`} />
          <span className="text-lg font-medium text-gray-700 dark:text-gray-200">{running ? '运行中' : '已停止'}</span>
        </div>
        <div className="flex gap-3">
          <button onClick={handleStart} disabled={running}
            className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
            启动
          </button>
          <button onClick={handleStop} disabled={!running}
            className="px-5 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
            停止
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">贡献速率</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.contribute_req_per_min ?? 0}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">req/min</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">活跃请求</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_requests ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">在线节点</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.active_workers ?? 0}</p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl p-4">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">贡献请求速率 (req/min)</p>
        <RateChart data={chartData} />
      </div>

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">最近结算</h2>
        {settlements.length === 0 ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">暂无结算记录</p>
        ) : (
          <div className="space-y-2">
            {settlements.map((s) => (
              <div key={s.id ?? s.period_end}
                className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 grid grid-cols-5 gap-2 text-sm items-center">
                <span className="text-gray-500 dark:text-gray-400 text-xs">{s.period_end?.slice(0, 16)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.output_tokens ?? 0).toLocaleString()} tok</span>
                <span className="text-yellow-500 dark:text-yellow-400 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                <span className="text-gray-700 dark:text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-600 dark:text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">Agent 日志</h2>
        <div ref={logRef}
          className="bg-gray-100 dark:bg-gray-900 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
          {logs.length === 0
            ? <span className="text-gray-400 dark:text-gray-600">（日志为空）</span>
            : logs.map((line, i) => <div key={i}>{line}</div>)
          }
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Update Network.jsx — replace dark-only classes**

Full replacement for `client/src/pages/Network.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import { getNetwork } from '../api/client';

function starsStr(n) {
  const clamped = Math.max(0, Math.min(5, n ?? 0));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

export default function Network() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function fetch_() {
      getNetwork()
        .then((r) => setData(r.data))
        .catch(() => { setData(null); })
        .finally(() => setLoading(false));
    }
    fetch_();
    const id = setInterval(fetch_, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">全球网络</h1>

      {loading ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm">加载中…</p>
      ) : !data ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm">无法连接到服务器</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">在线节点</p>
              <p className="text-3xl font-bold text-green-600 dark:text-green-400">{data.summary.online_workers}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">活跃用户</p>
              <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">{data.summary.active_users}</p>
            </div>
          </div>

          <section>
            <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">在线节点</h2>
            {data.workers.length === 0 ? (
              <p className="text-gray-400 dark:text-gray-500 text-sm">暂无在线节点</p>
            ) : (
              <div className="space-y-2">
                {data.workers.map((w) => (
                  <div key={w.worker_id ?? w.name}
                    className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-xl px-4 py-3 grid grid-cols-4 gap-3 items-center text-sm">
                    <div className="min-w-0">
                      <p className="text-gray-900 dark:text-gray-100 font-medium truncate">{w.name}</p>
                      <p className="text-gray-400 dark:text-gray-500 text-xs">{Math.round(w.online_mins ?? 0)} min</p>
                    </div>
                    <p className="text-gray-500 dark:text-gray-400 text-xs truncate">{(w.models ?? []).join(', ')}</p>
                    <p className="text-yellow-500 dark:text-yellow-400 text-xs">{starsStr(w.stars)}</p>
                    <div className="text-right">
                      <p className="text-gray-700 dark:text-gray-300">{(w.period_tokens ?? 0).toLocaleString()} tok</p>
                      <p className="text-gray-400 dark:text-gray-500 text-xs">{w.avg_latency_ms ?? 0} ms</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npx vite build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Profile.jsx client/src/pages/Agent.jsx client/src/pages/Network.jsx
git commit -m "feat: apply light/dark theme variants to Profile, Agent, Network pages"
```

---

## Task 5: Theme Config page + add theme selector

**Files:**
- Modify: `client/src/pages/Config.jsx`

- [ ] **Step 1: Read current Config.jsx**

Read `client/src/pages/Config.jsx` to understand full current content before editing.

- [ ] **Step 2: Update Field component dark classes in Config.jsx**

Replace the `Field` function:

```jsx
function Field({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-sm text-gray-500 dark:text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}
```

- [ ] **Step 3: Update Config page container and section headings**

Replace the outer `<div className="max-w-lg mx-auto p-8 space-y-8">` and all `<h1>`, `<h2>` classes:

- `text-gray-100` → `text-gray-900 dark:text-gray-100`
- `text-gray-300` → `text-gray-700 dark:text-gray-300`
- `bg-gray-800` (login card) → `bg-gray-100 dark:bg-gray-800`
- `text-gray-100 font-medium` (name) → `text-gray-900 dark:text-gray-100 font-medium`
- `text-gray-400 text-sm` (email) → `text-gray-500 dark:text-gray-400 text-sm`
- `border-gray-700` → `border-gray-200 dark:border-gray-700`

Full replacement for the return JSX of `Config`:

```jsx
  return (
    <div className="max-w-lg mx-auto p-8 space-y-8">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">设置</h1>

      {/* Server URL */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">服务器</h2>
        <Field
          label="服务端地址 (HTTP/HTTPS)"
          value={serverUrl}
          onChange={setServerUrl}
          placeholder="http://your-vps:8000"
        />
      </section>

      {/* Account */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">账户</h2>
        {user ? (
          <div className="flex items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl p-4">
            <div>
              <p className="text-gray-900 dark:text-gray-100 font-medium">{user.nickname}</p>
              <p className="text-gray-500 dark:text-gray-400 text-sm">{user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-sm text-white transition-colors"
            >
              退出登录
            </button>
          </div>
        ) : (
          <form onSubmit={handleLogin} className="space-y-3">
            <Field label="邮箱" type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            <Field label="密码" type="password" value={password} onChange={setPassword} placeholder="••••••" />
            {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors"
            >
              {saving ? '登录中…' : '登录'}
            </button>
          </form>
        )}
      </section>

      {/* Agent config */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">Agent 配置（贡献者）</h2>
        <Field label="本地 LLM 地址" value={llmUrl} onChange={setLlmUrl} placeholder="http://localhost:11434" />
        <Field label="LLM Token（可选）" type="password" value={llmToken} onChange={setLlmToken} placeholder="无则留空" />
        <Field label="支持的模型（逗号分隔）" value={models} onChange={setModels} placeholder="qwen3-32b,qwen3-7b" />
        <Field label="节点名称" value={nodeName} onChange={setNodeName} placeholder="留空使用主机名" />
        <button
          onClick={handleSaveAgentConfig}
          className="w-full py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg text-sm font-medium text-gray-900 dark:text-gray-100 transition-colors"
        >
          保存 Agent 配置
        </button>
      </section>

      {/* Theme */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">外观</h2>
        <ThemeSelector />
      </section>
    </div>
  );
```

- [ ] **Step 4: Add ThemeSelector component and import useTheme**

Add import at the top of Config.jsx:
```jsx
import { useTheme } from '../store/theme';
```

Add the `ThemeSelector` component before the `Config` export:

```jsx
function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const options = [
    { value: 'light', label: '浅色' },
    { value: 'system', label: '跟随系统' },
    { value: 'dark', label: '深色' },
  ];
  return (
    <div className="flex gap-2">
      {options.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={
            'flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ' +
            (theme === value
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'bg-transparent border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800')
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npx vite build 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Config.jsx
git commit -m "feat: theme Config page and add light/dark/system theme selector"
```

---

## Task 6: Debug page

**Files:**
- Create: `client/src/pages/Debug.jsx`

The page:
- Source toggle: `local` (reads `~/.llm-agent/config.json` via IPC) or `network` (uses `serverUrl` + user token)
- Model dropdown: fetched from `GET /v1/models` of selected source on mount and on source change
- System prompt textarea (collapsible, default collapsed)
- User message textarea
- Stream toggle (default on)
- Send button
- Response area: streams tokens via Fetch API SSE parsing
- Footer: shows first-token latency and total time after completion

- [ ] **Step 1: Create `client/src/pages/Debug.jsx`**

```jsx
import React, { useState, useEffect, useRef } from 'react';

function fetchModels(source, localCfg) {
  if (source === 'local') {
    if (!localCfg?.llm_base_url) return Promise.resolve([]);
    const headers = {};
    if (localCfg.llm_token) headers['Authorization'] = `Bearer ${localCfg.llm_token}`;
    return fetch(`${localCfg.llm_base_url}/v1/models`, { headers })
      .then((r) => r.json())
      .then((d) => (d.data || []).map((m) => m.id))
      .catch(() => []);
  } else {
    const serverUrl = localStorage.getItem('serverUrl') || 'http://localhost:8000';
    const token = localStorage.getItem('token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return fetch(`${serverUrl}/v1/models`, { headers })
      .then((r) => r.json())
      .then((d) => (d.data || []).map((m) => m.id))
      .catch(() => []);
  }
}

async function streamChat({ source, localCfg, model, systemPrompt, userMessage, stream, onChunk, onDone, onError }) {
  let baseUrl, headers;
  if (source === 'local') {
    baseUrl = localCfg?.llm_base_url || '';
    headers = { 'Content-Type': 'application/json' };
    if (localCfg?.llm_token) headers['Authorization'] = `Bearer ${localCfg.llm_token}`;
  } else {
    baseUrl = localStorage.getItem('serverUrl') || 'http://localhost:8000';
    headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const messages = [];
  if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
  messages.push({ role: 'user', content: userMessage });

  const startTime = Date.now();
  let firstTokenTime = null;

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      onError(`HTTP ${resp.status}: ${errText}`);
      return;
    }

    if (!stream) {
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      onChunk(content);
      onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const d = JSON.parse(trimmed.slice(6));
            const delta = d.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              if (firstTokenTime === null) firstTokenTime = Date.now();
              onChunk(delta);
            }
          } catch {}
        }
      }
    }
    onDone({
      firstTokenMs: firstTokenTime ? firstTokenTime - startTime : null,
      totalMs: Date.now() - startTime,
    });
  } catch (e) {
    onError(e.message);
  }
}

export default function Debug() {
  const [source, setSource] = useState('local');
  const [localCfg, setLocalCfg] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [userMessage, setUserMessage] = useState('');
  const [streamMode, setStreamMode] = useState(true);
  const [response, setResponse] = useState('');
  const [sending, setSending] = useState(false);
  const [timing, setTiming] = useState(null);
  const [error, setError] = useState('');
  const responseRef = useRef(null);

  // Load local config once
  useEffect(() => {
    window.electronAPI?.config.read().then((cfg) => setLocalCfg(cfg));
  }, []);

  // Fetch models when source or localCfg changes
  useEffect(() => {
    setModels([]);
    setModel('');
    fetchModels(source, localCfg).then((list) => {
      setModels(list);
      if (list.length > 0) setModel(list[0]);
    });
  }, [source, localCfg]);

  // Auto-scroll response
  useEffect(() => {
    if (responseRef.current) responseRef.current.scrollTop = responseRef.current.scrollHeight;
  }, [response]);

  async function handleSend() {
    if (!userMessage.trim() || !model) return;
    setSending(true);
    setResponse('');
    setTiming(null);
    setError('');

    await streamChat({
      source, localCfg, model,
      systemPrompt, userMessage, stream: streamMode,
      onChunk: (delta) => setResponse((prev) => prev + delta),
      onDone: (t) => { setTiming(t); setSending(false); },
      onError: (msg) => { setError(msg); setSending(false); },
    });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend();
  }

  return (
    <div className="p-8 space-y-5 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">调试</h1>

      {/* Source + Model row */}
      <div className="flex gap-3 items-end">
        <div className="space-y-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">来源</label>
          <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
            {[{ v: 'local', l: '本地 LLM' }, { v: 'network', l: '全球网络' }].map(({ v, l }) => (
              <button key={v} onClick={() => setSource(v)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  source === v
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 space-y-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">模型</label>
          {models.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500">
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <div className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400">
              {source === 'local' && !localCfg?.llm_base_url ? '请先配置本地 LLM 地址' : '加载中…'}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-2 cursor-pointer select-none">
          <input type="checkbox" checked={streamMode} onChange={(e) => setStreamMode(e.target.checked)}
            className="w-4 h-4 accent-blue-600" />
          流式
        </label>
      </div>

      {/* System prompt (collapsible) */}
      <div className="space-y-1">
        <button onClick={() => setShowSystem((v) => !v)}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1">
          {showSystem ? '▼' : '▶'} System Prompt（可选）
        </button>
        {showSystem && (
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3} placeholder="你是一个有帮助的助手…"
            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-none" />
        )}
      </div>

      {/* User message */}
      <div className="space-y-1">
        <label className="text-xs text-gray-500 dark:text-gray-400">消息 (Cmd+Enter 发送)</label>
        <textarea value={userMessage} onChange={(e) => setUserMessage(e.target.value)} onKeyDown={handleKeyDown}
          rows={4} placeholder="输入测试消息…"
          className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-none" />
      </div>

      <button onClick={handleSend} disabled={sending || !userMessage.trim() || !model}
        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors">
        {sending ? '发送中…' : '发送'}
      </button>

      {/* Response */}
      {(response || error || sending) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-500 dark:text-gray-400">响应</label>
            {timing && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {timing.firstTokenMs != null ? `首 token ${timing.firstTokenMs} ms · ` : ''}
                总计 {timing.totalMs} ms
              </span>
            )}
          </div>
          {error ? (
            <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-xl p-4 text-sm text-red-600 dark:text-red-400">{error}</div>
          ) : (
            <div ref={responseRef}
              className="bg-gray-100 dark:bg-gray-900 rounded-xl p-4 text-sm text-gray-900 dark:text-gray-100 font-mono whitespace-pre-wrap min-h-[80px] max-h-96 overflow-y-auto">
              {response}
              {sending && <span className="animate-pulse text-blue-500">▊</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npx vite build 2>&1 | tail -5
```

Expected: `✓ built in`

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Debug.jsx
git commit -m "feat: add Debug page with local LLM and global network API testing"
```

---

## Self-Review

### 1. Spec coverage

| Requirement | Task |
|---|---|
| Light/dark/system theme | Task 1 (ThemeContext) + Task 5 (selector) |
| Tailwind class dark mode | Task 1 |
| System preference listener | Task 1 |
| Theme persisted in localStorage | Task 1 |
| Theme selector in Config | Task 5 |
| All pages themed | Tasks 3, 4, 5 |
| Debug page with source picker | Task 6 |
| Model dropdown from /v1/models | Task 6 |
| System prompt (collapsible) | Task 6 |
| Stream toggle | Task 6 |
| Streaming response with SSE parsing | Task 6 |
| First-token latency + total time | Task 6 |
| Debug nav item in Sidebar | Task 3 |

### 2. Placeholder scan

No TBD/TODO/placeholder content — all code blocks are complete and runnable.

### 3. Type consistency

- `useTheme()` defined Task 1, used Task 5 ✓
- `ThemeProvider` defined Task 1, used Task 2 ✓
- `localCfg.llm_base_url` / `localCfg.llm_token` — read from IPC, matches `~/.llm-agent/config.json` schema ✓
- `window.electronAPI.config.read()` — defined in preload.js, called in Task 6 ✓
- `streamChat` parameters match call site in `handleSend` ✓

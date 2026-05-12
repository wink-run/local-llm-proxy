# Client App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron + React desktop client (`client/`) that lets users view their credits, manage their local agent, and monitor the global network; plus add two server-side endpoints (`/user/stats`, `/public/network`) that the client depends on.

**Architecture:** Electron main process manages the system tray, agent subprocess lifecycle, and IPC bridge. React + Vite renders the 4-page UI in the renderer process via contextBridge. Auth token and server URL live in `localStorage`; agent config lives at `~/.llm-agent/config.json` (managed by the main process via IPC). The server already exposes `/user/profile`, `/user/transactions`, `/user/settlements`; two new endpoints are needed.

**Tech Stack:** Electron 33, React 18, Vite 5, Tailwind CSS 3, react-router-dom 6, recharts 2, axios 1, electron-store 9, pngjs (dev-only, icon generation), concurrently, wait-on

---

## File Map

**Server additions:**
- Modify: `server/user_router.py` — add `GET /user/stats`
- Modify: `server/server.py` — add `GET /public/network`

**Client (all new, under `client/`):**
- `package.json` — Electron + Vite + React deps, build config
- `vite.config.js` — Vite config (base `./`, port 5173)
- `index.html` — HTML entry
- `tailwind.config.js`, `postcss.config.js` — Tailwind CSS setup
- `scripts/gen-icons.js` — generates `assets/tray-green.png` and `assets/tray-gray.png`
- `electron/main.js` — window, tray, IPC handlers, agent subprocess management
- `electron/preload.js` — contextBridge exposing `window.electronAPI`
- `src/main.jsx` — React entry, mounts `<App />`
- `src/index.css` — Tailwind directives
- `src/App.jsx` — MemoryRouter + AuthProvider + Layout with route guards
- `src/api/client.js` — axios instance (reads serverUrl/token from localStorage) + typed API calls
- `src/store/index.jsx` — AuthContext: user state, loginSuccess, logout, refreshUser
- `src/components/Sidebar.jsx` — icon-based left nav
- `src/components/RateChart.jsx` — recharts LineChart for req/min over time
- `src/pages/Config.jsx` — server URL, login/logout, agent config fields
- `src/pages/Profile.jsx` — credits balance, stats cards, transaction list
- `src/pages/Agent.jsx` — agent start/stop, live stats, RateChart, settlement history, log tail
- `src/pages/Network.jsx` — global summary + online worker table

---

## Task 1: Server — Add /user/stats and /public/network

**Files:**
- Modify: `server/user_router.py`
- Modify: `server/server.py`

- [ ] **Step 1: Add `GET /user/stats` to `server/user_router.py`**

At the bottom of `server/user_router.py`, append:

```python
from worker_pool import pool as _pool


@router.get("/stats")
async def user_stats(uid: int = Depends(get_current_user_id)):
    user_workers = [w for w in _pool.all_workers() if w.user_id == uid]
    total_req = sum(
        sum(s["requests"] for s in w.period_stats.values())
        for w in user_workers
    )
    total_online_mins = max(
        max((w.period_online_mins() for w in user_workers), default=1), 1
    )
    contribute_req_per_min = round(total_req / total_online_mins, 2) if user_workers else 0.0
    return {
        "contribute_req_per_min": contribute_req_per_min,
        "active_workers": len(user_workers),
        "active_requests": sum(w.active_requests for w in user_workers),
    }
```

- [ ] **Step 2: Add `GET /public/network` to `server/server.py`**

In `server/server.py`, after the `workers_wall` function (after line ~167), add:

```python
@app.get("/public/network")
async def public_network():
    """公开：全局运营统计 + 在线 Worker 列表（脱敏）"""
    workers_data = []
    for w in pool.all_workers():
        stats = w.period_stats
        total_req = sum(s["requests"] for s in stats.values())
        total_success = sum(s["success"] for s in stats.values())
        total_ttft = sum(s.get("ttft_sum", 0) for s in stats.values())
        total_ttft_count = sum(s.get("ttft_count", 0) for s in stats.values())
        total_tokens = sum(s["output_tokens"] for s in stats.values())
        avg_ttft_ms = total_ttft / total_ttft_count if total_ttft_count > 0 else 0
        success_rate = total_success / total_req if total_req > 0 else 1.0
        online_mins = w.period_online_mins()

        multiplier = 1.0
        if total_req > 0:
            online_f = min(0.5 + 0.8 * min(online_mins / 5, 1.0), 1.3)
            latency_f = max(0.6, min(1.5, 500 / avg_ttft_ms)) if avg_ttft_ms > 0 else 1.0
            stability_f = 0.5 + 0.7 * success_rate
            multiplier = round(
                max(0.5, min(1.5, 0.4 * online_f + 0.4 * latency_f + 0.2 * stability_f)), 3
            )

        workers_data.append({
            "worker_id": w.worker_id,
            "name": _mask_name(w.name),
            "models": w.models,
            "active_requests": w.active_requests,
            "period_tokens": total_tokens,
            "avg_latency_ms": round(avg_ttft_ms),
            "multiplier": multiplier,
            "stars": _stars(multiplier),
            "online_mins": round(online_mins, 1),
            "connected_at": w.connected_at.isoformat(),
        })

    distinct_users = len({w.user_id for w in pool.all_workers() if w.user_id})
    return {
        "summary": {
            "online_workers": len(workers_data),
            "active_users": distinct_users,
        },
        "workers": workers_data,
    }
```

- [ ] **Step 3: Verify endpoints (requires server running)**

```bash
# Restart server, then:
curl http://localhost:8000/public/network
# Expected: {"summary":{"online_workers":0,"active_users":0},"workers":[]}

# For /user/stats — get a token first:
TOKEN=$(curl -s -X POST http://localhost:8000/user/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpass"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/user/stats
# Expected: {"contribute_req_per_min":0.0,"active_workers":0,"active_requests":0}
```

- [ ] **Step 4: Commit**

```bash
git add server/user_router.py server/server.py
git commit -m "feat: add /user/stats and /public/network endpoints for desktop client"
```

---

## Task 2: Client project scaffold

**Files:**
- Create: `client/package.json`
- Create: `client/vite.config.js`
- Create: `client/index.html`
- Create: `client/tailwind.config.js`
- Create: `client/postcss.config.js`
- Create: `client/src/main.jsx`
- Create: `client/src/index.css`
- Create: `client/scripts/gen-icons.js`
- Create: `client/.gitignore`

- [ ] **Step 1: Create `client/package.json`**

```json
{
  "name": "llm-proxy-client",
  "version": "1.0.0",
  "private": true,
  "main": "electron/main.js",
  "scripts": {
    "dev": "concurrently \"vite\" \"wait-on http://localhost:5173 && electron .\"",
    "build": "vite build && electron-builder",
    "gen-icons": "node scripts/gen-icons.js"
  },
  "dependencies": {
    "axios": "^1.7.2",
    "electron-store": "^9.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.25.1",
    "recharts": "^2.12.7"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "concurrently": "^8.2.2",
    "electron": "^33.0.0",
    "electron-builder": "^25.0.5",
    "pngjs": "^7.0.0",
    "postcss": "^8.4.41",
    "tailwindcss": "^3.4.10",
    "vite": "^5.4.1",
    "wait-on": "^7.2.0"
  },
  "build": {
    "appId": "com.local-llm-proxy.client",
    "productName": "LLM Proxy",
    "directories": { "output": "dist-app" },
    "files": ["dist/**/*", "electron/**/*", "assets/**/*"],
    "extraResources": [
      { "from": "../agent/dist/llm-agent", "to": "llm-agent", "filter": ["**/*"] }
    ],
    "mac": { "target": "dmg" },
    "win": { "target": "nsis" },
    "linux": { "target": "AppImage" }
  }
}
```

- [ ] **Step 2: Create `client/vite.config.js`**

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: { port: 5173 },
});
```

- [ ] **Step 3: Create `client/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LLM Proxy</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `client/tailwind.config.js`**

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

- [ ] **Step 5: Create `client/postcss.config.js`**

```javascript
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 6: Create `client/src/main.jsx`**

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')).render(<App />);
```

- [ ] **Step 7: Create `client/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

* { box-sizing: border-box; }
```

- [ ] **Step 8: Create `client/scripts/gen-icons.js`**

```javascript
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

function makeCirclePNG(r, g, b, size = 16) {
  const png = new PNG({ width: size, height: size, filterType: -1 });
  const cx = size / 2, cy = size / 2, radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= radius) {
        png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = 255;
      } else {
        png.data[idx] = png.data[idx + 1] = png.data[idx + 2] = png.data[idx + 3] = 0;
      }
    }
  }
  return PNG.sync.write(png);
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'tray-green.png'), makeCirclePNG(34, 197, 94));
fs.writeFileSync(path.join(assetsDir, 'tray-gray.png'), makeCirclePNG(107, 114, 128));
console.log('Icons generated in assets/');
```

- [ ] **Step 9: Create `client/.gitignore`**

```
node_modules/
dist/
dist-app/
assets/
```

- [ ] **Step 10: Install dependencies and generate icons**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm install
node scripts/gen-icons.js
```

Expected output: `Icons generated in assets/`
Expected files: `assets/tray-green.png`, `assets/tray-gray.png`

- [ ] **Step 11: Commit scaffold**

```bash
git add client/
git commit -m "feat: scaffold Electron client project with Vite + React + Tailwind"
```

---

## Task 3: Electron main process

**Files:**
- Create: `client/electron/main.js`

- [ ] **Step 1: Create `client/electron/main.js`**

```javascript
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const isDev = process.env.NODE_ENV !== 'production';
const VITE_URL = 'http://localhost:5173';
const AGENT_CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'config.json');

let mainWindow = null;
let tray = null;
let agentProcess = null;

// ── Icons ──────────────────────────────────────────────────────────────────────

function getTrayIcon(state) {
  const name = state === 'running' ? 'tray-green.png' : 'tray-gray.png';
  const iconPath = path.join(__dirname, '..', 'assets', name);
  if (!fs.existsSync(iconPath)) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(false);
  return img;
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL(VITE_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    // On macOS, hide instead of quit when clicking the red X
    if (process.platform === 'darwin') {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(getTrayIcon('stopped'));
  tray.setToolTip('LLM Proxy');
  updateTrayMenu();
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function updateTrayMenu() {
  const running = agentProcess !== null;
  const menu = Menu.buildFromTemplate([
    { label: running ? 'Agent 运行中' : 'Agent 已停止', enabled: false },
    { type: 'separator' },
    { label: '启动 Agent', enabled: !running, click: startAgent },
    { label: '停止 Agent', enabled: running, click: stopAgent },
    { type: 'separator' },
    { label: '打开主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setImage(getTrayIcon(running ? 'running' : 'stopped'));
}

// ── Agent subprocess ──────────────────────────────────────────────────────────

function getAgentCmd() {
  if (isDev) {
    // In dev, run the Python agent directly
    const agentScript = path.join(__dirname, '..', '..', 'agent', 'agent.py');
    return { cmd: 'python3', extraArgs: [agentScript] };
  }
  // In production, use the bundled binary placed by electron-builder extraResources
  const ext = process.platform === 'win32' ? '.exe' : '';
  return { cmd: path.join(process.resourcesPath, `llm-agent${ext}`), extraArgs: [] };
}

function startAgent() {
  if (agentProcess) return;
  if (!fs.existsSync(AGENT_CONFIG_PATH)) {
    mainWindow?.webContents.send('agent:status', { running: false, error: 'config missing — save Agent config first' });
    return;
  }
  const { cmd, extraArgs } = getAgentCmd();
  const args = [...extraArgs, 'start', '--config', AGENT_CONFIG_PATH];
  agentProcess = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  agentProcess.stdout.on('data', (d) => mainWindow?.webContents.send('agent:log', d.toString()));
  agentProcess.stderr.on('data', (d) => mainWindow?.webContents.send('agent:log', d.toString()));
  agentProcess.on('exit', () => {
    agentProcess = null;
    mainWindow?.webContents.send('agent:status', { running: false });
    updateTrayMenu();
  });

  mainWindow?.webContents.send('agent:status', { running: true });
  updateTrayMenu();
}

function stopAgent() {
  if (!agentProcess) return;
  agentProcess.kill('SIGTERM');
  agentProcess = null;
  mainWindow?.webContents.send('agent:status', { running: false });
  updateTrayMenu();
}

// ── Agent config helpers ──────────────────────────────────────────────────────

function readAgentConfig() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writeAgentConfig(cfg) {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIPC() {
  ipcMain.handle('agent:start', () => { startAgent(); return { running: !!agentProcess }; });
  ipcMain.handle('agent:stop', () => { stopAgent(); return { running: false }; });
  ipcMain.handle('agent:status', () => ({ running: !!agentProcess }));
  ipcMain.handle('config:read', () => readAgentConfig());
  ipcMain.handle('config:write', (_e, cfg) => { writeAgentConfig(cfg); return { ok: true }; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerIPC();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else { mainWindow?.show(); }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (agentProcess) agentProcess.kill('SIGTERM');
});
```

- [ ] **Step 2: Verify syntax**

```bash
node --check /Users/ully/githubprojects/local-llm-proxy/client/electron/main.js
```

Expected: no output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add client/electron/main.js
git commit -m "feat: add Electron main process — window, tray, IPC, agent subprocess"
```

---

## Task 4: Preload script + API client + Auth store

**Files:**
- Create: `client/electron/preload.js`
- Create: `client/src/api/client.js`
- Create: `client/src/store/index.jsx`

- [ ] **Step 1: Create `client/electron/preload.js`**

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  agent: {
    start: () => ipcRenderer.invoke('agent:start'),
    stop: () => ipcRenderer.invoke('agent:stop'),
    getStatus: () => ipcRenderer.invoke('agent:status'),
    onStatus: (cb) => ipcRenderer.on('agent:status', (_e, data) => cb(data)),
    onLog: (cb) => ipcRenderer.on('agent:log', (_e, line) => cb(line)),
  },
  config: {
    read: () => ipcRenderer.invoke('config:read'),
    write: (cfg) => ipcRenderer.invoke('config:write', cfg),
  },
});
```

- [ ] **Step 2: Create `client/src/api/client.js`**

```javascript
import axios from 'axios';

const http = axios.create({ timeout: 10000 });

// Read serverUrl and token from localStorage on every request
http.interceptors.request.use((config) => {
  const base = localStorage.getItem('serverUrl') || 'http://localhost:8000';
  config.baseURL = base;
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export function login(email, password) {
  return http.post('/user/login', { email, password });
}

export function getProfile() {
  return http.get('/user/profile');
}

export function getStats() {
  return http.get('/user/stats');
}

export function getTransactions() {
  return http.get('/user/transactions');
}

export function getSettlements() {
  return http.get('/user/settlements');
}

export function getNetwork() {
  return http.get('/public/network');
}
```

- [ ] **Step 3: Create `client/src/store/index.jsx`**

```jsx
import React, { createContext, useContext, useState, useEffect } from 'react';
import { getProfile } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    getProfile()
      .then((r) => setUser(r.data))
      .catch(() => { localStorage.removeItem('token'); })
      .finally(() => setLoading(false));
  }, []);

  function loginSuccess(token, userData) {
    localStorage.setItem('token', token);
    setUser(userData);
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
  }

  function refreshUser() {
    return getProfile().then((r) => setUser(r.data));
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginSuccess, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
```

- [ ] **Step 4: Verify preload syntax**

```bash
node --check /Users/ully/githubprojects/local-llm-proxy/client/electron/preload.js
```

Expected: no output

- [ ] **Step 5: Commit**

```bash
git add client/electron/preload.js client/src/api/client.js client/src/store/index.jsx
git commit -m "feat: add preload contextBridge, axios API client, and AuthContext store"
```

---

## Task 5: App shell + Sidebar

**Files:**
- Create: `client/src/App.jsx`
- Create: `client/src/components/Sidebar.jsx`

- [ ] **Step 1: Create `client/src/App.jsx`**

```jsx
import React from 'react';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import Sidebar from './components/Sidebar';
import Profile from './pages/Profile';
import Agent from './pages/Agent';
import Network from './pages/Network';
import Config from './pages/Config';

function Layout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
        加载中…
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {user && <Sidebar />}
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={user ? <Profile /> : <Navigate to="/config" replace />} />
          <Route path="/agent" element={user ? <Agent /> : <Navigate to="/config" replace />} />
          <Route path="/network" element={<Network />} />
          <Route path="/config" element={<Config />} />
          <Route path="*" element={<Navigate to={user ? '/' : '/config'} replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <MemoryRouter>
      <AuthProvider>
        <Layout />
      </AuthProvider>
    </MemoryRouter>
  );
}
```

- [ ] **Step 2: Create `client/src/components/Sidebar.jsx`**

```jsx
import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../store/index';

const NAV = [
  { to: '/', icon: '👤', label: '我的账户' },
  { to: '/agent', icon: '⚙️', label: 'Agent' },
  { to: '/network', icon: '🌐', label: '网络' },
  { to: '/config', icon: '🔧', label: '设置' },
];

export default function Sidebar() {
  const { user } = useAuth();
  return (
    <aside className="w-16 flex flex-col items-center py-6 bg-gray-900 border-r border-gray-800 gap-2 shrink-0">
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
              : 'text-gray-400 hover:bg-gray-800 hover:text-white')
          }
        >
          {icon}
        </NavLink>
      ))}
      <div className="mt-auto text-xs text-gray-600 text-center leading-tight px-1 truncate w-full">
        {user?.nickname}
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/App.jsx client/src/components/Sidebar.jsx
git commit -m "feat: add App shell with route guards and icon-based Sidebar"
```

---

## Task 6: Config page

**Files:**
- Create: `client/src/pages/Config.jsx`

- [ ] **Step 1: Create `client/src/pages/Config.jsx`**

```jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, getProfile } from '../api/client';
import { useAuth } from '../store/index';

function Field({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}

export default function Config() {
  const { user, loginSuccess, logout } = useAuth();
  const navigate = useNavigate();

  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem('serverUrl') || 'http://localhost:8000'
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [llmUrl, setLlmUrl] = useState('');
  const [llmToken, setLlmToken] = useState('');
  const [models, setModels] = useState('');
  const [nodeName, setNodeName] = useState('');

  // Load existing agent config into form fields
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.config.read().then((cfg) => {
      if (!cfg) return;
      setLlmUrl(cfg.llm_base_url || '');
      setLlmToken(cfg.llm_token || '');
      setModels((cfg.models || []).join(', '));
      setNodeName(cfg.name || '');
    });
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      localStorage.setItem('serverUrl', serverUrl);
      const res = await login(email, password);
      const { token } = res.data;
      // Set token before calling getProfile so the interceptor picks it up
      localStorage.setItem('token', token);
      const profileRes = await getProfile();
      loginSuccess(token, profileRes.data);

      // Write worker_key + agent config to ~/.llm-agent/config.json
      if (window.electronAPI) {
        const current = (await window.electronAPI.config.read()) || {};
        const wsUrl = serverUrl.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
        await window.electronAPI.config.write({
          ...current,
          server_url: wsUrl,
          worker_key: profileRes.data.worker_key || '',
          llm_base_url: llmUrl || current.llm_base_url || '',
          llm_token: llmToken !== '' ? llmToken : (current.llm_token || ''),
          models: models
            ? models.split(',').map((m) => m.trim()).filter(Boolean)
            : (current.models || []),
          name: nodeName || current.name || '',
        });
      }

      navigate('/');
    } catch (err) {
      localStorage.removeItem('token');
      setError(err.response?.data?.detail || '登录失败，请检查邮箱和密码');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAgentConfig() {
    if (!window.electronAPI) { alert('仅在 Electron 环境下可保存 Agent 配置'); return; }
    const current = (await window.electronAPI.config.read()) || {};
    const wsUrl = serverUrl.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
    await window.electronAPI.config.write({
      ...current,
      server_url: wsUrl,
      llm_base_url: llmUrl,
      llm_token: llmToken,
      models: models.split(',').map((m) => m.trim()).filter(Boolean),
      name: nodeName,
    });
    localStorage.setItem('serverUrl', serverUrl);
    alert('Agent 配置已保存');
  }

  function handleLogout() {
    logout();
    navigate('/config');
  }

  return (
    <div className="max-w-lg mx-auto p-8 space-y-8">
      <h1 className="text-2xl font-bold text-gray-100">设置</h1>

      {/* Server URL */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-300">服务器</h2>
        <Field
          label="服务端地址 (HTTP/HTTPS)"
          value={serverUrl}
          onChange={setServerUrl}
          placeholder="http://your-vps:8000"
        />
      </section>

      {/* Account */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-300">账户</h2>
        {user ? (
          <div className="flex items-center justify-between bg-gray-800 rounded-xl p-4">
            <div>
              <p className="text-gray-100 font-medium">{user.nickname}</p>
              <p className="text-gray-400 text-sm">{user.email}</p>
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
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {saving ? '登录中…' : '登录'}
            </button>
          </form>
        )}
      </section>

      {/* Agent config */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-300">Agent 配置（贡献者）</h2>
        <Field
          label="本地 LLM 地址"
          value={llmUrl}
          onChange={setLlmUrl}
          placeholder="http://localhost:11434"
        />
        <Field
          label="LLM Token（可选）"
          type="password"
          value={llmToken}
          onChange={setLlmToken}
          placeholder="无则留空"
        />
        <Field
          label="支持的模型（逗号分隔）"
          value={models}
          onChange={setModels}
          placeholder="qwen3-32b,qwen3-7b"
        />
        <Field
          label="节点名称"
          value={nodeName}
          onChange={setNodeName}
          placeholder="留空使用主机名"
        />
        <button
          onClick={handleSaveAgentConfig}
          className="w-full py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors"
        >
          保存 Agent 配置
        </button>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/Config.jsx
git commit -m "feat: add Config page with server URL, login/logout, and agent config form"
```

---

## Task 7: Profile page

**Files:**
- Create: `client/src/pages/Profile.jsx`

- [ ] **Step 1: Create `client/src/pages/Profile.jsx`**

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
    <div className="bg-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-100">{value}</p>
    </div>
  );
}

export default function Profile() {
  const { user, refreshUser } = useAuth();
  const [txs, setTxs] = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(true);

  useEffect(() => {
    refreshUser();
    getTransactions()
      .then((r) => setTxs(r.data.transactions || []))
      .catch(() => {})
      .finally(() => setLoadingTxs(false));
  }, []);

  if (!user) return null;

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-blue-700 flex items-center justify-center text-2xl font-bold shrink-0">
          {(user.nickname || user.email)[0].toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-xl font-bold text-gray-100 truncate">{user.nickname}</p>
          <p className="text-sm text-gray-400 truncate">{user.email}</p>
        </div>
      </div>

      {/* Balance */}
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 rounded-2xl p-6">
        <p className="text-sm text-blue-300 mb-1">积分余额</p>
        <p className="text-5xl font-bold text-white">
          {Math.floor(user.credits_balance).toLocaleString()}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="累计贡献积分" value={Math.floor(user.credits_earned).toLocaleString()} />
        <StatCard label="累计消耗积分" value={Math.floor(user.credits_spent).toLocaleString()} />
      </div>

      {/* Transaction list */}
      <section>
        <h2 className="text-lg font-semibold text-gray-300 mb-3">积分流水</h2>
        {loadingTxs ? (
          <p className="text-gray-500 text-sm">加载中…</p>
        ) : txs.length === 0 ? (
          <p className="text-gray-500 text-sm">暂无记录</p>
        ) : (
          <div className="space-y-2">
            {txs.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-3"
              >
                <div>
                  <p className="text-sm text-gray-300">
                    {TX_LABEL[tx.type] || tx.type}
                    {tx.model_name ? ` · ${tx.model_name}` : ''}
                  </p>
                  <p className="text-xs text-gray-500">{tx.created_at?.slice(0, 16)}</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-medium ${tx.delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {tx.delta >= 0 ? '+' : ''}{tx.delta.toFixed(1)}
                  </p>
                  <p className="text-xs text-gray-500">余额 {tx.balance.toFixed(1)}</p>
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

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/Profile.jsx
git commit -m "feat: add Profile page with credits balance and transaction history"
```

---

## Task 8: Agent page + RateChart component

**Files:**
- Create: `client/src/components/RateChart.jsx`
- Create: `client/src/pages/Agent.jsx`

- [ ] **Step 1: Create `client/src/components/RateChart.jsx`**

```jsx
import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// data: Array of { time: string, value: number }
export default function RateChart({ data }) {
  return (
    <ResponsiveContainer width="100%" height={140}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 10 }} />
        <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
        <Tooltip
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#9ca3af' }}
          itemStyle={{ color: '#60a5fa' }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={false}
          name="req/min"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Create `client/src/pages/Agent.jsx`**

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

  // Subscribe to agent status + log events from Electron main process
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.agent.getStatus().then(({ running: r }) => setRunning(r));
    window.electronAPI.agent.onStatus(({ running: r }) => setRunning(r));
    window.electronAPI.agent.onLog((line) =>
      setLogs((prev) => [...prev.slice(-99), line.trimEnd()])
    );
  }, []);

  // Auto-scroll log tail
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Poll /user/stats every 15 s; append point to chart (keep last 30 points)
  useEffect(() => {
    function poll() {
      getStats()
        .then((r) => {
          setStats(r.data);
          const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          setChartData((prev) => [
            ...prev.slice(-29),
            { time: t, value: r.data.contribute_req_per_min },
          ]);
        })
        .catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  // Load recent settlements once
  useEffect(() => {
    getSettlements()
      .then((r) => setSettlements((r.data.settlements || []).slice(0, 10)))
      .catch(() => {});
  }, []);

  const handleStart = async () => window.electronAPI?.agent.start();
  const handleStop = async () => window.electronAPI?.agent.stop();

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Agent</h1>

      {/* Status + controls */}
      <div className="bg-gray-800 rounded-2xl p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${
              running ? 'bg-green-400 animate-pulse' : 'bg-gray-600'
            }`}
          />
          <span className="text-lg font-medium text-gray-200">
            {running ? '运行中' : '已停止'}
          </span>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleStart}
            disabled={running}
            className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
          >
            启动
          </button>
          <button
            onClick={handleStop}
            disabled={!running}
            className="px-5 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
          >
            停止
          </button>
        </div>
      </div>

      {/* Live stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">贡献速率</p>
            <p className="text-2xl font-bold text-blue-400">{stats.contribute_req_per_min}</p>
            <p className="text-xs text-gray-500">req/min</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">活跃请求</p>
            <p className="text-2xl font-bold text-gray-100">{stats.active_requests}</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">在线节点</p>
            <p className="text-2xl font-bold text-gray-100">{stats.active_workers}</p>
          </div>
        </div>
      )}

      {/* Rate chart */}
      <div className="bg-gray-800 rounded-2xl p-4">
        <p className="text-sm text-gray-400 mb-2">贡献请求速率 (req/min)</p>
        <RateChart data={chartData} />
      </div>

      {/* Settlement history */}
      <section>
        <h2 className="text-lg font-semibold text-gray-300 mb-3">最近结算</h2>
        {settlements.length === 0 ? (
          <p className="text-gray-500 text-sm">暂无结算记录</p>
        ) : (
          <div className="space-y-2">
            {settlements.map((s) => (
              <div
                key={s.id}
                className="bg-gray-800 rounded-xl px-4 py-3 grid grid-cols-5 gap-2 text-sm items-center"
              >
                <span className="text-gray-400 text-xs">{s.period_end?.slice(0, 16)}</span>
                <span className="text-gray-300">{s.output_tokens?.toLocaleString()} tok</span>
                <span className="text-yellow-400 text-xs">{multiplierToStars(s.multiplier ?? 1)}</span>
                <span className="text-gray-300">{(s.multiplier ?? 1).toFixed(2)}×</span>
                <span className="text-green-400 font-medium">+{(s.credits_awarded ?? 0).toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Log output */}
      <section>
        <h2 className="text-lg font-semibold text-gray-300 mb-2">Agent 日志</h2>
        <div
          ref={logRef}
          className="bg-gray-900 rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-gray-400 space-y-0.5"
        >
          {logs.length === 0 ? (
            <span className="text-gray-600">（日志为空）</span>
          ) : (
            logs.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/RateChart.jsx client/src/pages/Agent.jsx
git commit -m "feat: add Agent page with start/stop controls, live rate chart, and settlement history"
```

---

## Task 9: Network page

**Files:**
- Create: `client/src/pages/Network.jsx`

- [ ] **Step 1: Create `client/src/pages/Network.jsx`**

```jsx
import React, { useEffect, useState } from 'react';
import { getNetwork } from '../api/client';

function starsStr(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export default function Network() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function fetch_() {
      getNetwork()
        .then((r) => setData(r.data))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    fetch_();
    const id = setInterval(fetch_, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">全球网络</h1>

      {loading ? (
        <p className="text-gray-500 text-sm">加载中…</p>
      ) : !data ? (
        <p className="text-gray-500 text-sm">无法连接到服务器</p>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">在线节点</p>
              <p className="text-3xl font-bold text-green-400">{data.summary.online_workers}</p>
            </div>
            <div className="bg-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-500 mb-1">活跃用户</p>
              <p className="text-3xl font-bold text-blue-400">{data.summary.active_users}</p>
            </div>
          </div>

          {/* Worker list */}
          <section>
            <h2 className="text-lg font-semibold text-gray-300 mb-3">在线节点</h2>
            {data.workers.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无在线节点</p>
            ) : (
              <div className="space-y-2">
                {data.workers.map((w) => (
                  <div
                    key={w.worker_id}
                    className="bg-gray-800 rounded-xl px-4 py-3 grid grid-cols-4 gap-3 items-center text-sm"
                  >
                    <div className="min-w-0">
                      <p className="text-gray-100 font-medium truncate">{w.name}</p>
                      <p className="text-gray-500 text-xs">{Math.round(w.online_mins)} min</p>
                    </div>
                    <p className="text-gray-400 text-xs truncate">{w.models.join(', ')}</p>
                    <p className="text-yellow-400 text-xs">{starsStr(w.stars)}</p>
                    <div className="text-right">
                      <p className="text-gray-300">{w.period_tokens.toLocaleString()} tok</p>
                      <p className="text-gray-500 text-xs">{w.avg_latency_ms} ms</p>
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

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/Network.jsx
git commit -m "feat: add Network page with global summary and online worker list"
```

---

## Task 10: Integration test + final commit

- [ ] **Step 1: Launch in dev mode**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
NODE_ENV=development npm run dev
```

Expected: Vite starts on port 5173, Electron window opens. No console errors in the renderer (open DevTools with Cmd+Opt+I / F12).

- [ ] **Step 2: Verify Config page login flow**

1. App opens on Config page (not logged in).
2. Fill in server URL + email + password → click 登录.
3. App navigates to Profile page showing credits balance.
4. Sidebar is visible with 4 nav icons.
5. `~/.llm-agent/config.json` now contains `server_url` (ws://...) and `worker_key`.

- [ ] **Step 3: Verify Agent page**

1. Navigate to Agent (⚙️).
2. Click 启动 → button disables, green dot pulses, tray icon turns green.
3. Stats cards appear; chart starts plotting after first poll (15 s).
4. Click 停止 → dot goes gray, tray icon returns to gray.

- [ ] **Step 4: Verify Network page**

1. Navigate to Network (🌐).
2. Summary cards show counts; worker table populated if any workers online.
3. Page refreshes every 30 s automatically.

- [ ] **Step 5: Final commit**

```bash
git add client/
git commit -m "feat: complete Electron client app — Profile, Agent, Network, Config pages"
```

---

## Self-Review

### 1. Spec coverage

| Requirement | Task |
|---|---|
| Electron + React + Vite + Tailwind | Task 2 |
| electron-store (token/serverUrl via localStorage; agent config via IPC) | Tasks 3, 4 |
| child_process.spawn for llm-agent | Task 3 |
| Profile: credits balance, stats cards, transaction list | Task 7 |
| Agent: start/stop, live stats, req/min chart | Task 8 |
| Network: global summary + worker table | Task 9 |
| Config: server URL, login/logout, agent config | Task 6 |
| System tray green/gray icons | Task 3 |
| Tray right-click menu: start/stop/open/quit | Task 3 |
| IPC: agent:start/stop/status/log, config:read/write | Tasks 3, 4 |
| /user/stats server endpoint | Task 1 |
| /public/network server endpoint | Task 1 |
| worker_key auto-written on login | Task 6 |
| http→ws URL conversion for agent config | Task 6 |
| Dev binary path (python3 agent.py) vs prod path | Task 3 |
| First-use flow: Config → login → Profile | Tasks 5, 6 |

### 2. Placeholder scan

- No TBD / TODO / placeholder strings present.
- All code blocks contain complete, runnable code.

### 3. Type consistency

- `stats.contribute_req_per_min` — defined Task 1, read Task 8 ✓
- `stats.active_workers`, `stats.active_requests` — defined Task 1, read Task 8 ✓
- `data.summary.online_workers`, `data.summary.active_users` — defined Task 1, read Task 9 ✓
- `data.workers[].stars`, `data.workers[].period_tokens`, `data.workers[].avg_latency_ms` — defined Task 1, read Task 9 ✓
- `window.electronAPI.agent.{start,stop,getStatus,onStatus,onLog}` — defined Task 4, called Task 8 ✓
- `window.electronAPI.config.{read,write}` — defined Task 4, called Tasks 6, 8 ✓
- `loginSuccess(token, userData)` — defined Task 4 store, called Task 6 ✓
- `refreshUser()` — defined Task 4 store, called Task 7 ✓
- `getStats()`, `getTransactions()`, `getSettlements()`, `getNetwork()` — all defined Task 4 api/client.js, called in respective page tasks ✓

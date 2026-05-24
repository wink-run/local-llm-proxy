# OTA Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add silent background OTA auto-update to the Token Bank Electron app via electron-updater + GitHub Releases, with an in-app banner prompting the user to install when a download is ready.

**Architecture:** `electron-updater` runs in the Electron main process, fires events that are forwarded via IPC to the renderer, and a new `UpdateNotification` React component renders a fixed bottom banner when an update is downloaded. The renderer can trigger `quitAndInstall()` via an IPC call.

**Tech Stack:** electron-updater ^6.8, Electron 33, React 18, Tailwind CSS

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `client/package.json` | Add `electron-updater` dep + `publish` config in `build` |
| Modify | `client/electron/main.js` | Add `setupAutoUpdater()`, call it in `app.whenReady()` |
| Modify | `client/electron/preload.js` | Expose `electronAPI.updater` with 4 methods |
| Create | `client/src/components/UpdateNotification.jsx` | Fixed-bottom banner, state machine idle→downloading→ready→dismissed |
| Modify | `client/src/App.jsx` | Mount `<UpdateNotification />` inside `<Layout />` |

---

## Task 1: Install electron-updater and configure publish

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Install the package**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm install electron-updater@^6.8.3
```

Expected: `package.json` `dependencies` gains `"electron-updater": "^6.8.3"` and `package-lock.json` is updated.

- [ ] **Step 2: Add publish config to the build section**

Open `client/package.json`. In the `"build"` object (currently has `appId`, `productName`, `directories`, `files`, `mac`, `win`, `linux`), add a `"publish"` key **before** `"mac"`:

```json
"publish": {
  "provider": "github",
  "owner": "REPLACE_WITH_YOUR_GITHUB_USERNAME",
  "repo": "local-llm-proxy"
},
```

> Note: Replace `REPLACE_WITH_YOUR_GITHUB_USERNAME` with the actual GitHub account that owns the repo. This must match exactly or `electron-updater` will look for releases in the wrong place.

- [ ] **Step 3: Verify the build section looks correct**

`client/package.json` build section should now be:

```json
"build": {
  "appId": "com.tokenbank.app",
  "productName": "Token Bank",
  "directories": { "output": "dist-app" },
  "files": ["dist/**/*", "electron/**/*"],
  "publish": {
    "provider": "github",
    "owner": "REPLACE_WITH_YOUR_GITHUB_USERNAME",
    "repo": "local-llm-proxy"
  },
  "mac": {
    "icon": "build/icon.icns",
    "target": "dmg",
    "category": "public.app-category.utilities"
  },
  "win": {
    "icon": "build/icon.ico",
    "target": "nsis"
  },
  "linux": {
    "target": "AppImage"
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/package.json client/package-lock.json
git commit -m "feat(updater): install electron-updater, add github publish config"
```

---

## Task 2: Add setupAutoUpdater() to main.js

**Files:**
- Modify: `client/electron/main.js`

- [ ] **Step 1: Add the require at the top of main.js**

After the existing requires (line 1–8 of current `main.js`), add:

```js
const { autoUpdater } = require('electron-updater');
```

The top of the file should now look like:

```js
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const agent = require('./agent-worker');
```

- [ ] **Step 2: Add setupAutoUpdater() function**

Add this function after the `stopAgent()` function (around line 125) and before `// ── Agent config helpers`:

```js
// ── Auto updater ──────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes ?? null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', {
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
  });

  setTimeout(() => autoUpdater.checkForUpdates(), 5000);
}
```

- [ ] **Step 3: Call setupAutoUpdater() in app.whenReady()**

In the `app.whenReady().then(() => { ... })` block (currently ends around line 348), add the call **after** `registerIPC()` and **only when not in dev mode**:

```js
app.whenReady().then(() => {
  createWindow();
  createTray();
  registerIPC();

  if (!isDev) setupAutoUpdater();   // ← add this line

  // Auto-start agent if configured
  const cfg = readAgentConfig();
  if (cfg?.auto_start && cfg?.worker_key) {
    startAgent();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});
```

- [ ] **Step 4: Verify main.js loads without syntax errors**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
node -e "require('./electron/main.js')" 2>&1 | head -5
```

Expected: The command exits quickly (it will try to start Electron internals and fail harmlessly) without a `SyntaxError`. Any error like `Cannot use Electron in node.js` is expected and fine — what we're checking for is **no SyntaxError**.

- [ ] **Step 5: Add update:install IPC handler inside registerIPC()**

At the end of the `registerIPC()` function body, before its closing `}`, add:

```js
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
  });
```

- [ ] **Step 6: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/electron/main.js
git commit -m "feat(updater): add setupAutoUpdater() and update:install IPC handler"
```

---

## Task 3: Expose updater API in preload.js

**Files:**
- Modify: `client/electron/preload.js`

- [ ] **Step 1: Add updater namespace to the contextBridge**

Open `client/electron/preload.js`. The current `contextBridge.exposeInMainWorld('electronAPI', { ... })` call exposes `agent`, `config`, `claude`, and `llm`. Add `updater` as a fifth namespace inside the same object:

```js
updater: {
  onAvailable: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('update:available', h);
    return () => ipcRenderer.removeListener('update:available', h);
  },
  onProgress: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('update:progress', h);
    return () => ipcRenderer.removeListener('update:progress', h);
  },
  onDownloaded: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('update:downloaded', h);
    return () => ipcRenderer.removeListener('update:downloaded', h);
  },
  install: () => ipcRenderer.invoke('update:install'),
},
```

The full `contextBridge.exposeInMainWorld` call should now end with:

```js
  llm: { /* existing llm object unchanged */ },
  updater: {
    onAvailable: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:available', h);
      return () => ipcRenderer.removeListener('update:available', h);
    },
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:progress', h);
      return () => ipcRenderer.removeListener('update:progress', h);
    },
    onDownloaded: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('update:downloaded', h);
      return () => ipcRenderer.removeListener('update:downloaded', h);
    },
    install: () => ipcRenderer.invoke('update:install'),
  },
});
```

- [ ] **Step 2: Verify preload.js has no syntax errors**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
node -e "require('./electron/preload.js')" 2>&1 | head -5
```

Expected: Error like `contextBridge is not defined` (Electron API not available in plain Node) — that is fine. What we are checking is **no SyntaxError**.

- [ ] **Step 3: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/electron/preload.js
git commit -m "feat(updater): expose electronAPI.updater in preload"
```

---

## Task 4: Create UpdateNotification.jsx component

**Files:**
- Create: `client/src/components/UpdateNotification.jsx`

- [ ] **Step 1: Create the file**

```jsx
import React, { useEffect, useState } from 'react';

// State machine: idle → downloading → ready → dismissed
export default function UpdateNotification() {
  const [phase, setPhase] = useState('idle');   // idle | downloading | ready | dismissed
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    if (!window.electronAPI?.updater) return;

    const offAvailable = window.electronAPI.updater.onAvailable(({ version: v }) => {
      setVersion(v);
      setPhase('downloading');
    });

    const offProgress = window.electronAPI.updater.onProgress(({ percent: p }) => {
      setPercent(p);
    });

    const offDownloaded = window.electronAPI.updater.onDownloaded(({ version: v }) => {
      setVersion(v);
      setPhase('ready');
    });

    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
    };
  }, []);

  if (phase === 'idle' || phase === 'dismissed') return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm">
      <div className="mx-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg px-5 py-4">
        {phase === 'downloading' && (
          <>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              正在下载更新 {version && <span className="text-gray-500">v{version}</span>}
            </p>
            <div className="mt-2 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-400">{percent}%</p>
          </>
        )}

        {phase === 'ready' && (
          <>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              Token Bank <span className="text-blue-500">v{version}</span> 已准备好安装
            </p>
            <p className="mt-0.5 text-xs text-gray-500">重启后即可完成更新</p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => window.electronAPI.updater.install()}
                className="flex-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium py-1.5 transition-colors"
              >
                立即重启
              </button>
              <button
                onClick={() => setPhase('dismissed')}
                className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 text-sm font-medium py-1.5 transition-colors"
              >
                稍后
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/components/UpdateNotification.jsx
git commit -m "feat(updater): add UpdateNotification banner component"
```

---

## Task 5: Mount UpdateNotification in App.jsx

**Files:**
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Import the component**

At the top of `client/src/App.jsx`, after the existing imports, add:

```js
import UpdateNotification from './components/UpdateNotification';
```

- [ ] **Step 2: Mount inside Layout**

In the `Layout` function, add `<UpdateNotification />` just before the closing `</div>` of the root flex container. The updated `Layout` return should look like:

```jsx
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
    <UpdateNotification />
  </div>
);
```

- [ ] **Step 3: Start dev server and verify no runtime errors**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm run dev
```

Open the app. Open DevTools console. Confirm:
- No errors related to `UpdateNotification`
- `window.electronAPI.updater` is defined (run in console: `window.electronAPI.updater`)
- Expected console output: `{ onAvailable: f, onProgress: f, onDownloaded: f, install: f }`

- [ ] **Step 4: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/App.jsx
git commit -m "feat(updater): mount UpdateNotification in App layout"
```

---

## Task 6: Smoke test the full update flow (dev simulation)

This task simulates what happens when an update is ready, using DevTools to fire the IPC events manually.

- [ ] **Step 1: Start the app in dev mode**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm run dev
```

- [ ] **Step 2: Simulate update-available and download-progress**

In the Electron DevTools console, run:

```js
// Simulate a new version being found and 60% downloaded
window.electronAPI.updater.onAvailable(d => console.log('available', d));
```

Then in a second tab/window of DevTools, simulate the events by using the Electron main process console or by temporarily adding a debug IPC call. An easier approach — paste this directly in the renderer DevTools console to manually trigger the state machine:

```js
// Temporarily bypass IPC to test the UI states
// This verifies the component renders correctly
const event = new CustomEvent('__test_update_available', { detail: { version: '1.2.0' } });
```

Actually the cleanest way: in `main.js` `setupAutoUpdater()`, temporarily add at the bottom (remove after testing):

```js
// TEMPORARY TEST - remove before release
if (isDev) {
  setTimeout(() => {
    mainWindow?.webContents.send('update:available', { version: '9.9.9', releaseNotes: null });
  }, 3000);
  setTimeout(() => {
    mainWindow?.webContents.send('update:progress', { percent: 45 });
  }, 4000);
  setTimeout(() => {
    mainWindow?.webContents.send('update:downloaded', { version: '9.9.9' });
  }, 5000);
}
```

Then call `setupAutoUpdater()` unconditionally (remove the `!isDev` guard temporarily).

- [ ] **Step 3: Verify UI states**

After 3s: a "正在下载更新 v9.9.9" banner appears with a progress bar at 0%.
After 4s: progress bar fills to 45%.
After 5s: banner changes to "Token Bank v9.9.9 已准备好安装" with two buttons.
Click "稍后" → banner disappears.
Reload app → banner gone (dismissed state resets, no new events fired).

- [ ] **Step 4: Remove test code and restore isDev guard**

Revert the temporary test additions in `main.js`:
- Remove the `if (isDev) { setTimeout(...) }` block
- Restore `if (!isDev) setupAutoUpdater();`

- [ ] **Step 5: Final commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/electron/main.js
git commit -m "feat(updater): complete OTA auto-update implementation"
```

---

## Task 7: Release checklist (reference)

These steps are performed when cutting a real release — not during development.

- [ ] Bump `version` in `client/package.json` (e.g., `"1.0.0"` → `"1.1.0"`)
- [ ] Replace `REPLACE_WITH_YOUR_GITHUB_USERNAME` in `build.publish.owner` if not already done
- [ ] Commit the version bump: `git commit -am "chore: bump version to 1.1.0"`
- [ ] Tag: `git tag v1.1.0 && git push --tags`
- [ ] Build and publish: `cd client && GH_TOKEN=<your_token> npm run build -- --publish always`
- [ ] Verify on GitHub: the Release appears with `latest-mac.yml`, `latest.yml`, `.dmg`, `.exe` assets
- [ ] Test on a machine running an older version — update banner should appear within 5 seconds of launch

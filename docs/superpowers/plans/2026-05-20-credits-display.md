# Credits Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show `user.credits_balance` in the Sidebar bottom-left corner, refreshed every 30 seconds via polling in AuthContext.

**Architecture:** `AuthProvider` gains a `useRef`-backed interval that calls `getProfile()` every 30s and writes the result into `user` state. `Sidebar` reads `user.credits_balance` directly from `useAuth()` — no new state, no new requests. Polling starts on successful login (both from localStorage and from `loginSuccess()`), stops on logout and component unmount.

**Tech Stack:** React 18, existing `getProfile()` API call, Tailwind CSS

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `client/src/store/index.jsx` | Add `useRef` interval, `startPolling()`, `stopPolling()` |
| Modify | `client/src/components/Sidebar.jsx` | Add credits balance line in user card |

---

## Task 1: Add 30s polling to AuthContext

**Files:**
- Modify: `client/src/store/index.jsx`

- [ ] **Step 1: Read the current file**

Read `/Users/ully/githubprojects/local-llm-proxy/client/src/store/index.jsx` to confirm the current structure before editing.

- [ ] **Step 2: Replace the entire file content**

Replace the full contents of `client/src/store/index.jsx` with:

```jsx
import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getProfile } from '../api/client';

const AuthContext = createContext(null);

const POLL_INTERVAL = 30_000;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  function startPolling() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      getProfile().then((r) => setUser(r.data)).catch(() => {});
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    getProfile()
      .then((r) => {
        setUser(r.data);
        startPolling();
      })
      .catch(() => { localStorage.removeItem('token'); })
      .finally(() => setLoading(false));
    return () => stopPolling();
  }, []);

  function loginSuccess(token, userData) {
    localStorage.setItem('token', token);
    setUser(userData);
    startPolling();
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
    stopPolling();
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

Key changes from the original:
- Added `useRef` to the React import
- Added `const POLL_INTERVAL = 30_000` constant
- Added `timerRef = useRef(null)`
- Added `startPolling()` — guards against double-start with `clearInterval` before setting a new one
- Added `stopPolling()` — clears and nulls the ref
- `useEffect`: calls `startPolling()` after successful profile load; returns `stopPolling` as cleanup
- `loginSuccess`: calls `startPolling()` so fresh logins also get polling
- `logout`: calls `stopPolling()` so polling stops when user signs out

- [ ] **Step 3: Verify syntax**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
node -e "
const fs = require('fs');
const src = fs.readFileSync('src/store/index.jsx', 'utf8');
// Quick checks
console.assert(src.includes('useRef'), 'missing useRef');
console.assert(src.includes('POLL_INTERVAL'), 'missing POLL_INTERVAL');
console.assert(src.includes('startPolling'), 'missing startPolling');
console.assert(src.includes('stopPolling'), 'missing stopPolling');
console.assert(src.includes('return () => stopPolling'), 'missing cleanup');
console.log('all checks passed');
"
```

Expected output: `all checks passed`

- [ ] **Step 4: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/store/index.jsx
git commit -m "feat(credits): add 30s polling to AuthContext for credits refresh"
```

---

## Task 2: Add credits balance display to Sidebar

**Files:**
- Modify: `client/src/components/Sidebar.jsx`

- [ ] **Step 1: Read the current file**

Read `/Users/ully/githubprojects/local-llm-proxy/client/src/components/Sidebar.jsx` to locate the exact lines of the user card section.

The relevant section currently looks like this (inside the `{user && (...)}` block):

```jsx
<button
  onClick={() => navigate('/')}
  className="flex-1 min-w-0 px-3 py-2.5 text-left"
>
  <p className={`text-xs font-medium truncate ${profileActive ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}>{user.nickname}</p>
  <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email}</p>
</button>
```

- [ ] **Step 2: Add the credits line after the email paragraph**

Find the email `<p>` line inside the navigate button and add the credits display immediately after it. The updated button content should be:

```jsx
<button
  onClick={() => navigate('/')}
  className="flex-1 min-w-0 px-3 py-2.5 text-left"
>
  <p className={`text-xs font-medium truncate ${profileActive ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}>{user.nickname}</p>
  <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email}</p>
  {user.credits_balance != null && (
    <p className="text-xs font-medium text-blue-500 dark:text-blue-400 mt-0.5">
      💎 {Number(user.credits_balance).toLocaleString()} 积分
    </p>
  )}
</button>
```

Notes:
- `!= null` catches both `null` and `undefined` — prevents empty line before profile loads
- `Number(...).toLocaleString()` formats with thousands separator (e.g. `1,234`)
- `mt-0.5` adds minimal spacing from the email line
- `text-blue-500 dark:text-blue-400` matches the app's blue accent theme

- [ ] **Step 3: Verify the change**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
node -e "
const fs = require('fs');
const src = fs.readFileSync('src/components/Sidebar.jsx', 'utf8');
console.assert(src.includes('credits_balance'), 'missing credits_balance');
console.assert(src.includes('toLocaleString'), 'missing toLocaleString');
console.assert(src.includes('!= null'), 'missing null guard');
console.log('all checks passed');
"
```

Expected output: `all checks passed`

- [ ] **Step 4: Commit**

```bash
cd /Users/ully/githubprojects/local-llm-proxy
git add client/src/components/Sidebar.jsx
git commit -m "feat(credits): display credits_balance in Sidebar user card"
```

---

## Task 3: Manual smoke test

- [ ] **Step 1: Start dev server**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm run dev
```

- [ ] **Step 2: Log in and verify initial display**

Log into the app. In the bottom-left Sidebar user card, confirm:
- Nickname and email display as before
- A new line appears: `💎 X,XXX 积分` (real balance from your account)

- [ ] **Step 3: Verify polling in DevTools**

Open Electron DevTools (Network tab or Console). Confirm that a `GET /user/profile` request fires roughly every 30 seconds after the initial load.

- [ ] **Step 4: Verify logout clears polling**

Log out. Confirm no further `/user/profile` requests appear in the Network tab.

# Spin Lottery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily spin-the-wheel lottery to the Profile page — 3 spins per day, 0-50 credits per spin, probability weighted toward 0-10.

**Architecture:** Backend adds `spin_logs` table + two API endpoints in `user_router.py` backed by `database.py` functions. Frontend adds a `SpinCard` component to `Profile.jsx` using CSS rotation animation; the actual reward comes from the API before the animation plays.

**Tech Stack:** Python/FastAPI/aiosqlite (backend), React/JSX/Tailwind CSS (frontend)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `server/database.py` | `init_db` migration + `do_spin` + `get_spin_status` |
| Modify | `server/user_router.py` | `POST /user/spin` + `GET /user/spin/status` endpoints |
| Modify | `client/src/api/client.js` | `spin()` + `getSpinStatus()` exports |
| Modify | `client/src/pages/Profile.jsx` | `SpinCard` component + `TX_LABEL` entry + mount in `Profile` |

---

## Task 1: Database — spin_logs table + migration

**Files:**
- Modify: `server/database.py`

- [ ] **Step 1: Add `spin_logs` table creation and config defaults to `init_db`**

In `server/database.py`, inside `init_db()`, after the `checkins` table block, add:

```python
        await db.execute("""
            CREATE TABLE IF NOT EXISTS spin_logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
```

Then in the `INSERT OR IGNORE INTO system_config` block (where `checkin_reward` is inserted), add:

```python
            ("spin_daily_limit", "3"),
            ("spin_max_credits", "50"),
```

- [ ] **Step 2: Add `_migrate_spin_logs` function**

After `_migrate_checkins` function in `server/database.py`, add:

```python
async def _migrate_spin_logs() -> None:
    """Add spin_logs table and config keys for databases created before this feature."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS spin_logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.execute("INSERT OR IGNORE INTO system_config(key,value) VALUES('spin_daily_limit','3')")
        await db.execute("INSERT OR IGNORE INTO system_config(key,value) VALUES('spin_max_credits','50')")
        await db.commit()
```

- [ ] **Step 3: Call `_migrate_spin_logs` from `init_db`**

At the bottom of `init_db()`, after `await _migrate_checkins()`, add:

```python
        await _migrate_spin_logs()
```

- [ ] **Step 4: Verify migration runs without error**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python -c "import asyncio, database; asyncio.run(database.init_db()); print('OK')"
```

Expected output: `OK`

- [ ] **Step 5: Commit**

```bash
git add server/database.py
git commit -m "feat(db): add spin_logs table and migration"
```

---

## Task 2: Database — do_spin and get_spin_status functions

**Files:**
- Modify: `server/database.py`

- [ ] **Step 1: Add `do_spin` function**

After `get_checkin_status` function in `server/database.py`, add:

```python
def _weighted_spin_credits() -> int:
    """Return a random integer 0-50 with probability weighted toward 0-10."""
    import random
    r = random.random()
    if r < 0.70:
        return random.randint(0, 10)
    elif r < 0.95:
        return random.randint(11, 30)
    else:
        return random.randint(31, 50)


async def do_spin(user_id: int) -> dict:
    """Execute one spin. Returns already=True if daily limit reached."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    daily_limit = int(await get_config("spin_daily_limit", "3"))
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM spin_logs WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            spins_used = (await cur.fetchone())[0]
        if spins_used >= daily_limit:
            return {"already": True, "spins_used": spins_used, "spins_left": 0}
        credits = _weighted_spin_credits()
        await db.execute(
            "INSERT INTO spin_logs(user_id, date, credits) VALUES(?,?,?)",
            (user_id, today, credits),
        )
        await db.commit()
    spins_used += 1
    new_balance = await award_credits(user_id, credits, type_="spin", note=f"转盘抽奖 {today}")
    return {
        "already": False,
        "credits": credits,
        "spins_used": spins_used,
        "spins_left": max(0, daily_limit - spins_used),
        "new_balance": new_balance,
    }


async def get_spin_status(user_id: int) -> dict:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    daily_limit = int(await get_config("spin_daily_limit", "3"))
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM spin_logs WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            spins_used = (await cur.fetchone())[0]
    return {
        "spins_used": spins_used,
        "spins_left": max(0, daily_limit - spins_used),
        "daily_limit": daily_limit,
    }
```

- [ ] **Step 2: Smoke-test the functions**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
python -c "
import asyncio, database

async def test():
    await database.init_db()
    # Use user_id=1 (assumes at least one user exists; skip if DB is empty)
    status = await database.get_spin_status(1)
    print('status:', status)
    result = await database.do_spin(1)
    print('spin:', result)

asyncio.run(test())
"
```

Expected: prints dict with `spins_left`, `credits` keys (or `already=True` if already spun 3 times today).

- [ ] **Step 3: Commit**

```bash
git add server/database.py
git commit -m "feat(db): add do_spin and get_spin_status"
```

---

## Task 3: Backend API endpoints

**Files:**
- Modify: `server/user_router.py`

- [ ] **Step 1: Add spin endpoints**

At the end of `server/user_router.py` (after the `checkin_status` endpoint), add:

```python
# ── 转盘抽奖 ──────────────────────────────────────────────────────────────────

@router.post("/spin")
async def spin(uid: int = Depends(get_current_user_id)):
    result = await db.do_spin(uid)
    if result["already"]:
        raise HTTPException(400, f"今日抽奖次数已用完（{result['spins_used']}/{result['spins_used']} 次）")
    return result


@router.get("/spin/status")
async def spin_status(uid: int = Depends(get_current_user_id)):
    return await db.get_spin_status(uid)
```

- [ ] **Step 2: Start the server and verify endpoints respond**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
uvicorn server:app --port 8001 --reload &
sleep 2
# Get a token first (replace with real credentials if available)
curl -s -X POST http://localhost:8001/user/spin/status -H "Authorization: Bearer REPLACE_TOKEN" | python3 -m json.tool
# Stop server
kill %1
```

Expected: JSON with `spins_used`, `spins_left`, `daily_limit` — or 401 if token missing (that's fine, confirms route exists).

- [ ] **Step 3: Commit**

```bash
git add server/user_router.py
git commit -m "feat(api): add POST /user/spin and GET /user/spin/status"
```

---

## Task 4: Frontend API client

**Files:**
- Modify: `client/src/api/client.js`

- [ ] **Step 1: Add spin API functions**

At the end of `client/src/api/client.js`, add:

```js
export function spin() {
  return http.post('/user/spin');
}

export function getSpinStatus() {
  return http.get('/user/spin/status');
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/api/client.js
git commit -m "feat(api-client): add spin and getSpinStatus"
```

---

## Task 5: SpinCard component + Profile integration

**Files:**
- Modify: `client/src/pages/Profile.jsx`

- [ ] **Step 1: Add `spin` and `getSpinStatus` to imports**

Change the first import line in `Profile.jsx` from:

```js
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder } from '../api/client';
```

to:

```js
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder, spin, getSpinStatus } from '../api/client';
```

- [ ] **Step 2: Add `spin` to `TX_LABEL`**

Change:

```js
const TX_LABEL = {
  contribute: '贡献',
  consume: '消耗',
  referral: '推荐',
  purchase: '充值',
  adjust: '调整',
};
```

to:

```js
const TX_LABEL = {
  contribute: '贡献',
  consume: '消耗',
  referral: '推荐',
  purchase: '充值',
  adjust: '调整',
  spin: '转盘抽奖',
};
```

- [ ] **Step 3: Add `SpinCard` component**

Add this component after the `CheckinCard` function (before `export default function Profile`):

```jsx
function SpinCard({ onSpinSuccess }) {
  const [status, setStatus] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getSpinStatus()
      .then((r) => setStatus(r.data))
      .catch(() => {});
  }, []);

  async function handleSpin() {
    if (spinning || status?.spins_left === 0) return;
    setSpinning(true);
    setMsg('');
    setResult(null);
    let credits = null;
    try {
      const r = await spin();
      credits = r.data.credits;
      setStatus((s) => ({
        ...s,
        spins_used: r.data.spins_used,
        spins_left: r.data.spins_left,
      }));
    } catch (e) {
      setMsg(e.response?.data?.detail || '抽奖失败');
      setSpinning(false);
      return;
    }
    // Animate: 3-5 full rotations + random extra degrees
    const extraSpins = 3 + Math.floor(Math.random() * 3);
    const extraDeg = Math.floor(Math.random() * 360);
    setRotation((prev) => prev + extraSpins * 360 + extraDeg);
    setTimeout(() => {
      setResult(credits);
      setMsg(`+${credits} 积分`);
      setSpinning(false);
      onSpinSuccess?.();
    }, 2600);
  }

  const exhausted = status?.spins_left === 0;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-transparent rounded-2xl px-5 py-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl select-none">🎡</span>
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">每日转盘</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {status === null
                ? '加载中…'
                : exhausted
                ? '今日次数已用完'
                : `今日剩余 ${status.spins_left} 次`}
            </p>
          </div>
        </div>
        {msg && (
          <span className={`text-sm font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
            {msg}
          </span>
        )}
      </div>

      <div className="flex flex-col items-center gap-4">
        {/* Wheel */}
        <div className="relative w-36 h-36">
          {/* Fixed pointer */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 z-10 text-xl select-none">▼</div>
          {/* Spinning wheel */}
          <div
            className="w-36 h-36 rounded-full border-4 border-blue-600 dark:border-blue-500"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: spinning ? 'transform 2.5s cubic-bezier(0.17,0.67,0.12,0.99)' : 'none',
              background: 'conic-gradient(#3b82f6 0deg 60deg, #60a5fa 60deg 120deg, #93c5fd 120deg 180deg, #bfdbfe 180deg 240deg, #dbeafe 240deg 300deg, #eff6ff 300deg 360deg)',
            }}
          />
          {/* Center label */}
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-bold text-white drop-shadow select-none">
              {result !== null ? result : '?'}
            </span>
          </div>
        </div>

        {/* Button */}
        <button
          onClick={handleSpin}
          disabled={spinning || exhausted || status === null}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-colors ${
            exhausted
              ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-default'
              : spinning
              ? 'bg-blue-400 text-white cursor-wait'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          } disabled:opacity-60`}
        >
          {spinning ? '抽奖中…' : exhausted ? '明日再来' : '开始抽奖'}
        </button>

        {/* Usage counter */}
        {status && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            已用 {status.spins_used}/{status.daily_limit} 次
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount `SpinCard` in `Profile`**

In the `Profile` component body, find the line:

```jsx
      <CheckinCard onCheckinSuccess={refreshUser} />
```

Change it to:

```jsx
      <CheckinCard onCheckinSuccess={refreshUser} />
      <SpinCard onSpinSuccess={refreshUser} />
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Profile.jsx
git commit -m "feat(ui): add SpinCard daily lottery to Profile page"
```

---

## Task 6: End-to-end manual test

- [ ] **Step 1: Start backend**

```bash
cd /Users/ully/githubprojects/local-llm-proxy/server
uvicorn server:app --port 8000 --reload
```

- [ ] **Step 2: Start frontend**

In another terminal:

```bash
cd /Users/ully/githubprojects/local-llm-proxy/client
npm run dev
```

- [ ] **Step 3: Test the golden path**

1. Open the app, log in, navigate to Profile page
2. Verify the SpinCard appears below the CheckinCard
3. Click "开始抽奖" — wheel should spin for ~2.5 seconds
4. After animation, verify: center shows the won credits, green "+X 积分" message appears, "已用 1/3 次" updates
5. Spin 2 more times — button should become "明日再来" after 3rd spin
6. Scroll to 积分流水 — verify a `转盘抽奖` entry appears for each spin
7. Verify credits balance in the header updated

- [ ] **Step 4: Test edge case — already exhausted**

Manually update DB to set today's spins to 3:

```bash
sqlite3 /Users/ully/githubprojects/local-llm-proxy/server/proxy.db \
  "INSERT INTO spin_logs(user_id,date,credits) SELECT id, date('now'), 0 FROM users LIMIT 1;"
```

Reload the page — SpinCard should show "今日次数已用完" and button "明日再来" on load.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -p
git commit -m "fix(spin): address issues found in manual test"
```

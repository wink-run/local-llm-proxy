# 积分转盘抽奖 设计文档

**日期：** 2026-05-14  
**状态：** 待实现

---

## 概述

在 Profile 页签到卡片旁新增每日转盘抽奖功能。用户每日可抽奖 3 次，每次随机获得 0-50 积分，概率集中在低分段（0-10 分）。

---

## 后端设计

### 数据库

新增 `spin_logs` 表，记录每次抽奖：

```sql
CREATE TABLE spin_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    date       TEXT NOT NULL,        -- UTC 日期 YYYY-MM-DD
    credits    REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
```

`system_config` 新增两个配置项：

| key | 默认值 | 说明 |
|-----|--------|------|
| `spin_daily_limit` | `3` | 每日可抽次数 |
| `spin_max_credits` | `50` | 单次最大积分 |

迁移逻辑写在 `database.py` 的 `init_db()` / `_migrate_*` 中，保持现有模式。

### 概率算法

加权区间随机，先随机落区间，再在区间内均匀随机整数：

| 区间 | 权重 |
|------|------|
| 0–10 | 70% |
| 11–30 | 25% |
| 31–50 | 5% |

实现于 `database.py` 的 `do_spin()` 函数。

### 奖励记录

抽奖结果同时写入：
1. `spin_logs`（用于统计今日次数）
2. `transactions`（`type="spin"`，并入现有积分流水）

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/user/spin` | 执行抽奖 |
| `GET`  | `/user/spin/status` | 查询今日状态 |

**POST /user/spin 响应：**
```json
{
  "credits": 7,
  "spins_used": 2,
  "spins_left": 1,
  "new_balance": 142.0
}
```

**GET /user/spin/status 响应：**
```json
{
  "spins_used": 1,
  "spins_left": 2,
  "daily_limit": 3
}
```

次数已用完时 `POST /user/spin` 返回 HTTP 400，detail 说明剩余次数。

---

## 前端设计

### 组件位置

`client/src/pages/Profile.jsx` 中新增 `SpinSection` 组件，放在签到卡片（`CheckinSection`）下方，样式与现有卡片保持一致。

### 视觉结构

```
┌─────────────────────────────────┐
│  🎡 每日转盘                    │
│  今日剩余 N 次                  │
│                                 │
│         [圆形转盘]              │
│          ▼ 指针（固定）         │
│      (CSS rotate 动画)          │
│                                 │
│      [  开始抽奖  ]            │
│  已用 X/3 · 次数用完显示明日再来│
└─────────────────────────────────┘
```

### 转盘实现

- 圆形 div，CSS `transform: rotate()` + `transition: transform 2.5s ease-out`
- 转盘上绘制装饰色块（纯视觉，不代表具体奖项）
- 点击流程：
  1. 前端立即调用 `POST /user/spin` 获取真实结果
  2. 同时播放随机圈数旋转动画（3-5 圈 + 随机偏移）
  3. 动画结束后显示 Toast："恭喜获得 X 积分！"
  4. 刷新积分余额和交易记录

### 状态管理

- 页面加载调用 `GET /user/spin/status` 初始化剩余次数
- 每次抽奖后更新本地 `spinsLeft` 状态
- 次数归零后按钮 `disabled`，显示"明日再来"文案

### API 客户端

在 `client/src/api/client.js` 新增：

```js
export function spin() { return http.post('/user/spin'); }
export function getSpinStatus() { return http.get('/user/spin/status'); }
```

### i18n

沿用现有 i18n 方案，新增 key（参考签到的现有 key 命名规范）：

| key | 中文 | 英文 |
|-----|------|------|
| `spin.title` | 每日转盘 | Daily Spin |
| `spin.left` | 今日剩余 {n} 次 | {n} spins left today |
| `spin.used` | 已用 {used}/{limit} | {used}/{limit} used |
| `spin.start` | 开始抽奖 | Spin |
| `spin.spinning` | 抽奖中… | Spinning… |
| `spin.result` | 恭喜获得 {n} 积分！ | You got {n} credits! |
| `spin.done` | 明日再来 | Come back tomorrow |

---

## 不在范围内

- 管理后台调整 `spin_daily_limit` / `spin_max_credits` 的 UI（配置项已在 DB，可直接 SQL 修改）
- 抽奖排行榜
- 特殊活动倍率

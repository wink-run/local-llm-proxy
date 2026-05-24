"""订阅管理：subscriptions 表 + burn rate 算法 + alerts。

设计：DESIGN_v2.md §8 + 用户对话 § 订阅管理中心 / 余额预警
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Optional

import aiosqlite

import local_db
import dashboard


async def init_subscriptions_table() -> None:
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS subscriptions (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id          TEXT NOT NULL,
                display_name         TEXT NOT NULL,
                plan_kind            TEXT NOT NULL DEFAULT 'payg',   -- plan / payg / prepaid
                plan_name            TEXT DEFAULT '',                -- 'Pro' / 'Team' / 'Pay-as-you-go'
                monthly_cost         REAL DEFAULT 0,
                currency             TEXT DEFAULT 'USD',
                quota_total          REAL DEFAULT 0,                 -- 月配额 / 充值总额
                balance_remaining    REAL,                           -- 当前余额（NULL 表示未知）
                used_this_period     REAL DEFAULT 0,
                renews_at            TEXT,                           -- ISO date
                auto_renew           INTEGER DEFAULT 0,
                alert_balance_pct    REAL DEFAULT 20,
                alert_days_before    INTEGER DEFAULT 1,
                alert_enabled        INTEGER DEFAULT 1,
                last_synced_at       TEXT,
                notes                TEXT DEFAULT '',
                created_at           TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


# ── CRUD ────────────────────────────────────────────────────────────


async def list_subscriptions() -> list[dict]:
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM subscriptions ORDER BY id ASC") as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_subscription(sub_id: int) -> Optional[dict]:
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM subscriptions WHERE id = ?", (sub_id,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def create_subscription(**fields) -> int:
    cols = []
    args = []
    allowed = {
        "provider_id", "display_name", "plan_kind", "plan_name", "monthly_cost",
        "currency", "quota_total", "balance_remaining", "used_this_period",
        "renews_at", "auto_renew", "alert_balance_pct", "alert_days_before",
        "alert_enabled", "notes",
    }
    for k, v in fields.items():
        if k in allowed:
            cols.append(k)
            args.append(v)
    placeholders = ",".join("?" * len(cols))
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        cur = await db.execute(
            f"INSERT INTO subscriptions ({','.join(cols)}) VALUES ({placeholders})",
            args,
        )
        await db.commit()
        return cur.lastrowid


async def update_subscription(sub_id: int, **fields) -> bool:
    allowed = {
        "display_name", "plan_kind", "plan_name", "monthly_cost", "currency",
        "quota_total", "balance_remaining", "used_this_period", "renews_at",
        "auto_renew", "alert_balance_pct", "alert_days_before", "alert_enabled",
        "last_synced_at", "notes",
    }
    safe = {k: v for k, v in fields.items() if k in allowed}
    if not safe:
        return False
    sets = ", ".join(f"{k} = ?" for k in safe)
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        await db.execute(
            f"UPDATE subscriptions SET {sets} WHERE id = ?",
            (*safe.values(), sub_id),
        )
        await db.commit()
    return True


async def delete_subscription(sub_id: int) -> None:
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        await db.execute("DELETE FROM subscriptions WHERE id = ?", (sub_id,))
        await db.commit()


# ── burn rate ────────────────────────────────────────────────────────


async def calculate_burn_rate(provider_id: str, days: int = 7) -> dict:
    """基于最近 N 天 call_logs * model_prices 算 $/day 速率。"""
    sql = (
        "SELECT model, tier, "
        "SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok, COUNT(*) AS calls "
        "FROM call_logs "
        f"WHERE timestamp >= datetime('now', '-{int(days)} days') AND routed_to = ? "
        "GROUP BY model, tier"
    )
    total_cost = 0.0
    total_tokens = 0
    total_calls = 0
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, (provider_id,)) as cur:
            rows = await cur.fetchall()
    for r in rows:
        in_t = r["in_tok"] or 0
        out_t = r["out_tok"] or 0
        total_cost += dashboard.actual_cost(r["tier"], r["model"], in_t, out_t)
        total_tokens += in_t + out_t
        total_calls += r["calls"] or 0
    daily_cost = total_cost / days if days > 0 else 0.0
    return {
        "provider_id": provider_id,
        "window_days": days,
        "total_cost_usd": round(total_cost, 4),
        "total_tokens": total_tokens,
        "total_calls": total_calls,
        "daily_avg_usd": round(daily_cost, 4),
    }


async def enrich_subscription(sub: dict) -> dict:
    """给单个 subscription 加 burn_rate + days_until_depletion + days_until_renewal + 关联 scenarios。"""
    out = {**sub}
    burn = await calculate_burn_rate(sub["provider_id"], days=7)
    out["burn"] = burn

    # 预计耗尽天数
    balance = sub.get("balance_remaining")
    daily = burn["daily_avg_usd"]
    if balance is not None and daily > 0.0001:
        out["days_until_depletion"] = round(balance / daily, 1)
    else:
        out["days_until_depletion"] = None

    # 续费倒计时
    out["days_until_renewal"] = None
    if sub.get("renews_at"):
        s = sub["renews_at"]
        try:
            # 支持 'YYYY-MM-DD' 与 'YYYY-MM-DDTHH:MM:SS' 两种
            if "T" in s or " " in s:
                renew = datetime.fromisoformat(s)
            else:
                # 纯日期：补 00:00:00（Python 3.10 fromisoformat 不接受单日期）
                renew = datetime.fromisoformat(s + "T00:00:00")
            out["days_until_renewal"] = (renew - datetime.utcnow()).days
        except (ValueError, TypeError):
            pass

    # 关联到了哪些场景（场景 chain 中含该 provider_id）
    scenarios = await local_db.list_scenarios()
    related = []
    for scn in scenarios:
        for step in scn.get("degradation_chain") or []:
            if any(c.get("provider_id") == sub["provider_id"] for c in (step.get("candidates") or [])):
                related.append({"id": scn["id"], "name": scn["name"]})
                break
    out["related_scenarios"] = related

    return out


# ── alerts ──────────────────────────────────────────────────────────


async def compute_alerts() -> list[dict]:
    """返回当前 active 警告列表。"""
    subs = await list_subscriptions()
    alerts = []
    for sub in subs:
        if not sub.get("alert_enabled"):
            continue
        enriched = await enrich_subscription(sub)
        # 1) 余额低（百分比）
        balance = sub.get("balance_remaining")
        quota = sub.get("quota_total") or 0
        thresh_pct = sub.get("alert_balance_pct") or 20
        if balance is not None and quota > 0:
            pct = balance / quota * 100
            if pct < thresh_pct:
                alerts.append({
                    "severity": "high" if pct < thresh_pct / 2 else "medium",
                    "kind": "low_balance",
                    "sub_id": sub["id"],
                    "display_name": sub["display_name"],
                    "message": f"{sub['display_name']} 余额仅剩 {pct:.0f}%（阈值 {thresh_pct:.0f}%）",
                })
        # 2) burn 快 → 预计耗尽时间近
        days_left = enriched.get("days_until_depletion")
        if days_left is not None and days_left < 3:
            alerts.append({
                "severity": "high" if days_left < 1 else "medium",
                "kind": "burn_fast",
                "sub_id": sub["id"],
                "display_name": sub["display_name"],
                "message": f"{sub['display_name']} 按当前用量约 {days_left} 天后耗尽",
                "days_left": days_left,
            })
        # 3) 续费日临近
        days_renew = enriched.get("days_until_renewal")
        thresh_days = sub.get("alert_days_before") or 1
        if days_renew is not None and 0 <= days_renew <= thresh_days:
            alerts.append({
                "severity": "medium",
                "kind": "renewal_soon",
                "sub_id": sub["id"],
                "display_name": sub["display_name"],
                "message": f"{sub['display_name']} 将在 {days_renew} 天后续费",
                "days_renew": days_renew,
            })
    return alerts

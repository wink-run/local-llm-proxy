"""Dashboard 数据聚合：trend / attribution / savings 估值。

设计：DESIGN_v2.md §8.1 + 用户对话提的 4 项需求
- 消耗总览（趋势 + 节省估值）
- 应用归因
- 订阅 burn rate（这里只算速率，订阅 CRUD 在 subscriptions.py）
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import aiosqlite
import yaml

import local_db


# __file__ = .../server/local/dashboard.py → parents[2] = repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("LLP_DATA_DIR", REPO_ROOT / "data"))

# ── 价格表：启动加载一次 ─────────────────────────────────────────────

_MODEL_PRICES: dict = {}
_DEFAULTS: dict = {"paid_default": {"input": 0.5, "output": 1.5},
                    "free_default": {"input": 0.0, "output": 0.0}}


def load_model_prices() -> None:
    """加载 data/model_prices.yaml；运行时可重新调用刷新。"""
    global _MODEL_PRICES, _DEFAULTS
    path = DATA_DIR / "model_prices.yaml"
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    _MODEL_PRICES = data.get("models", {}) or {}
    if data.get("defaults"):
        _DEFAULTS.update(data["defaults"])


def paid_equivalent_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """『如果走 paid』要付多少美元（按 model 查表 / 用 paid_default 兜底）。"""
    price = _MODEL_PRICES.get(model) or _DEFAULTS["paid_default"]
    return (input_tokens / 1_000_000) * price["input"] + \
           (output_tokens / 1_000_000) * price["output"]


def actual_cost(tier: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """实际成本：free/cache/shared = 0；paid = 查表。"""
    if tier in ("free", "cache", "shared", "none"):
        return 0.0
    return paid_equivalent_cost(model, input_tokens, output_tokens)


# ── 聚合 ────────────────────────────────────────────────────────────


async def aggregate_savings(since_iso: str | None = None) -> dict:
    """汇总『今日/本月/累计 节省 vs 全 paid』。"""
    sql = (
        "SELECT tier, model, "
        "SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok "
        "FROM call_logs"
    )
    args: list = []
    if since_iso:
        sql += " WHERE timestamp >= ?"
        args.append(since_iso)
    sql += " GROUP BY tier, model"
    total_paid_eq = 0.0
    total_actual = 0.0
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, args) as cur:
            rows = await cur.fetchall()
    for r in rows:
        in_t = r["in_tok"] or 0
        out_t = r["out_tok"] or 0
        total_paid_eq += paid_equivalent_cost(r["model"], in_t, out_t)
        total_actual += actual_cost(r["tier"], r["model"], in_t, out_t)
    saved = max(0.0, total_paid_eq - total_actual)
    pct = round(saved / total_paid_eq * 100, 1) if total_paid_eq > 0 else 0.0
    return {
        "paid_equivalent_usd": round(total_paid_eq, 4),
        "actual_usd": round(total_actual, 4),
        "saved_usd": round(saved, 4),
        "saved_pct": pct,
    }


async def aggregate_trend(window: str = "7d") -> dict:
    """趋势：按时间 bucket + tier 分组。

    window: 24h（小时桶）/ 7d（天桶）/ 30d（天桶）
    """
    if window == "24h":
        bucket_fmt = "%Y-%m-%d %H:00"
        since = "datetime('now', '-24 hours')"
    elif window == "30d":
        bucket_fmt = "%Y-%m-%d"
        since = "datetime('now', '-30 days')"
    else:  # 7d
        bucket_fmt = "%Y-%m-%d"
        since = "datetime('now', '-7 days')"

    sql = (
        f"SELECT strftime('{bucket_fmt}', timestamp) AS bucket, tier, "
        "SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS calls "
        f"FROM call_logs WHERE timestamp >= {since} "
        "GROUP BY bucket, tier ORDER BY bucket ASC"
    )
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql) as cur:
            rows = [dict(r) for r in await cur.fetchall()]

    # 透视成 [{bucket, free, paid, shared, cache}]
    buckets: dict[str, dict] = {}
    for r in rows:
        b = buckets.setdefault(r["bucket"], {"bucket": r["bucket"], "free": 0, "paid": 0, "shared": 0, "cache": 0, "calls": 0})
        tier = r["tier"] if r["tier"] in ("free", "paid", "shared", "cache") else "free"
        b[tier] += r["tokens"] or 0
        b["calls"] += r["calls"] or 0
    return {"window": window, "buckets": list(buckets.values())}


async def aggregate_attribution(since_iso: str | None = None, limit: int = 10) -> list[dict]:
    """应用归因：按 app_source 聚合（含 token 数 / call 数 / 节省）。"""
    sql = (
        "SELECT COALESCE(NULLIF(app_source, ''), '其它') AS app, tier, model, "
        "SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok, COUNT(*) AS calls "
        "FROM call_logs"
    )
    args: list = []
    if since_iso:
        sql += " WHERE timestamp >= ?"
        args.append(since_iso)
    sql += " GROUP BY app, tier, model"
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, args) as cur:
            rows = await cur.fetchall()

    by_app: dict[str, dict] = {}
    for r in rows:
        app = r["app"]
        a = by_app.setdefault(app, {"app": app, "calls": 0, "tokens": 0, "saved_usd": 0.0})
        in_t = r["in_tok"] or 0
        out_t = r["out_tok"] or 0
        a["calls"] += r["calls"] or 0
        a["tokens"] += in_t + out_t
        # 节省 = paid_equiv - actual
        a["saved_usd"] += max(0.0, paid_equivalent_cost(r["model"], in_t, out_t)
                                    - actual_cost(r["tier"], r["model"], in_t, out_t))
    out = sorted(by_app.values(), key=lambda x: x["tokens"], reverse=True)[:limit]
    for r in out:
        r["saved_usd"] = round(r["saved_usd"], 4)
    return out


# ── 启动加载 ────────────────────────────────────────────────────────

load_model_prices()

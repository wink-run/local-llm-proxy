"""本地网关专用 SQLite 数据层。

与 server/database.py（VPS 端 proxy.db）严格隔离：
- 文件：~/.local-llm-proxy/local.db（用户主目录，避免随项目目录走）
- 表：local_providers / app_bindings / model_aliases / tos_acks
- 仅本地网关进程访问，不暴露给 VPS 端的 server.py

设计文档对应：DESIGN_v2.md §1.2 / §1.4 / §2.4 / §3.3
"""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Optional

import aiosqlite

# ── 路径 ─────────────────────────────────────────────────────────────────────

def _default_local_db_path() -> str:
    """默认放在用户主目录下，避免误把本地数据提交到仓库。"""
    home = Path.home() / ".local-llm-proxy"
    home.mkdir(parents=True, exist_ok=True)
    return str(home / "local.db")


LOCAL_DB_PATH = os.getenv("LOCAL_DB_PATH", _default_local_db_path())


# ── 初始化 ───────────────────────────────────────────────────────────────────

async def init_local_db() -> None:
    """创建表（幂等）。首次启动 + 后续启动都安全调用。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        # local_providers：用户配置的上游 Provider 实例
        # 每条 = (一个 yaml 目录 entry 的实例化) + (用户的 API key 引用)
        # 注意：实际 API key 走 keystore（OS keychain），这里只存 key_ref
        await db.execute("""
            CREATE TABLE IF NOT EXISTS local_providers (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id  TEXT    NOT NULL,            -- 对应 yaml id (groq / ollama / ...)
                display_name TEXT    NOT NULL,
                tier         TEXT    NOT NULL,            -- free / paid / shared
                base_url     TEXT    NOT NULL,
                auth_type    TEXT    NOT NULL DEFAULT 'bearer',  -- bearer / none / custom
                key_ref      TEXT    DEFAULT '',          -- keystore 中的 key 名（不存明文）
                models       TEXT    DEFAULT '[]',        -- JSON 数组
                enabled      INTEGER DEFAULT 1,
                priority     INTEGER DEFAULT 100,         -- custom 策略下的排序键，小者优先
                price_in     REAL    DEFAULT 0,           -- $/1M input tokens
                price_out    REAL    DEFAULT 0,           -- $/1M output tokens
                health_score REAL    DEFAULT 1.0,         -- 0~1，由健康检查更新
                last_used_at TEXT    DEFAULT '',
                last_error   TEXT    DEFAULT '',
                created_at   TEXT    DEFAULT (datetime('now'))
            )
        """)

        # app_bindings：每个客户端工具当前绑定的网关入口
        await db.execute("""
            CREATE TABLE IF NOT EXISTS app_bindings (
                app_name       TEXT PRIMARY KEY,           -- claude_code / codex / cursor / ...
                base_url       TEXT NOT NULL,              -- 写入的 gateway URL
                api_key_masked TEXT NOT NULL,              -- 仅保留前后 4 位 + ***
                last_written_at TEXT DEFAULT (datetime('now')),
                last_error     TEXT DEFAULT ''
            )
        """)

        # model_aliases：逻辑模型名 → 多个 provider 候选
        # 例：claude-opus-4-7 → [anthropic/claude-opus-4-7, anthropic-bedrock/...]
        await db.execute("""
            CREATE TABLE IF NOT EXISTS model_aliases (
                logical_name TEXT PRIMARY KEY,             -- claude-opus-4-7
                aliases      TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
                tier         TEXT DEFAULT 'open',          -- premium / open
                context_size INTEGER DEFAULT 0,
                created_at   TEXT DEFAULT (datetime('now'))
            )
        """)

        # tos_acks：高级模式开启 / 关闭的审计日志
        await db.execute("""
            CREATE TABLE IF NOT EXISTS tos_acks (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                action       TEXT    NOT NULL,             -- enable_advanced / disable_advanced / enable_source / ...
                source_kind  TEXT    DEFAULT '',           -- subscription / surplus_key / ...
                ack_text     TEXT    NOT NULL,             -- 用户当时看到并 acknowledge 的声明全文
                user_hint    TEXT    DEFAULT '',           -- 用户备注（可为空）
                created_at   TEXT    DEFAULT (datetime('now'))
            )
        """)

        # gateway_settings：单行配置表（策略、advanced 开关等）
        await db.execute("""
            CREATE TABLE IF NOT EXISTS gateway_settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            )
        """)
        await db.execute(
            "INSERT OR IGNORE INTO gateway_settings(key, value) VALUES('strategy', 'cost')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO gateway_settings(key, value) VALUES('advanced_mode', '0')"
        )

        await db.commit()
    await init_contribution_sources()
    await init_call_logs()
    await init_routing_policies()


# ── local_providers ─────────────────────────────────────────────────────────

async def add_provider(
    provider_id: str,
    display_name: str,
    tier: str,
    base_url: str,
    auth_type: str = "bearer",
    key_ref: str = "",
    models: list[str] | None = None,
    price_in: float = 0.0,
    price_out: float = 0.0,
) -> int:
    """新增一个 provider 实例，返回 rowid。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO local_providers
               (provider_id, display_name, tier, base_url, auth_type, key_ref, models,
                price_in, price_out)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                provider_id, display_name, tier, base_url, auth_type, key_ref,
                json.dumps(models or []), price_in, price_out,
            ),
        )
        await db.commit()
        return cur.lastrowid


async def list_providers(enabled_only: bool = False) -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        sql = "SELECT * FROM local_providers"
        if enabled_only:
            sql += " WHERE enabled = 1"
        sql += " ORDER BY tier, priority, id"
        async with db.execute(sql) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        try:
            r["models"] = json.loads(r["models"] or "[]")
        except json.JSONDecodeError:
            r["models"] = []
    return rows


async def get_provider(row_id: int) -> Optional[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM local_providers WHERE id = ?", (row_id,)
        ) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    try:
        row["models"] = json.loads(row["models"] or "[]")
    except json.JSONDecodeError:
        row["models"] = []
    return row


async def update_provider(row_id: int, **fields) -> None:
    """局部更新允许的字段。"""
    allowed = {
        "display_name", "base_url", "auth_type", "key_ref", "models",
        "enabled", "priority", "price_in", "price_out",
        "health_score", "last_used_at", "last_error",
    }
    safe = {k: v for k, v in fields.items() if k in allowed}
    if not safe:
        return
    if "models" in safe and not isinstance(safe["models"], str):
        safe["models"] = json.dumps(safe["models"])
    sets = ", ".join(f"{k} = ?" for k in safe)
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            f"UPDATE local_providers SET {sets} WHERE id = ?",
            (*safe.values(), row_id),
        )
        await db.commit()


async def delete_provider(row_id: int) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("DELETE FROM local_providers WHERE id = ?", (row_id,))
        await db.commit()


# ── settings ────────────────────────────────────────────────────────────────

async def get_setting(key: str, default: str = "") -> str:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        async with db.execute(
            "SELECT value FROM gateway_settings WHERE key = ?", (key,)
        ) as cur:
            r = await cur.fetchone()
            return r[0] if r else default


async def set_setting(key: str, value: str) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            "INSERT INTO gateway_settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        await db.commit()


# ── tos_acks ────────────────────────────────────────────────────────────────

async def record_tos_ack(action: str, ack_text: str,
                          source_kind: str = "", user_hint: str = "") -> int:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO tos_acks(action, source_kind, ack_text, user_hint) "
            "VALUES (?, ?, ?, ?)",
            (action, source_kind, ack_text, user_hint),
        )
        await db.commit()
        return cur.lastrowid


async def list_tos_acks(limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM tos_acks ORDER BY created_at DESC LIMIT ?", (limit,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── gateway API key（生成一次、长期持有；写入到客户端工具配置中） ──────────


async def get_or_create_gateway_key() -> str:
    """返回长期 gateway API key。首次调用时生成 'lp-{32 char urlsafe}' 并入库。"""
    existing = await get_setting("gateway_api_key", "")
    if existing:
        return existing
    new = "lp-" + secrets.token_urlsafe(32)
    await set_setting("gateway_api_key", new)
    return new


async def rotate_gateway_key() -> str:
    """轮换 key。用户需要手动重写所有 app binding。"""
    new = "lp-" + secrets.token_urlsafe(32)
    await set_setting("gateway_api_key", new)
    return new


# ── contribution_sources（板块③ 本机贡献清单） ──────────────────────────


async def init_contribution_sources() -> None:
    """幂等创建 contribution_sources 表。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS contribution_sources (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                source_kind  TEXT NOT NULL,         -- 'local' | 'gateway' | 'subscription'
                display_name TEXT NOT NULL,
                base_url     TEXT DEFAULT '',       -- local 不填；gateway / subscription 填
                models       TEXT DEFAULT '[]',     -- JSON
                enabled      INTEGER DEFAULT 0,
                quota_unit   TEXT DEFAULT '',       -- usd / tokens / rpm
                quota_total  REAL DEFAULT 0,
                quota_used   REAL DEFAULT 0,
                schedule     TEXT DEFAULT '',       -- 自由文本：'24/7' / '09-18' 等
                notes        TEXT DEFAULT '',
                created_at   TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


async def list_contribution_sources() -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM contribution_sources ORDER BY source_kind, id"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        try:
            r["models"] = json.loads(r["models"] or "[]")
        except json.JSONDecodeError:
            r["models"] = []
    return rows


async def add_contribution_source(
    source_kind: str, display_name: str,
    base_url: str = "", models: list[str] | None = None,
    quota_unit: str = "", quota_total: float = 0.0,
    schedule: str = "", notes: str = "",
) -> int:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO contribution_sources
               (source_kind, display_name, base_url, models, quota_unit, quota_total, schedule, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (source_kind, display_name, base_url, json.dumps(models or []),
             quota_unit, quota_total, schedule, notes),
        )
        await db.commit()
        return cur.lastrowid


async def toggle_contribution_source(row_id: int, enabled: bool) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            "UPDATE contribution_sources SET enabled = ? WHERE id = ?",
            (int(enabled), row_id),
        )
        await db.commit()


async def delete_contribution_source(row_id: int) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("DELETE FROM contribution_sources WHERE id = ?", (row_id,))
        await db.commit()


# ── call_logs（调用流水 / Dashboard 数据源） ───────────────────────────────


async def init_call_logs() -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS call_logs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
                app_source    TEXT DEFAULT '',     -- X-Source-App 或空
                model         TEXT NOT NULL,
                routed_to     TEXT NOT NULL,       -- provider_id
                tier          TEXT NOT NULL,       -- free / paid / shared
                input_tokens  INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                latency_ms    INTEGER DEFAULT 0,
                success       INTEGER DEFAULT 1,
                error_msg     TEXT DEFAULT '',
                cached        INTEGER DEFAULT 0    -- 1 = prompt-cache 命中
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_call_logs_ts ON call_logs(timestamp DESC)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_call_logs_app ON call_logs(app_source, timestamp DESC)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_call_logs_tier ON call_logs(tier, timestamp DESC)"
        )
        await db.commit()


async def log_call(
    *, model: str, routed_to: str, tier: str,
    app_source: str = "",
    input_tokens: int = 0, output_tokens: int = 0,
    latency_ms: int = 0, success: bool = True,
    error_msg: str = "", cached: bool = False,
) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            """INSERT INTO call_logs
               (app_source, model, routed_to, tier, input_tokens, output_tokens,
                latency_ms, success, error_msg, cached)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (app_source, model, routed_to, tier, input_tokens, output_tokens,
             latency_ms, int(success), error_msg, int(cached)),
        )
        await db.commit()


async def aggregate_by_tier(since_iso: str | None = None) -> dict:
    """按 tier 汇总：{tier: {calls, input, output, total, cache_hits}}。"""
    sql = (
        "SELECT tier, COUNT(*) AS calls, "
        "SUM(input_tokens) AS input, SUM(output_tokens) AS output, "
        "SUM(input_tokens + output_tokens) AS total, "
        "SUM(CASE WHEN cached=1 THEN 1 ELSE 0 END) AS cache_hits "
        "FROM call_logs"
    )
    args: list = []
    if since_iso:
        sql += " WHERE timestamp >= ?"
        args.append(since_iso)
    sql += " GROUP BY tier"
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, args) as cur:
            return {
                r["tier"]: {
                    "calls": r["calls"] or 0,
                    "input_tokens": r["input"] or 0,
                    "output_tokens": r["output"] or 0,
                    "total_tokens": r["total"] or 0,
                    "cache_hits": r["cache_hits"] or 0,
                }
                for r in await cur.fetchall()
            }


async def aggregate_by_app(since_iso: str | None = None) -> list[dict]:
    """按 app_source 汇总（app_source 为空的归入 'unknown'）。"""
    sql = (
        "SELECT COALESCE(NULLIF(app_source, ''), 'unknown') AS app, "
        "COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS total, "
        "AVG(latency_ms) AS avg_latency "
        "FROM call_logs"
    )
    args: list = []
    if since_iso:
        sql += " WHERE timestamp >= ?"
        args.append(since_iso)
    sql += " GROUP BY app ORDER BY calls DESC"
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, args) as cur:
            return [
                {
                    "app": r["app"],
                    "calls": r["calls"] or 0,
                    "total_tokens": r["total"] or 0,
                    "avg_latency_ms": round(r["avg_latency"] or 0, 1),
                }
                for r in await cur.fetchall()
            ]


async def recent_calls(limit: int = 10) -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM call_logs ORDER BY id DESC LIMIT ?", (limit,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── routing_policies（M13） ───────────────────────────────────────────────


BUILTIN_POLICIES = [
    {"name": "cost-first",   "tier_order": ["free","shared","paid"], "allowed_tiers": ["free","shared","paid"], "fallback_enabled": 1},
    {"name": "quality-first","tier_order": ["paid","free","shared"], "allowed_tiers": ["free","shared","paid"], "fallback_enabled": 1},
    {"name": "free-only",    "tier_order": ["free"],                 "allowed_tiers": ["free"],                 "fallback_enabled": 0},
    {"name": "paid-only",    "tier_order": ["paid"],                 "allowed_tiers": ["paid"],                 "fallback_enabled": 0},
    {"name": "under-budget", "tier_order": ["free","shared","paid"], "allowed_tiers": ["free","shared","paid"], "fallback_enabled": 1, "max_cost_per_1m": 0.5},
]


async def init_routing_policies() -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS routing_policies (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                name             TEXT UNIQUE NOT NULL,
                tier_order       TEXT NOT NULL,          -- JSON 数组
                allowed_tiers    TEXT NOT NULL,          -- JSON 数组
                model_preference TEXT DEFAULT '',
                max_cost_per_1m  REAL DEFAULT 0,
                fallback_enabled INTEGER DEFAULT 1,
                is_builtin       INTEGER DEFAULT 0,
                created_at       TEXT DEFAULT (datetime('now'))
            )
        """)
        # 幂等灌内置策略
        for p in BUILTIN_POLICIES:
            await db.execute(
                """INSERT OR IGNORE INTO routing_policies
                   (name, tier_order, allowed_tiers, max_cost_per_1m, fallback_enabled, is_builtin)
                   VALUES (?, ?, ?, ?, ?, 1)""",
                (
                    p["name"],
                    json.dumps(p["tier_order"]),
                    json.dumps(p["allowed_tiers"]),
                    p.get("max_cost_per_1m", 0),
                    p.get("fallback_enabled", 1),
                ),
            )
        await db.commit()
    # app_bindings 加 routing_policy_id 列（迁移）
    await _migrate_app_bindings_policy()


async def _migrate_app_bindings_policy() -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        async with db.execute("PRAGMA table_info(app_bindings)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "routing_policy_id" not in cols:
            await db.execute(
                "ALTER TABLE app_bindings ADD COLUMN routing_policy_id INTEGER REFERENCES routing_policies(id)"
            )
        await db.commit()


async def list_routing_policies() -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM routing_policies ORDER BY is_builtin DESC, id ASC"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        try:
            r["tier_order"] = json.loads(r["tier_order"] or "[]")
            r["allowed_tiers"] = json.loads(r["allowed_tiers"] or "[]")
        except json.JSONDecodeError:
            pass
    return rows


async def get_routing_policy(policy_id: int) -> Optional[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM routing_policies WHERE id = ?", (policy_id,)
        ) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    try:
        row["tier_order"] = json.loads(row["tier_order"] or "[]")
        row["allowed_tiers"] = json.loads(row["allowed_tiers"] or "[]")
    except json.JSONDecodeError:
        pass
    return row


async def get_routing_policy_by_name(name: str) -> Optional[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id FROM routing_policies WHERE name = ?", (name,)
        ) as cur:
            r = await cur.fetchone()
    return await get_routing_policy(r["id"]) if r else None


async def upsert_routing_policy(name: str, tier_order: list[str], allowed_tiers: list[str],
                                  max_cost_per_1m: float = 0, fallback_enabled: bool = True,
                                  model_preference: str = "") -> int:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            """INSERT INTO routing_policies
               (name, tier_order, allowed_tiers, max_cost_per_1m, fallback_enabled, model_preference, is_builtin)
               VALUES (?, ?, ?, ?, ?, ?, 0)
               ON CONFLICT(name) DO UPDATE SET
                 tier_order=excluded.tier_order,
                 allowed_tiers=excluded.allowed_tiers,
                 max_cost_per_1m=excluded.max_cost_per_1m,
                 fallback_enabled=excluded.fallback_enabled,
                 model_preference=excluded.model_preference""",
            (
                name, json.dumps(tier_order), json.dumps(allowed_tiers),
                max_cost_per_1m, int(fallback_enabled), model_preference,
            ),
        )
        async with db.execute("SELECT id FROM routing_policies WHERE name=?", (name,)) as cur:
            row = await cur.fetchone()
        await db.commit()
    return row[0] if row else 0


async def delete_routing_policy(policy_id: int) -> bool:
    """非内置策略才能删；返回是否删除成功。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        async with db.execute(
            "SELECT is_builtin FROM routing_policies WHERE id = ?", (policy_id,)
        ) as cur:
            r = await cur.fetchone()
        if not r or r[0]:
            return False
        await db.execute("DELETE FROM routing_policies WHERE id = ?", (policy_id,))
        await db.commit()
    return True


async def get_app_binding_with_policy(app_name: str) -> Optional[dict]:
    """读取 app_binding 并附加关联 policy。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM app_bindings WHERE app_name = ?", (app_name,)
        ) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    if row.get("routing_policy_id"):
        row["policy"] = await get_routing_policy(row["routing_policy_id"])
    return row


async def set_app_binding_policy(app_name: str, policy_id: int | None) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            "UPDATE app_bindings SET routing_policy_id = ? WHERE app_name = ?",
            (policy_id, app_name),
        )
        await db.commit()


# ── app_bindings ────────────────────────────────────────────────────────────

async def upsert_app_binding(app_name: str, base_url: str,
                              api_key_masked: str, last_error: str = "") -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            """INSERT INTO app_bindings(app_name, base_url, api_key_masked, last_error)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(app_name) DO UPDATE SET
                   base_url = excluded.base_url,
                   api_key_masked = excluded.api_key_masked,
                   last_written_at = datetime('now'),
                   last_error = excluded.last_error""",
            (app_name, base_url, api_key_masked, last_error),
        )
        await db.commit()


async def list_app_bindings() -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM app_bindings ORDER BY app_name"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]

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
                protocol     TEXT    NOT NULL DEFAULT 'openai',  -- openai / anthropic / gemini_native
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
        # 迁移：旧库补 protocol 列
        async with db.execute("PRAGMA table_info(local_providers)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "protocol" not in cols:
            await db.execute("ALTER TABLE local_providers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'")

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
    await init_scenarios()
    await init_provider_cooldowns()
    await init_routing_rules()


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
    protocol: str = "openai",
) -> int:
    """新增一个 provider 实例，返回 rowid。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO local_providers
               (provider_id, display_name, tier, base_url, auth_type, key_ref, models,
                price_in, price_out, protocol)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                provider_id, display_name, tier, base_url, auth_type, key_ref,
                json.dumps(models or []), price_in, price_out, protocol,
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
        "enabled", "priority", "price_in", "price_out", "protocol",
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
    scenario_id: int | None = None,
) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            """INSERT INTO call_logs
               (app_source, model, routed_to, tier, input_tokens, output_tokens,
                latency_ms, success, error_msg, cached, scenario_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (app_source, model, routed_to, tier, input_tokens, output_tokens,
             latency_ms, int(success), error_msg, int(cached), scenario_id),
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


# ── scenarios（v2.1 redesign：场景 = 独立 API Key + 独立降级链） ──────────


def _slugify(name: str) -> str:
    """中文 / 非 ASCII 名称压缩成短 slug。"""
    import re
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (name or "").lower()).strip("-")
    return (s[:10] or "scn")


def make_scenario_key(name: str) -> str:
    """tb-{slug}-{16char hex} —— scenario 的 API Key 格式。"""
    return f"tb-{_slugify(name)}-{secrets.token_hex(8)}"


BUILTIN_ROUTING_RULES = [
    {
        "name": "long-context-quality",
        "match_kind": "token_count_gt",
        "match_value": "8000",
        "target_model": "claude-opus-4-7",
        "target_provider": "",      # 空 = 任意 provider，仅强制 model
        "priority": 10,
        "enabled": 1,
        "description": "长上下文（≥8K tokens）走 Claude Opus 4.7（1M ctx）/ Gemini 2.5 Pro",
    },
    {
        "name": "tools-quality",
        "match_kind": "has_tools",
        "match_value": "true",
        "target_model": "gpt-5.5",
        "target_provider": "",
        "priority": 20,
        "enabled": 1,
        "description": "含工具调用走 GPT-5.5（agent 场景 tools 准确度更高）",
    },
    {
        "name": "code-review",
        "match_kind": "system_regex",
        "match_value": "(?i)\\b(review|critique|refactor|代码评审|重构|审计)\\b",
        "target_model": "claude-sonnet-4-6",
        "target_provider": "",
        "priority": 30,
        "enabled": 1,
        "description": "system prompt 含 review/critique/重构 → Claude Sonnet 4.6",
    },
    {
        "name": "commit-msg-cheap",
        "match_kind": "system_regex",
        "match_value": "(?i)\\b(commit message|git commit|生成提交)\\b",
        "target_model": "llama-4-8b-instant",
        "target_provider": "groq",
        "priority": 40,
        "enabled": 1,
        "description": "commit message 这种短任务走 Groq Llama-4-8b 免费快速",
    },
    {
        "name": "translation-cheap",
        "match_kind": "system_regex",
        "match_value": "(?i)\\b(translate|翻译|译成)\\b",
        "target_model": "qwen-3-32b",
        "target_provider": "groq",
        "priority": 50,
        "enabled": 1,
        "description": "翻译任务走 Qwen 3 32B（中英都强）",
    },
    {
        "name": "explicit-hint",
        "match_kind": "header_hint",
        "match_value": "*",               # 任意 X-LLP-Hint 值都触发
        "target_model": "",                # 由 header 值决定 model
        "target_provider": "",
        "priority": 1,                     # 最高优先级
        "enabled": 1,
        "description": "客户端显式 X-LLP-Hint 头时取头值作 model 名",
    },
]


async def init_routing_rules() -> None:
    """Prompt 分析规则表 + 6 条 builtin 规则灌入。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS routing_rules (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT UNIQUE NOT NULL,
                match_kind      TEXT NOT NULL,
                match_value     TEXT NOT NULL,
                target_model    TEXT DEFAULT '',
                target_provider TEXT DEFAULT '',
                priority        INTEGER DEFAULT 100,
                enabled         INTEGER DEFAULT 1,
                is_builtin      INTEGER DEFAULT 0,
                description     TEXT DEFAULT '',
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)
        for r in BUILTIN_ROUTING_RULES:
            await db.execute(
                """INSERT OR IGNORE INTO routing_rules
                   (name, match_kind, match_value, target_model, target_provider,
                    priority, enabled, is_builtin, description)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (r["name"], r["match_kind"], r["match_value"], r["target_model"],
                 r["target_provider"], r["priority"], r["enabled"], r["description"]),
            )
        await db.commit()


async def list_routing_rules(enabled_only: bool = False) -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        sql = "SELECT * FROM routing_rules"
        if enabled_only:
            sql += " WHERE enabled = 1"
        sql += " ORDER BY priority ASC, id ASC"
        async with db.execute(sql) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def upsert_routing_rule(name: str, match_kind: str, match_value: str,
                                target_model: str = "", target_provider: str = "",
                                priority: int = 100, enabled: bool = True,
                                description: str = "") -> int:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            """INSERT INTO routing_rules
               (name, match_kind, match_value, target_model, target_provider,
                priority, enabled, is_builtin, description)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
               ON CONFLICT(name) DO UPDATE SET
                 match_kind = excluded.match_kind,
                 match_value = excluded.match_value,
                 target_model = excluded.target_model,
                 target_provider = excluded.target_provider,
                 priority = excluded.priority,
                 enabled = excluded.enabled,
                 description = excluded.description""",
            (name, match_kind, match_value, target_model, target_provider,
             priority, int(enabled), description),
        )
        async with db.execute("SELECT id FROM routing_rules WHERE name = ?", (name,)) as cur:
            row = await cur.fetchone()
        await db.commit()
    return row[0] if row else 0


async def toggle_routing_rule(rule_id: int, enabled: bool) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("UPDATE routing_rules SET enabled = ? WHERE id = ?", (int(enabled), rule_id))
        await db.commit()


async def delete_routing_rule(rule_id: int) -> bool:
    """非内置规则才能删。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        async with db.execute("SELECT is_builtin FROM routing_rules WHERE id = ?", (rule_id,)) as cur:
            r = await cur.fetchone()
        if not r or r[0]:
            return False
        await db.execute("DELETE FROM routing_rules WHERE id = ?", (rule_id,))
        await db.commit()
    return True


async def init_provider_cooldowns() -> None:
    """provider 临时下线表（429 / 上游 quota 耗尽 / 网络重试用）。

    cooldown_until 是 unix epoch；过了即视为恢复。
    """
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS provider_cooldowns (
                provider_id    INTEGER PRIMARY KEY,        -- local_providers.id
                cooldown_until INTEGER NOT NULL,           -- unix seconds; > now() = in cooldown
                reason         TEXT DEFAULT '',
                count_429      INTEGER DEFAULT 0,
                last_429_at    INTEGER DEFAULT 0,
                updated_at     TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


async def set_provider_cooldown(
    provider_row_id: int,
    cooldown_seconds: int,
    reason: str = "",
) -> int:
    """标记 provider 冷却 N 秒。返回 cooldown_until 时间戳。"""
    cooldown_until = int(time.time()) + max(1, cooldown_seconds)
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            """INSERT INTO provider_cooldowns(provider_id, cooldown_until, reason, count_429, last_429_at)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(provider_id) DO UPDATE SET
                 cooldown_until = excluded.cooldown_until,
                 reason         = excluded.reason,
                 count_429      = count_429 + 1,
                 last_429_at    = excluded.last_429_at,
                 updated_at     = datetime('now')""",
            (provider_row_id, cooldown_until, reason, int(time.time())),
        )
        await db.commit()
    return cooldown_until


async def get_provider_cooldown(provider_row_id: int) -> dict | None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM provider_cooldowns WHERE provider_id = ?", (provider_row_id,)
        ) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def list_active_cooldowns() -> dict[int, dict]:
    """返回 {provider_row_id: cooldown_record}，只含未到期的。"""
    now_ts = int(time.time())
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM provider_cooldowns WHERE cooldown_until > ?", (now_ts,)
        ) as cur:
            return {r["provider_id"]: dict(r) for r in await cur.fetchall()}


async def clear_provider_cooldown(provider_row_id: int) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            "DELETE FROM provider_cooldowns WHERE provider_id = ?", (provider_row_id,)
        )
        await db.commit()


async def init_scenarios() -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS scenarios (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                name              TEXT NOT NULL,
                api_key           TEXT UNIQUE NOT NULL,
                degradation_chain TEXT NOT NULL DEFAULT '[]',
                description       TEXT DEFAULT '',
                created_at        TEXT DEFAULT (datetime('now')),
                updated_at        TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_scenarios_api_key ON scenarios(api_key)"
        )
        # 给 call_logs 加 scenario_id 列（迁移）
        async with db.execute("PRAGMA table_info(call_logs)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "scenario_id" not in cols:
            await db.execute("ALTER TABLE call_logs ADD COLUMN scenario_id INTEGER")
        await db.commit()


async def create_scenario(name: str, degradation_chain: list[dict] | None = None,
                            description: str = "") -> dict:
    api_key = make_scenario_key(name)
    chain_json = json.dumps(degradation_chain or [])
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO scenarios (name, api_key, degradation_chain, description) "
            "VALUES (?, ?, ?, ?)",
            (name, api_key, chain_json, description),
        )
        await db.commit()
        sid = cur.lastrowid
    return {"id": sid, "name": name, "api_key": api_key,
            "degradation_chain": degradation_chain or [], "description": description}


async def list_scenarios() -> list[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM scenarios ORDER BY id ASC"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        try:
            r["degradation_chain"] = json.loads(r["degradation_chain"] or "[]")
        except json.JSONDecodeError:
            r["degradation_chain"] = []
    return rows


async def get_scenario(scenario_id: int) -> Optional[dict]:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM scenarios WHERE id = ?", (scenario_id,)
        ) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    try:
        row["degradation_chain"] = json.loads(row["degradation_chain"] or "[]")
    except json.JSONDecodeError:
        row["degradation_chain"] = []
    return row


async def get_scenario_by_api_key(api_key: str) -> Optional[dict]:
    if not api_key or not api_key.startswith("tb-"):
        return None
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM scenarios WHERE api_key = ?", (api_key,)
        ) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    try:
        row["degradation_chain"] = json.loads(row["degradation_chain"] or "[]")
    except json.JSONDecodeError:
        row["degradation_chain"] = []
    return row


async def update_scenario(scenario_id: int, *, name: str | None = None,
                            degradation_chain: list[dict] | None = None,
                            description: str | None = None) -> bool:
    updates = []
    args = []
    if name is not None:
        updates.append("name = ?")
        args.append(name)
    if degradation_chain is not None:
        updates.append("degradation_chain = ?")
        args.append(json.dumps(degradation_chain))
    if description is not None:
        updates.append("description = ?")
        args.append(description)
    if not updates:
        return False
    updates.append("updated_at = datetime('now')")
    args.append(scenario_id)
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            f"UPDATE scenarios SET {', '.join(updates)} WHERE id = ?", args
        )
        await db.commit()
    return True


async def rotate_scenario_key(scenario_id: int) -> Optional[str]:
    scenario = await get_scenario(scenario_id)
    if not scenario:
        return None
    new_key = make_scenario_key(scenario["name"])
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            "UPDATE scenarios SET api_key = ?, updated_at = datetime('now') WHERE id = ?",
            (new_key, scenario_id),
        )
        await db.commit()
    return new_key


async def delete_scenario(scenario_id: int) -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("DELETE FROM scenarios WHERE id = ?", (scenario_id,))
        await db.commit()


async def scenario_call_stats(scenario_id: int, since_iso: str | None = None) -> dict:
    sql = (
        "SELECT COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS total_tokens, "
        "AVG(latency_ms) AS avg_latency_ms, "
        "SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS success "
        "FROM call_logs WHERE scenario_id = ?"
    )
    args: list = [scenario_id]
    if since_iso:
        sql += " AND timestamp >= ?"
        args.append(since_iso)
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, args) as cur:
            r = await cur.fetchone()
    if not r:
        return {"calls": 0, "total_tokens": 0, "avg_latency_ms": 0, "success_rate": 1.0}
    calls = r["calls"] or 0
    return {
        "calls": calls,
        "total_tokens": r["total_tokens"] or 0,
        "avg_latency_ms": round(r["avg_latency_ms"] or 0, 1),
        "success_rate": round((r["success"] or 0) / calls, 3) if calls > 0 else 1.0,
    }


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

"""SQLite 数据库操作层（全部异步）"""

import os
import random
import secrets
from datetime import datetime
from typing import Optional

import aiosqlite

DB_PATH = os.getenv("DB_PATH", "proxy.db")


# ── 初始化 & 迁移 ─────────────────────────────────────────────────────────────

async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        # api_keys（原表）
        await db.execute("""
            CREATE TABLE IF NOT EXISTS api_keys (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                key        TEXT    UNIQUE NOT NULL,
                note       TEXT    DEFAULT '',
                is_active  INTEGER DEFAULT 1,
                user_id    INTEGER REFERENCES users(id),
                created_at TEXT    DEFAULT (datetime('now'))
            )
        """)

        # users
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                email             TEXT UNIQUE NOT NULL,
                nickname          TEXT DEFAULT '',
                password_hash     TEXT NOT NULL,
                credits_balance   REAL DEFAULT 0,
                credits_earned    REAL DEFAULT 0,
                credits_spent     REAL DEFAULT 0,
                referral_code     TEXT UNIQUE NOT NULL,
                referred_by       INTEGER REFERENCES users(id),
                show_on_wall      INTEGER DEFAULT 1,
                wall_display      TEXT DEFAULT 'masked',
                can_create_apikey INTEGER DEFAULT 1,
                worker_key        TEXT UNIQUE,
                created_at        TEXT DEFAULT (datetime('now'))
            )
        """)

        # model_configs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS model_configs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT UNIQUE NOT NULL,
                display_name    TEXT DEFAULT '',
                tier            TEXT NOT NULL DEFAULT 'open',
                contribute_rate REAL NOT NULL DEFAULT 8,
                consume_rate    REAL NOT NULL DEFAULT 5,
                enabled         INTEGER DEFAULT 1,
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)

        # transactions
        await db.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id      INTEGER NOT NULL REFERENCES users(id),
                type         TEXT NOT NULL,
                model_name   TEXT DEFAULT '',
                tokens       INTEGER DEFAULT 0,
                base_credits REAL DEFAULT 0,
                multiplier   REAL DEFAULT 1.0,
                delta        REAL NOT NULL,
                balance      REAL NOT NULL,
                note         TEXT DEFAULT '',
                created_at   TEXT DEFAULT (datetime('now'))
            )
        """)

        # settlement_logs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS settlement_logs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                worker_id       TEXT NOT NULL,
                user_id         INTEGER REFERENCES users(id),
                period_start    TEXT NOT NULL,
                period_end      TEXT NOT NULL,
                online_mins     REAL DEFAULT 0,
                output_tokens   INTEGER DEFAULT 0,
                avg_latency_ms  REAL DEFAULT 0,
                success_rate    REAL DEFAULT 0,
                multiplier      REAL DEFAULT 1.0,
                credits_awarded REAL DEFAULT 0,
                created_at      TEXT DEFAULT (datetime('now'))
            )
        """)

        # purchase_orders
        await db.execute("""
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        INTEGER NOT NULL REFERENCES users(id),
                amount_credits REAL NOT NULL,
                note           TEXT DEFAULT '',
                status         TEXT DEFAULT 'pending',
                admin_note     TEXT DEFAULT '',
                created_at     TEXT DEFAULT (datetime('now'))
            )
        """)

        # system_config
        await db.execute("""
            CREATE TABLE IF NOT EXISTS system_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            )
        """)

        # checkins
        await db.execute("""
            CREATE TABLE IF NOT EXISTS checkins (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(user_id, date)
            )
        """)

        # spin_logs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS spin_logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)

        # scene_routes
        await db.execute("""
            CREATE TABLE IF NOT EXISTS scene_routes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL REFERENCES users(id),
                scene_name  TEXT NOT NULL,
                icon        TEXT DEFAULT '🔀',
                steps       TEXT NOT NULL DEFAULT '[]',
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)

        # 默认配置项
        for k, v in [
            ("referral_reward", "100"),
            ("newcomer_reward", "50"),
            ("contact_info", ""),
            ("checkin_reward", "5"),
            ("spin_daily_limit", "3"),
            ("spin_max_credits", "50"),
        ]:
            await db.execute(
                "INSERT OR IGNORE INTO system_config(key,value) VALUES(?,?)", (k, v)
            )

        await db.commit()

    await _migrate()
    await _migrate_apikey_default_open()
    await _migrate_checkins()
    await _migrate_spin_logs()
    await _migrate_virtual_agents()
    await _migrate_image_support()
    await _migrate_scene_routes()


async def _migrate() -> None:
    """补齐早期 SQLite 库缺失列（仅 api_keys.user_id）"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("PRAGMA table_info(api_keys)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "user_id" not in cols:
            await db.execute("ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id)")
        await db.commit()


async def _migrate_checkins() -> None:
    """补齐 checkins 表和 checkin_reward 配置（早期数据库无此表）"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS checkins (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(user_id, date)
            )
        """)
        await db.execute(
            "INSERT OR IGNORE INTO system_config(key,value) VALUES('checkin_reward','5')"
        )
        await db.commit()


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


async def _migrate_virtual_agents() -> None:
    """补齐 virtual_agents 表和 users.is_virtual 列（早期数据库无此结构）"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("PRAGMA table_info(users)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "is_virtual" not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN is_virtual INTEGER DEFAULT 0")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS virtual_agents (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                base_url   TEXT NOT NULL,
                api_key    TEXT NOT NULL,
                api_style  TEXT NOT NULL DEFAULT 'openai',
                models     TEXT NOT NULL DEFAULT '[]',
                enabled    INTEGER DEFAULT 1,
                user_id    INTEGER REFERENCES users(id),
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


async def _migrate_image_support() -> None:
    """Add model_type column to model_configs and image_tokens_weight system config."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("PRAGMA table_info(model_configs)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "model_type" not in cols:
            await db.execute(
                "ALTER TABLE model_configs ADD COLUMN model_type TEXT NOT NULL DEFAULT 'chat'"
            )
        await db.execute(
            "INSERT OR IGNORE INTO system_config(key,value) VALUES('image_tokens_weight','2000')"
        )
        await db.commit()


async def _migrate_apikey_default_open() -> None:
    """一次性迁移：全体用户默认可自助创建 API Key（无需管理员预先开通）"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM system_config WHERE key='migrate_selfserve_apikey_v1'"
        ) as cur:
            if await cur.fetchone():
                return
        await db.execute("UPDATE users SET can_create_apikey=1")
        await db.execute(
            "INSERT INTO system_config(key,value) VALUES('migrate_selfserve_apikey_v1','1')"
        )
        await db.commit()


# ── api_keys ──────────────────────────────────────────────────────────────────

async def create_key(note: str, user_id: Optional[int] = None) -> dict:
    key = "sk-" + secrets.token_urlsafe(32)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO api_keys (key, note, user_id) VALUES (?,?,?)",
            (key, note, user_id),
        )
        await db.commit()
        return {
            "id": cur.lastrowid,
            "key": key,
            "note": note,
            "is_active": 1,
            "user_id": user_id,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }


async def list_keys(user_id: Optional[int] = None) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if user_id is None:
            sql = "SELECT * FROM api_keys ORDER BY created_at DESC"
            args = ()
        else:
            sql = "SELECT * FROM api_keys WHERE user_id=? ORDER BY created_at DESC"
            args = (user_id,)
        async with db.execute(sql, args) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def set_key_active(key_id: int, is_active: bool, user_id: Optional[int] = None) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is None:
            await db.execute("UPDATE api_keys SET is_active=? WHERE id=?", (int(is_active), key_id))
        else:
            await db.execute(
                "UPDATE api_keys SET is_active=? WHERE id=? AND user_id=?",
                (int(is_active), key_id, user_id),
            )
        await db.commit()


async def delete_key(key_id: int, user_id: Optional[int] = None) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is None:
            await db.execute("DELETE FROM api_keys WHERE id=?", (key_id,))
        else:
            await db.execute("DELETE FROM api_keys WHERE id=? AND user_id=?", (key_id, user_id))
        await db.commit()


async def verify_key(key: str) -> Optional[dict]:
    """返回 key 记录（含 user_id），无效/禁用返回 None"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, user_id, is_active FROM api_keys WHERE key=?", (key,)
        ) as cur:
            row = await cur.fetchone()
            if row and row["is_active"]:
                return dict(row)
            return None


# ── users ─────────────────────────────────────────────────────────────────────

async def create_user(email: str, nickname: str, password_hash: str, referred_by: Optional[int]) -> dict:
    ref_code = "REF-" + secrets.token_urlsafe(6).upper()
    worker_key = "wk-" + secrets.token_urlsafe(32)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO users
               (email, nickname, password_hash, referral_code, referred_by, worker_key,
                can_create_apikey)
               VALUES (?,?,?,?,?,?,1)""",
            (email, nickname, password_hash, ref_code, referred_by, worker_key),
        )
        await db.commit()
        return {"id": cur.lastrowid, "email": email, "nickname": nickname,
                "referral_code": ref_code, "worker_key": worker_key}


async def get_user_by_email(email: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE email=?", (email,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def get_user_by_id(user_id: int) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE id=?", (user_id,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def get_user_by_worker_key(worker_key: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE worker_key=?", (worker_key,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def get_user_by_referral_code(code: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE referral_code=?", (code,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def list_users() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id,email,nickname,credits_balance,credits_earned,credits_spent,"
            "can_create_apikey,referral_code,created_at FROM users ORDER BY created_at DESC"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def set_user_apikey_permission(user_id: int, can: bool) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET can_create_apikey=? WHERE id=?", (int(can), user_id))
        await db.commit()


async def adjust_user_credits(user_id: int, delta: float, note: str = "") -> float:
    """管理员手动调整积分，返回新余额"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT credits_balance FROM users WHERE id=?", (user_id,)) as cur:
            row = await cur.fetchone()
            if not row:
                raise ValueError("User not found")
            new_balance = row[0] + delta
        await db.execute(
            "UPDATE users SET credits_balance=?, credits_earned=credits_earned+? WHERE id=? AND ?>=0",
            (new_balance, max(delta, 0), user_id, delta),
        )
        if delta < 0:
            await db.execute(
                "UPDATE users SET credits_spent=credits_spent+? WHERE id=?",
                (-delta, user_id),
            )
        await db.execute(
            "INSERT INTO transactions(user_id,type,delta,balance,note) VALUES(?,?,?,?,?)",
            (user_id, "adjust", delta, new_balance, note),
        )
        await db.commit()
        return new_balance


# ── 积分操作 ──────────────────────────────────────────────────────────────────

async def award_credits(user_id: int, delta: float, type_: str,
                        model_name: str = "", tokens: int = 0,
                        base_credits: float = 0, multiplier: float = 1.0,
                        note: str = "") -> float:
    """给用户增加积分，返回新余额"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT credits_balance FROM users WHERE id=?", (user_id,)) as cur:
            row = await cur.fetchone()
            if not row:
                return 0.0
            new_balance = row[0] + delta
        await db.execute(
            "UPDATE users SET credits_balance=?, credits_earned=credits_earned+? WHERE id=?",
            (new_balance, delta, user_id),
        )
        await db.execute(
            """INSERT INTO transactions
               (user_id,type,model_name,tokens,base_credits,multiplier,delta,balance,note)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (user_id, type_, model_name, tokens, base_credits, multiplier, delta, new_balance, note),
        )
        await db.commit()
        return new_balance


async def deduct_credits(user_id: int, delta: float, model_name: str = "", tokens: int = 0) -> tuple[bool, float]:
    """消费积分，余额不足返回 (False, balance)，成功返回 (True, new_balance)"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT credits_balance FROM users WHERE id=?", (user_id,)) as cur:
            row = await cur.fetchone()
            if not row or row[0] < delta:
                return False, (row[0] if row else 0.0)
            new_balance = row[0] - delta
        await db.execute(
            "UPDATE users SET credits_balance=?, credits_spent=credits_spent+? WHERE id=?",
            (new_balance, delta, user_id),
        )
        await db.execute(
            "INSERT INTO transactions(user_id,type,model_name,tokens,delta,balance) VALUES(?,?,?,?,?,?)",
            (user_id, "consume", model_name, tokens, -delta, new_balance),
        )
        await db.commit()
        return True, new_balance


async def consume_credits_for_usage(
    user_id: int | None, model: str, usage: dict | None
) -> None:
    """按 OpenAI/兼容 usage 与模型消费率扣积分；无 user_id、无 tokens 或费率为 0 时跳过。"""
    if not user_id or not usage:
        return
    u = usage
    total_tokens = int(
        (u.get("prompt_tokens") or u.get("input_tokens") or 0)
        + (u.get("completion_tokens") or u.get("output_tokens") or 0)
    )
    if total_tokens <= 0 and u.get("total_tokens"):
        total_tokens = int(u["total_tokens"])
    if total_tokens <= 0:
        return
    rate = await get_consume_rate(model)
    if rate:
        cost = total_tokens / 1000 * rate
        await deduct_credits(user_id, cost, model_name=model, tokens=total_tokens)


async def get_transactions(user_id: int, limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── model_configs ─────────────────────────────────────────────────────────────

async def list_model_configs(enabled_only: bool = False) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        sql = "SELECT * FROM model_configs"
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY tier, name"
        async with db.execute(sql) as cur:
            return [dict(r) for r in await cur.fetchall()]


# Worker 首次上报、后台尚未配置的模型：自动按 open 层默认倍率入库（不覆盖管理员已有配置）
_OPEN_DEFAULT_CONTRIBUTE = 8.0
_OPEN_DEFAULT_CONSUME = 5.0


async def ensure_default_open_models(
    names: list[str], model_types: dict[str, str] | None = None
) -> list[str]:
    """Insert missing model names with open defaults; update model_type if it changed.
    model_types maps name → type ('chat' | 'image')."""
    if not names:
        return []
    model_types = model_types or {}
    created: list[str] = []
    async with aiosqlite.connect(DB_PATH) as db:
        for name in names:
            mtype = model_types.get(name, "chat")
            async with db.execute(
                "SELECT model_type FROM model_configs WHERE name=?", (name,)
            ) as cur:
                row = await cur.fetchone()
            if row is None:
                await db.execute(
                    """INSERT INTO model_configs
                       (name,display_name,tier,contribute_rate,consume_rate,enabled,model_type)
                       VALUES(?,?,?,?,?,?,?)""",
                    (name, name, "open", _OPEN_DEFAULT_CONTRIBUTE, _OPEN_DEFAULT_CONSUME, 1, mtype),
                )
                created.append(name)
            elif row[0] != mtype:
                # Worker re-registered with a different type — sync the column
                await db.execute(
                    "UPDATE model_configs SET model_type=? WHERE name=?", (mtype, name)
                )
        await db.commit()
    return created


async def upsert_model_config(
    name: str, display_name: str, tier: str,
    contribute_rate: float, consume_rate: float,
    enabled: bool, model_type: str = "chat"
) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO model_configs
               (name,display_name,tier,contribute_rate,consume_rate,enabled,model_type)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(name) DO UPDATE SET
                 display_name=excluded.display_name,
                 tier=excluded.tier,
                 contribute_rate=excluded.contribute_rate,
                 consume_rate=excluded.consume_rate,
                 enabled=excluded.enabled,
                 model_type=excluded.model_type""",
            (name, display_name, tier, contribute_rate, consume_rate, int(enabled), model_type),
        )
        await db.commit()
    return {"name": name, "tier": tier, "contribute_rate": contribute_rate,
            "consume_rate": consume_rate, "enabled": enabled, "model_type": model_type}


async def delete_model_config(name: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM model_configs WHERE name=?", (name,))
        await db.commit()


async def get_contribute_rate(model_name: str) -> Optional[float]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT contribute_rate FROM model_configs WHERE name=? AND enabled=1", (model_name,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def get_consume_rate(model_name: str) -> Optional[float]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT consume_rate FROM model_configs WHERE name=? AND enabled=1", (model_name,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def get_image_tokens_weight() -> int:
    val = await get_config("image_tokens_weight", "2000")
    try:
        return int(val)
    except ValueError:
        return 2000


# ── settlement_logs ───────────────────────────────────────────────────────────

async def log_settlement(worker_id: str, user_id: int, period_start: str, period_end: str,
                         online_mins: float, output_tokens: int, avg_latency: float,
                         success_rate: float, multiplier: float, credits_awarded: float) -> None:
    """avg_latency 写入 avg_latency_ms 列：语义为首 Token 平均延迟（ms）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO settlement_logs
               (worker_id,user_id,period_start,period_end,online_mins,output_tokens,
                avg_latency_ms,success_rate,multiplier,credits_awarded)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (worker_id, user_id, period_start, period_end, online_mins, output_tokens,
             avg_latency, success_rate, multiplier, credits_awarded),
        )
        await db.commit()


async def get_settlements(user_id: int, limit: int = 30) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM settlement_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── purchase_orders ───────────────────────────────────────────────────────────

async def create_purchase_order(user_id: int, amount_credits: float, note: str) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO purchase_orders(user_id,amount_credits,note) VALUES(?,?,?)",
            (user_id, amount_credits, note),
        )
        await db.commit()
        return {"id": cur.lastrowid, "user_id": user_id,
                "amount_credits": amount_credits, "note": note, "status": "pending"}


async def list_purchase_orders(status: Optional[str] = None) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if status:
            sql, args = "SELECT po.*,u.email,u.nickname FROM purchase_orders po JOIN users u ON po.user_id=u.id WHERE po.status=? ORDER BY po.created_at DESC", (status,)
        else:
            sql, args = "SELECT po.*,u.email,u.nickname FROM purchase_orders po JOIN users u ON po.user_id=u.id ORDER BY po.created_at DESC", ()
        async with db.execute(sql, args) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def approve_purchase_order(order_id: int, admin_note: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM purchase_orders WHERE id=?", (order_id,)) as cur:
            order = dict(await cur.fetchone())
        await db.execute(
            "UPDATE purchase_orders SET status='approved', admin_note=? WHERE id=?",
            (admin_note, order_id),
        )
        await db.commit()
    await award_credits(
        order["user_id"], order["amount_credits"],
        type_="purchase", note=f"order_id={order_id} {admin_note}",
    )


async def reject_purchase_order(order_id: int, admin_note: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE purchase_orders SET status='rejected', admin_note=? WHERE id=?",
            (admin_note, order_id),
        )
        await db.commit()


async def get_user_purchase_orders(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM purchase_orders WHERE user_id=? ORDER BY created_at DESC",
            (user_id,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── system_config ─────────────────────────────────────────────────────────────

async def get_config(key: str, default: str = "") -> str:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT value FROM system_config WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
            return row[0] if row else default


async def set_config(key: str, value: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO system_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        await db.commit()


async def get_all_configs() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key,value FROM system_config") as cur:
            return {r[0]: r[1] for r in await cur.fetchall()}


# ── 鸣谢墙 ────────────────────────────────────────────────────────────────────

# ── 每日签到 ──────────────────────────────────────────────────────────────────

async def do_checkin(user_id: int) -> dict:
    """执行签到：已签到返回 already=True；否则发放积分并记录。"""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT credits FROM checkins WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            row = await cur.fetchone()
        if row:
            return {"already": True, "credits": row[0], "date": today}
        reward = float(await get_config("checkin_reward", "5"))
        try:
            await db.execute(
                "INSERT INTO checkins(user_id, date, credits) VALUES(?,?,?)",
                (user_id, today, reward),
            )
            await db.commit()
        except Exception:
            # race condition: another request just inserted — treat as already done
            return {"already": True, "credits": reward, "date": today}
    new_balance = await award_credits(user_id, reward, type_="checkin", note=f"每日签到 {today}")
    return {"already": False, "credits": reward, "new_balance": new_balance, "date": today}


async def get_checkin_status(user_id: int) -> dict:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    reward = float(await get_config("checkin_reward", "5"))
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT credits FROM checkins WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            row = await cur.fetchone()
        async with db.execute(
            "SELECT COUNT(*) FROM checkins WHERE user_id=?", (user_id,)
        ) as cur:
            total = (await cur.fetchone())[0]
    return {
        "checked_in_today": row is not None,
        "credits_today": row[0] if row else 0,
        "total_checkins": total,
        "reward": reward,
    }


# ── 转盘抽奖 ──────────────────────────────────────────────────────────────

_SPIN_PRIZES  = [1,    3,    5,    15,   25,   50  ]
_SPIN_WEIGHTS = [0.25, 0.25, 0.20, 0.15, 0.10, 0.05]

def _weighted_spin_credits(max_credits: int = 50) -> int:
    """Return a fixed prize value sampled by probability, capped to max_credits."""
    valid = [(v, w) for v, w in zip(_SPIN_PRIZES, _SPIN_WEIGHTS) if v <= max_credits]
    if not valid:
        return 0
    values, weights = zip(*valid)
    total = sum(weights)
    return random.choices(values, weights=[w / total for w in weights], k=1)[0]


async def do_spin(user_id: int) -> dict:
    """Execute one spin. Returns already=True if daily limit reached."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    daily_limit = int(await get_config("spin_daily_limit", "3"))
    max_credits = int(await get_config("spin_max_credits", "50"))
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("BEGIN IMMEDIATE")
        async with db.execute(
            "SELECT COUNT(*) FROM spin_logs WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            spins_used = (await cur.fetchone())[0]
        if spins_used >= daily_limit:
            await db.execute("ROLLBACK")
            return {"already": True, "spins_used": spins_used, "spins_left": 0, "daily_limit": daily_limit}
        credits = _weighted_spin_credits(max_credits)
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


# ── virtual_agents ────────────────────────────────────────────────────────────

async def create_virtual_agent(name: str, base_url: str, api_key: str,
                                api_style: str, models_list: list,
                                enabled: bool = True) -> dict:
    """创建虚拟 Agent，同时创建关联虚拟账户，返回新记录。"""
    import json as _json
    ref_code = "VREF-" + secrets.token_urlsafe(6).upper()
    worker_key = "vwk-" + secrets.token_urlsafe(32)
    virtual_email = f"virtual-{secrets.token_urlsafe(8)}@virtual.local"
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO users
               (email, nickname, password_hash, referral_code, worker_key, is_virtual, can_create_apikey)
               VALUES (?,?,?,?,?,1,0)""",
            (virtual_email, name, "", ref_code, worker_key),
        )
        virtual_user_id = cur.lastrowid
        models_json = _json.dumps(models_list)
        cur2 = await db.execute(
            """INSERT INTO virtual_agents (name, base_url, api_key, api_style, models, enabled, user_id)
               VALUES (?,?,?,?,?,?,?)""",
            (name, base_url, api_key, api_style, models_json, int(enabled), virtual_user_id),
        )
        await db.commit()
        return {
            "id": cur2.lastrowid, "name": name, "base_url": base_url,
            "api_style": api_style, "models": models_list,
            "enabled": int(enabled), "user_id": virtual_user_id,
        }


async def list_virtual_agents(enabled_only: bool = False) -> list:
    import json as _json
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        sql = "SELECT * FROM virtual_agents"
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY created_at DESC"
        async with db.execute(sql) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        r["models"] = _json.loads(r["models"] or "[]")
    return rows


async def get_virtual_agent(agent_id: int) -> Optional[dict]:
    import json as _json
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM virtual_agents WHERE id=?", (agent_id,)) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    row["models"] = _json.loads(row["models"] or "[]")
    return row


async def update_virtual_agent(agent_id: int, name: str, base_url: str,
                                api_key: str, api_style: str,
                                models_list: list, enabled: bool) -> None:
    """api_key 为空串时不更新密钥字段。"""
    import json as _json
    models_json = _json.dumps(models_list)
    async with aiosqlite.connect(DB_PATH) as db:
        if api_key:
            await db.execute(
                """UPDATE virtual_agents
                   SET name=?,base_url=?,api_key=?,api_style=?,models=?,enabled=?
                   WHERE id=?""",
                (name, base_url, api_key, api_style, models_json, int(enabled), agent_id),
            )
        else:
            await db.execute(
                """UPDATE virtual_agents
                   SET name=?,base_url=?,api_style=?,models=?,enabled=?
                   WHERE id=?""",
                (name, base_url, api_style, models_json, int(enabled), agent_id),
            )
        await db.execute(
            "UPDATE users SET nickname=? WHERE id=(SELECT user_id FROM virtual_agents WHERE id=?)",
            (name, agent_id),
        )
        await db.commit()


async def delete_virtual_agent(agent_id: int) -> None:
    """删除虚拟 Agent 记录（保留虚拟用户账户以保留积分历史）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM virtual_agents WHERE id=?", (agent_id,))
        await db.commit()


async def _migrate_scene_routes() -> None:
    """Add scene_route_id + app_name to api_keys, and model_key to scene_routes if missing."""
    import uuid as _uuid
    async with aiosqlite.connect(DB_PATH) as db:
        # api_keys columns
        async with db.execute("PRAGMA table_info(api_keys)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "scene_route_id" not in cols:
            await db.execute(
                "ALTER TABLE api_keys ADD COLUMN scene_route_id INTEGER REFERENCES scene_routes(id)"
            )
        if "app_name" not in cols:
            await db.execute(
                "ALTER TABLE api_keys ADD COLUMN app_name TEXT DEFAULT ''"
            )
        # scene_routes.model_key
        async with db.execute("PRAGMA table_info(scene_routes)") as cur:
            sr_cols = {r[1] for r in await cur.fetchall()}
        if "model_key" not in sr_cols:
            await db.execute(
                "ALTER TABLE scene_routes ADD COLUMN model_key TEXT"
            )
            # backfill existing routes
            async with db.execute("SELECT id FROM scene_routes WHERE model_key IS NULL") as cur:
                rows = await cur.fetchall()
            for (rid,) in rows:
                mkey = "llm-router-" + _uuid.uuid4().hex[:12]
                await db.execute(
                    "UPDATE scene_routes SET model_key=? WHERE id=?", (mkey, rid)
                )
        await db.commit()


# ── Scene Routes ──────────────────────────────────────────────────────────────

async def list_scene_routes(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM scene_routes WHERE user_id=? ORDER BY id", (user_id,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def create_scene_route(user_id: int, scene_name: str, icon: str, steps: list) -> dict:
    import json as _json
    import uuid as _uuid
    steps_json = _json.dumps(steps, ensure_ascii=False)
    model_key  = "llm-router-" + _uuid.uuid4().hex[:12]
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO scene_routes(user_id, scene_name, icon, steps, model_key) VALUES(?,?,?,?,?)",
            (user_id, scene_name, icon, steps_json, model_key),
        )
        row_id = cur.lastrowid
        await db.commit()
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM scene_routes WHERE id=?", (row_id,)) as c:
            row = await c.fetchone()
    return dict(row)


async def update_scene_route(route_id: int, user_id: int, scene_name: str, icon: str, steps: list) -> bool:
    import json as _json
    steps_json = _json.dumps(steps, ensure_ascii=False)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE scene_routes SET scene_name=?, icon=?, steps=? WHERE id=? AND user_id=?",
            (scene_name, icon, steps_json, route_id, user_id),
        )
        await db.commit()
    return cur.rowcount > 0


async def delete_scene_route(route_id: int, user_id: int) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE api_keys SET scene_route_id=NULL WHERE scene_route_id=? AND user_id=?",
            (route_id, user_id),
        )
        cur = await db.execute(
            "DELETE FROM scene_routes WHERE id=? AND user_id=?", (route_id, user_id)
        )
        await db.commit()
    return cur.rowcount > 0


async def get_scene_route_by_key(key_id: int) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT sr.* FROM scene_routes sr
               JOIN api_keys ak ON ak.scene_route_id = sr.id
               WHERE ak.id=?""",
            (key_id,),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def bind_key_to_scene_route(key_id: int, user_id: int, scene_route_id: Optional[int], app_name: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE api_keys SET scene_route_id=?, app_name=? WHERE id=? AND user_id=?",
            (scene_route_id, app_name, key_id, user_id),
        )
        await db.commit()
    return cur.rowcount > 0


async def list_keys_with_scene(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT ak.id, ak.key, ak.note, ak.app_name, ak.is_active,
                      ak.scene_route_id, sr.scene_name, sr.icon, sr.steps, sr.model_key,
                      ak.created_at
               FROM api_keys ak
               LEFT JOIN scene_routes sr ON sr.id = ak.scene_route_id
               WHERE ak.user_id=?
               ORDER BY ak.id""",
            (user_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_dashboard_stats(user_id: int, days: int = 30) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT
                 ak.id        AS key_id,
                 ak.key       AS api_key,
                 ak.app_name,
                 ak.note,
                 sr.scene_name,
                 sr.icon,
                 COALESCE(SUM(t.tokens), 0)       AS total_tokens,
                 COALESCE(SUM(ABS(t.delta)), 0)   AS total_credits,
                 COUNT(t.id)                       AS request_count
               FROM api_keys ak
               LEFT JOIN scene_routes sr ON sr.id = ak.scene_route_id
               LEFT JOIN transactions t
                 ON t.user_id = ak.user_id
                 AND t.type = 'consume'
                 AND t.created_at >= datetime('now', ?)
               WHERE ak.user_id = ?
               GROUP BY ak.id
               ORDER BY total_tokens DESC""",
            (f"-{days} days", user_id),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_model_stats(user_id: int, days: int = 30) -> list[dict]:
    """Top models by request count from transactions."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT model_name,
                      COUNT(*) AS request_count,
                      COALESCE(SUM(tokens), 0) AS total_tokens,
                      COALESCE(SUM(ABS(delta)), 0) AS total_credits
               FROM transactions
               WHERE user_id=? AND type='consume'
                 AND model_name != ''
                 AND created_at >= datetime('now', ?)
               GROUP BY model_name
               ORDER BY request_count DESC
               LIMIT 10""",
            (user_id, f"-{days} days"),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_hourly_stats(user_id: int) -> list[int]:
    """Request counts per hour for today (list of 24 ints)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour,
                      COUNT(*) AS cnt
               FROM transactions
               WHERE user_id=? AND type='consume'
                 AND date(created_at, 'localtime') = date('now', 'localtime')
               GROUP BY hour""",
            (user_id,),
        ) as cur:
            rows = await cur.fetchall()
    hourly = [0] * 24
    for r in rows:
        hourly[r["hour"]] = r["cnt"]
    return hourly


async def get_wall_users(limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT u.id, u.nickname, u.wall_display, u.credits_earned,
                      (SELECT COUNT(*) FROM users r WHERE r.referred_by=u.id) AS referral_count,
                      CAST((julianday('now') - julianday(u.created_at)) AS INTEGER) AS days_online
               FROM users u
               WHERE u.show_on_wall=1 AND u.wall_display != 'hidden'
               ORDER BY (u.credits_earned*0.5 + (SELECT COUNT(*) FROM users r WHERE r.referred_by=u.id)*0.3 + CAST((julianday('now')-julianday(u.created_at)) AS INTEGER)*0.2) DESC
               LIMIT ?""",
            (limit,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]



"""SQLite 数据库操作层（全部异步）"""

import os
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

        # 默认配置项
        for k, v in [
            ("referral_reward", "100"),
            ("newcomer_reward", "50"),
            ("contact_info", ""),
        ]:
            await db.execute(
                "INSERT OR IGNORE INTO system_config(key,value) VALUES(?,?)", (k, v)
            )

        await db.commit()

    await _migrate()
    await _migrate_apikey_default_open()


async def _migrate() -> None:
    """补齐早期 SQLite 库缺失列（仅 api_keys.user_id）"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("PRAGMA table_info(api_keys)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "user_id" not in cols:
            await db.execute("ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id)")
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


async def upsert_model_config(name: str, display_name: str, tier: str,
                              contribute_rate: float, consume_rate: float, enabled: bool) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO model_configs(name,display_name,tier,contribute_rate,consume_rate,enabled)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(name) DO UPDATE SET
                 display_name=excluded.display_name,
                 tier=excluded.tier,
                 contribute_rate=excluded.contribute_rate,
                 consume_rate=excluded.consume_rate,
                 enabled=excluded.enabled""",
            (name, display_name, tier, contribute_rate, consume_rate, int(enabled)),
        )
        await db.commit()
        return {"name": name, "tier": tier, "contribute_rate": contribute_rate,
                "consume_rate": consume_rate, "enabled": enabled}


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


async def models_enabled_for_billing(names: list[str]) -> list[str]:
    """在线 Worker 上报的模型名中，仅保留已在 model_configs 启用且可计费的名称（与 get_consume_rate 一致）。"""
    if not names:
        return []
    uniq = sorted(set(names))
    placeholders = ",".join("?" * len(uniq))
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            f"SELECT name FROM model_configs WHERE enabled=1 AND name IN ({placeholders}) ORDER BY name",
            uniq,
        ) as cur:
            rows = await cur.fetchall()
            return [r[0] for r in rows]


# ── settlement_logs ───────────────────────────────────────────────────────────

async def log_settlement(worker_id: str, user_id: int, period_start: str, period_end: str,
                         online_mins: float, output_tokens: int, avg_latency: float,
                         success_rate: float, multiplier: float, credits_awarded: float) -> None:
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



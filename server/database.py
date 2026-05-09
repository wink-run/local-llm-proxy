import os
import secrets
from datetime import datetime

import aiosqlite

DB_PATH = os.getenv("DB_PATH", "proxy.db")


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS api_keys (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                key        TEXT    UNIQUE NOT NULL,
                note       TEXT    DEFAULT '',
                is_active  INTEGER DEFAULT 1,
                created_at TEXT    DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


async def create_key(note: str) -> dict:
    key = "sk-" + secrets.token_urlsafe(32)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO api_keys (key, note) VALUES (?, ?)", (key, note)
        )
        await db.commit()
        return {
            "id": cur.lastrowid,
            "key": key,
            "note": note,
            "is_active": 1,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }


async def list_keys() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, key, note, is_active, created_at FROM api_keys ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def set_key_active(key_id: int, is_active: bool) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE api_keys SET is_active=? WHERE id=?", (int(is_active), key_id)
        )
        await db.commit()


async def delete_key(key_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM api_keys WHERE id=?", (key_id,))
        await db.commit()


async def verify_key(key: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT is_active FROM api_keys WHERE key=?", (key,)
        ) as cur:
            row = await cur.fetchone()
            return row is not None and bool(row[0])

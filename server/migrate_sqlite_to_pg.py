#!/usr/bin/env python3
"""将 SQLite proxy.db 数据迁移到 PostgreSQL。

用法（本地）:
  export DATABASE_URL=postgresql://root:wink123@localhost:5432/tokenbank
  python migrate_sqlite_to_pg.py --sqlite ./proxy.db

用法（docker compose 已启动 postgres + proxy）:
  docker compose exec -e DATABASE_URL=postgresql://root:wink123@postgres:5432/tokenbank \\
    proxy python migrate_sqlite_to_pg.py --sqlite /backup/proxy.db --truncate

挂载旧库示例:
  docker compose run --rm -v $(pwd)/server/proxy.db:/backup/proxy.db \\
    -e DATABASE_URL=postgresql://root:wink123@postgres:5432/tokenbank \\
    proxy python migrate_sqlite_to_pg.py --sqlite /backup/proxy.db --truncate
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

# 保证从 server 目录导入
_SERVER_DIR = Path(__file__).resolve().parent
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))

import asyncpg

import database as db
from db_pool import close_pool, get_database_url, init_pool

# 按外键依赖顺序迁移（父表在前）
MIGRATION_TABLES: list[str] = [
    "users",
    "model_configs",
    "system_config",
    "scene_routes",
    "api_keys",
    "circles",
    "circle_members",
    "circle_announcements",
    "circle_announcement_likes",
    "circle_post_replies",
    "circle_join_requests",
    "virtual_agents",
    "transactions",
    "settlement_logs",
    "purchase_orders",
    "checkins",
    "spin_logs",
    "devices",
    "device_stats_snapshots",
]

# 含 SERIAL 主键 id 的表（迁移后需重置序列）
SERIAL_ID_TABLES = frozenset({
    "users",
    "api_keys",
    "model_configs",
    "transactions",
    "settlement_logs",
    "purchase_orders",
    "checkins",
    "spin_logs",
    "circles",
    "circle_announcements",
    "circle_post_replies",
    "circle_join_requests",
    "scene_routes",
    "virtual_agents",
    "device_stats_snapshots",
})

# SQLite 文本时间字段 → PG TIMESTAMPTZ
TIMESTAMP_COLUMNS = frozenset({
    "created_at",
    "updated_at",
    "joined_at",
    "ts",
    "last_seen",
})

TRUNCATE_SQL = """
TRUNCATE TABLE
    device_stats_snapshots,
    devices,
    virtual_agents,
    circle_post_replies,
    circle_announcement_likes,
    circle_announcements,
    circle_join_requests,
    circle_members,
    circles,
    spin_logs,
    checkins,
    purchase_orders,
    settlement_logs,
    transactions,
    scene_routes,
    api_keys,
    model_configs,
    system_config,
    users
RESTART IDENTITY CASCADE
"""


def _default_sqlite_path() -> Path:
    env = os.getenv("SQLITE_PATH", "").strip()
    if env:
        return Path(env)
    return _SERVER_DIR / "proxy.db"


def _sqlite_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return [row[1] for row in cur.fetchall()]


async def _pg_columns(conn: asyncpg.Connection, table: str) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
        """,
        table,
    )
    return [r["column_name"] for r in rows]


def _normalize_value(column: str, value: Any) -> Any:
    if value is None:
        return None
    if column in TIMESTAMP_COLUMNS and isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # SQLite 常见格式均可被 PG 解析
        return text.replace(" ", "T") if " " in text and "T" not in text else text
    return value


def _read_sqlite_rows(
    conn: sqlite3.Connection, table: str, columns: list[str]
) -> list[tuple]:
    if not columns:
        return []
    quoted = ", ".join(f'"{c}"' for c in columns)
    cur = conn.execute(f'SELECT {quoted} FROM "{table}"')
    out: list[tuple] = []
    for row in cur.fetchall():
        out.append(tuple(_normalize_value(columns[i], row[i]) for i in range(len(columns))))
    return out


async def _table_exists_sqlite(conn: sqlite3.Connection, table: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    )
    return cur.fetchone() is not None


async def _count_pg(conn: asyncpg.Connection, table: str) -> int:
    return int(await conn.fetchval(f'SELECT COUNT(*) FROM "{table}"'))


async def _copy_table(
    pg: asyncpg.Connection,
    sqlite: sqlite3.Connection,
    table: str,
) -> int:
    if not await _table_exists_sqlite(sqlite, table):
        print(f"  [skip] SQLite 无表 {table}")
        return 0

    src_cols = _sqlite_columns(sqlite, table)
    dst_cols = await _pg_columns(pg, table)
    common = [c for c in dst_cols if c in src_cols]
    if not common:
        print(f"  [skip] {table} 无共同列")
        return 0

    rows = _read_sqlite_rows(sqlite, table, common)
    if not rows:
        print(f"  [ok]   {table}: 0 行")
        return 0

    col_list = ", ".join(f'"{c}"' for c in common)
    placeholders = ", ".join(f"${i + 1}" for i in range(len(common)))

    if table == "system_config":
        sql = f"""
            INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        """
    elif table == "circle_members":
        sql = f"""
            INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})
            ON CONFLICT (circle_id, user_id) DO NOTHING
        """
    elif table == "circle_announcement_likes":
        sql = f"""
            INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})
            ON CONFLICT (announcement_id, user_id) DO NOTHING
        """
    elif table == "checkins":
        sql = f"""
            INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})
            ON CONFLICT (user_id, date) DO NOTHING
        """
    elif table == "circle_join_requests":
        sql = f"""
            INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})
            ON CONFLICT (circle_id, user_id) DO NOTHING
        """
    else:
        sql = f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})'

    # 分批写入，避免超大事务
    batch = 500
    inserted = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i : i + batch]
        await pg.executemany(sql, chunk)
        inserted += len(chunk)

    print(f"  [ok]   {table}: {inserted} 行")
    return inserted


async def _reset_serial_sequences(pg: asyncpg.Connection) -> None:
    for table in sorted(SERIAL_ID_TABLES):
        seq = await pg.fetchval("SELECT pg_get_serial_sequence($1, 'id')", table)
        if not seq:
            continue
        await pg.execute(
            f"SELECT setval('{seq}', COALESCE((SELECT MAX(id) FROM \"{table}\"), 1))"
        )


def _ensure_database_url() -> None:
    """未设置 DATABASE_URL 时，从 POSTGRES_* 环境变量拼装。"""
    if os.getenv("DATABASE_URL", "").strip():
        return
    user = os.getenv("POSTGRES_USER", "root")
    password = os.getenv("POSTGRES_PASSWORD", "wink123")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db = os.getenv("POSTGRES_DB", "tokenbank")
    os.environ["DATABASE_URL"] = f"postgresql://{user}:{password}@{host}:{port}/{db}"


async def migrate(
    sqlite_path: Path,
    truncate: bool,
    skip_init: bool,
) -> None:
    if not sqlite_path.is_file():
        raise FileNotFoundError(f"SQLite 文件不存在: {sqlite_path}")

    _ensure_database_url()
    print(f"源库: {sqlite_path}")
    print(f"目标: {get_database_url()}")

    sqlite = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    sqlite.row_factory = sqlite3.Row

    await init_pool()
    from db_pool import get_pool
    pool = get_pool()

    try:
        if not skip_init:
            print("\n[1/4] 初始化 PostgreSQL 表结构…")
            await db.init_db()

        async with pool.acquire() as pg:
            user_count = await _count_pg(pg, "users")
            if user_count > 0 and not truncate:
                raise RuntimeError(
                    f"PostgreSQL 已有 {user_count} 个用户；请加 --truncate 清空后迁移，或确认目标库为空"
                )

            if truncate:
                print("\n[2/4] 清空 PostgreSQL 业务数据…")
                await pg.execute(TRUNCATE_SQL)

            # 临时关闭外键检查，避免自引用列插入顺序问题
            await pg.execute("SET session_replication_role = 'replica'")

            print("\n[3/4] 复制数据…")
            total = 0
            try:
                for table in MIGRATION_TABLES:
                    total += await _copy_table(pg, sqlite, table)
            finally:
                await pg.execute("SET session_replication_role = 'origin'")

            print("\n[4/4] 重置自增序列…")
            await _reset_serial_sequences(pg)

        print(f"\n完成，共迁移 {total} 行。")
    finally:
        sqlite.close()
        await close_pool()


def main() -> None:
    parser = argparse.ArgumentParser(description="SQLite proxy.db → PostgreSQL 迁移")
    parser.add_argument(
        "--sqlite",
        type=Path,
        default=None,
        help=f"SQLite 文件路径（默认: { _default_sqlite_path() }）",
    )
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="迁移前清空 PostgreSQL 中所有业务表（危险操作）",
    )
    parser.add_argument(
        "--skip-init",
        action="store_true",
        help="跳过 init_db（目标库表结构已存在时使用）",
    )
    args = parser.parse_args()

    sqlite_path = args.sqlite or _default_sqlite_path()

    try:
        asyncio.run(
            migrate(
                sqlite_path=sqlite_path.resolve(),
                truncate=args.truncate,
                skip_init=args.skip_init,
            )
        )
    except Exception as exc:
        print(f"\n错误: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

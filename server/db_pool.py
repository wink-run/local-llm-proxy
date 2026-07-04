"""PostgreSQL 连接池（asyncpg）。"""

from __future__ import annotations

import os
from typing import Optional

import asyncpg

_pool: Optional[asyncpg.Pool] = None


def get_database_url() -> str:
    """从环境变量读取 DATABASE_URL；未设置时由 POSTGRES_* 拼装。"""
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        user = os.getenv("POSTGRES_USER", "root")
        password = os.getenv("POSTGRES_PASSWORD", "wink123")
        host = os.getenv("POSTGRES_HOST", "localhost")
        port = os.getenv("POSTGRES_PORT", "5432")
        db = os.getenv("POSTGRES_DB", "tokenbank")
        url = f"postgresql://{user}:{password}@{host}:{port}/{db}"
    if not url:
        raise RuntimeError(
            "DATABASE_URL 未设置，例如：postgresql://user:pass@localhost:5432/proxy"
        )
    return url


async def init_pool() -> None:
    """启动时创建连接池。"""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            get_database_url(),
            min_size=2,
            max_size=20,
            command_timeout=60,
        )


async def close_pool() -> None:
    """关闭连接池。"""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("数据库连接池未初始化，请先调用 init_pool()")
    return _pool

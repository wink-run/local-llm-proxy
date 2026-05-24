"""prompt-cache 中间件 —— 重复 prefix 缓存，降低 token 消耗。

设计文档：DESIGN_v2.md §6.3 Step 1 / 里程碑 M9

策略（保守优先）：
  - **默认关闭**，仅当请求满足以下任一时启用：
      * 显式 header `X-LLP-Cache: on`
      * `temperature == 0`（确定性请求才可能命中）
  - **匹配方式**：SHA-256(model + messages.canonical_json + system_prompt) → 缓存表
  - **不命中场景**：含 tools / tool_choice / response_format / 任何 non-deterministic
    参数的请求都视为不可缓存
  - **TTL**：默认 1h，可通过 X-LLP-Cache-Ttl 头自定义
  - **大小限制**：单条 cached_response 最大 256KB；缓存表行数上限 5000，超过 LRU 淘汰

这是 *精确匹配* 缓存，不是 *语义* 匹配 —— 对 agent / code 场景安全。
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Optional

import aiosqlite

from local_db import LOCAL_DB_PATH

MAX_CACHED_SIZE_BYTES = 256 * 1024
MAX_TABLE_ROWS = 5000
DEFAULT_TTL_SECONDS = 3600


async def init_cache_db() -> None:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS prompt_cache (
                key          TEXT PRIMARY KEY,            -- sha256(...)
                model        TEXT NOT NULL,
                response     TEXT NOT NULL,               -- JSON-encoded OpenAI response
                size_bytes   INTEGER NOT NULL,
                hit_count    INTEGER DEFAULT 0,
                created_at   INTEGER NOT NULL,            -- unix ts
                expires_at   INTEGER NOT NULL,
                last_hit_at  INTEGER DEFAULT 0
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_prompt_cache_expires ON prompt_cache(expires_at)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_prompt_cache_lru ON prompt_cache(last_hit_at)")
        await db.commit()


def is_cacheable_request(body: dict, headers: dict) -> bool:
    """根据请求体 + header 决定是否走缓存。"""
    # 流式请求不走缓存（用户感知不到 cache 收益，且 SSE 拼装麻烦）
    if body.get("stream"):
        return False
    # 任何工具调用 / 结构化输出都跳过（参数空间太大、副作用大）
    if body.get("tools") or body.get("tool_choice") or body.get("response_format"):
        return False
    # 显式 opt-in OR temperature 严格为 0
    if headers.get("x-llp-cache", "").lower() in ("on", "1", "true"):
        return True
    if body.get("temperature") == 0:
        return True
    return False


def compute_cache_key(body: dict) -> str:
    """SHA-256 of model + canonicalized messages + system prompt + max_tokens."""
    canonical = {
        "model": body.get("model", ""),
        "messages": body.get("messages", []),
        "system": body.get("system"),
        "max_tokens": body.get("max_tokens"),
        "top_p": body.get("top_p"),
    }
    blob = json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


async def get(key: str) -> Optional[dict]:
    now = int(time.time())
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        async with db.execute(
            "SELECT response, expires_at FROM prompt_cache WHERE key = ?",
            (key,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        response_text, expires_at = row
        if expires_at < now:
            await db.execute("DELETE FROM prompt_cache WHERE key = ?", (key,))
            await db.commit()
            return None
        await db.execute(
            "UPDATE prompt_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE key = ?",
            (now, key),
        )
        await db.commit()
    try:
        return json.loads(response_text)
    except json.JSONDecodeError:
        return None


async def put(key: str, model: str, response: dict, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> bool:
    """存入缓存，返回是否成功（条目过大 / 表满则跳过）。"""
    serialized = json.dumps(response, ensure_ascii=False)
    size = len(serialized.encode("utf-8"))
    if size > MAX_CACHED_SIZE_BYTES:
        return False
    now = int(time.time())
    expires = now + max(60, ttl_seconds)
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute(
            """INSERT INTO prompt_cache (key, model, response, size_bytes, created_at, expires_at, last_hit_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET
                 response = excluded.response,
                 size_bytes = excluded.size_bytes,
                 expires_at = excluded.expires_at,
                 last_hit_at = excluded.last_hit_at""",
            (key, model, serialized, size, now, expires, now),
        )
        # LRU 淘汰
        async with db.execute("SELECT COUNT(*) FROM prompt_cache") as cur:
            count = (await cur.fetchone())[0]
        if count > MAX_TABLE_ROWS:
            await db.execute(
                "DELETE FROM prompt_cache WHERE key IN ("
                "  SELECT key FROM prompt_cache ORDER BY last_hit_at ASC LIMIT ?"
                ")",
                (count - MAX_TABLE_ROWS,),
            )
        await db.commit()
    return True


async def stats() -> dict:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0), COALESCE(SUM(hit_count), 0) FROM prompt_cache"
        ) as cur:
            row = await cur.fetchone()
        async with db.execute(
            "SELECT key, model, hit_count, last_hit_at FROM prompt_cache "
            "ORDER BY hit_count DESC LIMIT 5"
        ) as cur:
            top = [dict(zip(["key", "model", "hits", "last_hit_at"], r)) for r in await cur.fetchall()]
    return {
        "entries": row[0] if row else 0,
        "total_bytes": row[1] if row else 0,
        "total_hits": row[2] if row else 0,
        "top": top,
    }


async def clear() -> int:
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM prompt_cache") as cur:
            n = (await cur.fetchone())[0]
        await db.execute("DELETE FROM prompt_cache")
        await db.commit()
    return n

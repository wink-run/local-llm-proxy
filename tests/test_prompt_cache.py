"""TC-①-601 ~ 609 —— prompt-cache 边界条件回归。

跑法：
    python -m pytest tests/test_prompt_cache.py -v

所有测试用 tmp_path 隔离本地 SQLite，绝不动 ~/.local-llm-proxy/local.db。
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import prompt_cache  # noqa: E402
import local_db  # noqa: E402


# ── 公共 fixture：每个测试一份独立 SQLite ─────────────────────────────


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    db_path = tmp_path / "test_local.db"
    monkeypatch.setattr(local_db, "LOCAL_DB_PATH", str(db_path))
    monkeypatch.setattr(prompt_cache, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(local_db.init_local_db())
    asyncio.run(prompt_cache.init_cache_db())
    yield db_path


def _run(coro):
    return asyncio.run(coro)


# ── TC-①-601 默认不缓存 ──────────────────────────────────────────────


def test_default_request_not_cacheable():
    """无 header 无 temperature=0 时不缓存。"""
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}]}
    assert prompt_cache.is_cacheable_request(body, headers={}) is False


# ── TC-①-602 temperature=0 自动启用 ──────────────────────────────────


def test_temperature_zero_enables_cache():
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}], "temperature": 0}
    assert prompt_cache.is_cacheable_request(body, headers={}) is True


def test_temperature_nonzero_does_not_enable_cache():
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.7}
    assert prompt_cache.is_cacheable_request(body, headers={}) is False


# ── TC-①-603 显式 header opt-in ──────────────────────────────────────


def test_explicit_header_opt_in():
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.9}
    # header 大小写已被 _forward_openai 归一化为小写
    assert prompt_cache.is_cacheable_request(body, {"x-llp-cache": "on"}) is True
    assert prompt_cache.is_cacheable_request(body, {"x-llp-cache": "1"}) is True
    assert prompt_cache.is_cacheable_request(body, {"x-llp-cache": "true"}) is True


def test_header_off_keeps_default():
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}], "temperature": 0}
    # off 不应该禁用 temp=0 时的自动启用（off 仅意味着不强制开）
    assert prompt_cache.is_cacheable_request(body, {"x-llp-cache": "off"}) is True


# ── TC-①-604 / 605 不可缓存的请求类型 ────────────────────────────────


def test_tools_param_skips_cache():
    """带 tools 的请求永不缓存（即使 temp=0）。"""
    body = {
        "model": "x", "temperature": 0,
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [{"type": "function", "function": {"name": "search"}}],
    }
    assert prompt_cache.is_cacheable_request(body, {}) is False


def test_tool_choice_skips_cache():
    body = {
        "model": "x", "temperature": 0,
        "messages": [{"role": "user", "content": "hi"}],
        "tool_choice": "auto",
    }
    assert prompt_cache.is_cacheable_request(body, {}) is False


def test_response_format_skips_cache():
    body = {
        "model": "x", "temperature": 0,
        "messages": [{"role": "user", "content": "hi"}],
        "response_format": {"type": "json_object"},
    }
    assert prompt_cache.is_cacheable_request(body, {}) is False


def test_streaming_skips_cache():
    body = {
        "model": "x", "temperature": 0,
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
    }
    assert prompt_cache.is_cacheable_request(body, {}) is False


# ── cache_key 稳定性 + 输入变化敏感 ──────────────────────────────────


def test_cache_key_deterministic_for_same_input():
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 10}
    k1 = prompt_cache.compute_cache_key(body)
    k2 = prompt_cache.compute_cache_key({**body})
    assert k1 == k2


def test_cache_key_sensitive_to_message_content():
    body1 = {"model": "x", "messages": [{"role": "user", "content": "hi"}]}
    body2 = {"model": "x", "messages": [{"role": "user", "content": "hello"}]}
    assert prompt_cache.compute_cache_key(body1) != prompt_cache.compute_cache_key(body2)


def test_cache_key_sensitive_to_model():
    body1 = {"model": "claude", "messages": [{"role": "user", "content": "hi"}]}
    body2 = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}
    assert prompt_cache.compute_cache_key(body1) != prompt_cache.compute_cache_key(body2)


# ── TC-①-602 真实读写一遍 ──────────────────────────────────────────────


def test_put_then_get_returns_same_payload(fresh_db):
    body = {"model": "claude", "messages": [{"role": "user", "content": "hi"}]}
    key = prompt_cache.compute_cache_key(body)
    payload = {"id": "abc", "choices": [{"message": {"role": "assistant", "content": "yo"}}]}
    assert _run(prompt_cache.put(key, "claude", payload)) is True
    got = _run(prompt_cache.get(key))
    assert got == payload


# ── TC-①-607 TTL 过期 ────────────────────────────────────────────────


def test_expired_entry_not_returned(fresh_db, monkeypatch):
    """TTL 过期后 get 返回 None 并清理。"""
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}]}
    key = prompt_cache.compute_cache_key(body)
    # ttl_seconds < 60 会被夹到 60；用 monkeypatch 把 DEFAULT_TTL_SECONDS 降低
    _run(prompt_cache.put(key, "x", {"foo": "bar"}, ttl_seconds=60))

    # 在 SQLite 中把 expires_at 拨到过去
    import aiosqlite
    async def _expire():
        async with aiosqlite.connect(prompt_cache.LOCAL_DB_PATH) as db:
            await db.execute(
                "UPDATE prompt_cache SET expires_at = ? WHERE key = ?",
                (int(time.time()) - 100, key),
            )
            await db.commit()
    _run(_expire())

    assert _run(prompt_cache.get(key)) is None
    # 应该已被删除（懒清理）
    stats = _run(prompt_cache.stats())
    assert stats["entries"] == 0


# ── TC-①-608 单条过大不入库 ───────────────────────────────────────────


def test_oversized_response_not_cached(fresh_db, monkeypatch):
    """超过 MAX_CACHED_SIZE_BYTES 的响应直接 skip put。"""
    monkeypatch.setattr(prompt_cache, "MAX_CACHED_SIZE_BYTES", 1024)
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}]}
    key = prompt_cache.compute_cache_key(body)
    huge = {"choices": [{"message": {"content": "x" * 2000}}]}
    assert _run(prompt_cache.put(key, "x", huge)) is False
    assert _run(prompt_cache.get(key)) is None


# ── TC-①-606 LRU 淘汰 ─────────────────────────────────────────────────


def test_lru_eviction_when_table_full(fresh_db, monkeypatch):
    """超过 MAX_TABLE_ROWS 后最早 last_hit_at 的被删。"""
    monkeypatch.setattr(prompt_cache, "MAX_TABLE_ROWS", 5)

    # 插入 5 条；按时间戳确保 last_hit_at 不同
    keys = []
    for i in range(5):
        body = {"model": "x", "messages": [{"role": "user", "content": f"msg-{i}"}]}
        k = prompt_cache.compute_cache_key(body)
        keys.append(k)
        _run(prompt_cache.put(k, "x", {"i": i}))
        time.sleep(0.01)

    # 把第 0 条最旧（last_hit_at 最早）—— 上面循环已保证

    # 现在插第 6 条，触发驱逐
    body6 = {"model": "x", "messages": [{"role": "user", "content": "msg-6"}]}
    k6 = prompt_cache.compute_cache_key(body6)
    _run(prompt_cache.put(k6, "x", {"i": 6}))

    stats = _run(prompt_cache.stats())
    assert stats["entries"] == 5, f"expected 5 entries after LRU eviction, got {stats['entries']}"

    # 最早的那条已被驱逐
    assert _run(prompt_cache.get(keys[0])) is None
    assert _run(prompt_cache.get(k6)) is not None


# ── TC-①-609 stats / clear ────────────────────────────────────────────


def test_stats_and_clear(fresh_db):
    for i in range(3):
        body = {"model": "x", "messages": [{"role": "user", "content": f"msg-{i}"}]}
        k = prompt_cache.compute_cache_key(body)
        _run(prompt_cache.put(k, "x", {"i": i}))

    s = _run(prompt_cache.stats())
    assert s["entries"] == 3
    assert s["total_bytes"] > 0

    cleared = _run(prompt_cache.clear())
    assert cleared == 3
    s2 = _run(prompt_cache.stats())
    assert s2["entries"] == 0


def test_hit_counter_increments(fresh_db):
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}]}
    k = prompt_cache.compute_cache_key(body)
    _run(prompt_cache.put(k, "x", {"a": 1}))

    _run(prompt_cache.get(k))
    _run(prompt_cache.get(k))
    _run(prompt_cache.get(k))

    s = _run(prompt_cache.stats())
    assert s["total_hits"] == 3

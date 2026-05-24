"""FRAG-2 —— provider cooldown 追踪 + 429 触发 + Cloudflare {ACCOUNT_ID} 模板。"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server" / "local"))

import local_db  # noqa: E402
import local_gateway  # noqa: E402
import prompt_cache  # noqa: E402
import subscription_providers  # noqa: E402
import subscriptions as subscriptions_mod  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "cool.db"
    for mod in (local_db, prompt_cache, subscription_providers):
        monkeypatch.setattr(mod, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(local_db.init_local_db())
    asyncio.run(prompt_cache.init_cache_db())
    asyncio.run(subscription_providers.init_subscription_db())
    asyncio.run(subscriptions_mod.init_subscriptions_table())
    return TestClient(local_gateway.app)


def _mock_response(status_code, json_body=None, headers=None):
    r = MagicMock(spec=httpx.Response)
    r.status_code = status_code
    r.text = ""
    r.headers = headers or {"content-type": "application/json"}
    r.json = MagicMock(return_value=json_body or {})
    return r


# ── cooldown helper 单元 ────────────────────────────────────────────


def test_set_and_get_cooldown(client):
    pid = asyncio.run(local_db.add_provider(
        provider_id="x", display_name="x", tier="free",
        base_url="http://x.invalid", auth_type="none", models=["m"],
    ))
    until = asyncio.run(local_db.set_provider_cooldown(pid, 60, "test"))
    rec = asyncio.run(local_db.get_provider_cooldown(pid))
    assert rec["cooldown_until"] == until
    assert rec["reason"] == "test"
    assert rec["count_429"] == 1


def test_set_cooldown_increments_count(client):
    pid = asyncio.run(local_db.add_provider(
        provider_id="x", display_name="x", tier="free",
        base_url="http://x.invalid", auth_type="none", models=["m"],
    ))
    asyncio.run(local_db.set_provider_cooldown(pid, 60, "first"))
    asyncio.run(local_db.set_provider_cooldown(pid, 120, "second"))
    rec = asyncio.run(local_db.get_provider_cooldown(pid))
    assert rec["count_429"] == 2
    assert rec["reason"] == "second"


def test_list_active_cooldowns_excludes_expired(client):
    pid1 = asyncio.run(local_db.add_provider(
        provider_id="active", display_name="a", tier="free",
        base_url="http://a", auth_type="none", models=["m"],
    ))
    pid2 = asyncio.run(local_db.add_provider(
        provider_id="expired", display_name="b", tier="free",
        base_url="http://b", auth_type="none", models=["m"],
    ))
    asyncio.run(local_db.set_provider_cooldown(pid1, 300, "active"))
    # 把 pid2 的 cooldown 设到过去
    import aiosqlite
    async def force_expire():
        async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
            await db.execute(
                "INSERT INTO provider_cooldowns(provider_id, cooldown_until, reason, count_429, last_429_at) "
                "VALUES (?, ?, 'old', 1, ?)",
                (pid2, int(time.time()) - 100, int(time.time())),
            )
            await db.commit()
    asyncio.run(force_expire())

    active = asyncio.run(local_db.list_active_cooldowns())
    assert pid1 in active
    assert pid2 not in active


def test_clear_cooldown(client):
    pid = asyncio.run(local_db.add_provider(
        provider_id="x", display_name="x", tier="free",
        base_url="http://x", auth_type="none", models=["m"],
    ))
    asyncio.run(local_db.set_provider_cooldown(pid, 60, "test"))
    asyncio.run(local_db.clear_provider_cooldown(pid))
    assert asyncio.run(local_db.get_provider_cooldown(pid)) is None


# ── 429 触发 cooldown + 跳到下一个 ───────────────────────────────────


def test_429_triggers_cooldown_and_falls_back(client):
    """provider A 返回 429 (Retry-After: 10) → A 进 cooldown → 改用 B。"""
    asyncio.run(local_db.set_setting("strategy", "custom"))
    asyncio.run(local_db.add_provider(
        provider_id="a", display_name="A", tier="free",
        base_url="http://a.invalid", auth_type="none", models=["m"], price_in=0, price_out=0,
    ))
    asyncio.run(local_db.add_provider(
        provider_id="b", display_name="B", tier="free",
        base_url="http://b.invalid", auth_type="none", models=["m"],
    ))

    call_log = []

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        if url.startswith("http://a"):
            return _mock_response(429, json_body={"err": "rate"}, headers={
                "content-type": "application/json", "retry-after": "10",
            })
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post("/v1/chat/completions", json={
            "model": "m", "messages": [{"role": "user", "content": "hi"}],
        })

    assert r.status_code == 200
    assert any("a.invalid" in u for u in call_log)
    assert any("b.invalid" in u for u in call_log)

    # 验证 A 已被标 cooldown
    cooldowns = asyncio.run(local_db.list_active_cooldowns())
    a_row = next(p for p in asyncio.run(local_db.list_providers()) if p["provider_id"] == "a")
    assert a_row["id"] in cooldowns
    rec = cooldowns[a_row["id"]]
    assert rec["count_429"] == 1
    # cooldown_until 应该接近 now + 10
    assert (rec["cooldown_until"] - int(time.time())) <= 10
    assert "429" in rec["reason"]


def test_cooldown_provider_skipped_on_subsequent_request(client):
    """cooldown 中的 provider 直接被过滤，不再尝试。"""
    asyncio.run(local_db.set_setting("strategy", "custom"))
    a_id = asyncio.run(local_db.add_provider(
        provider_id="a", display_name="A", tier="free",
        base_url="http://a.invalid", auth_type="none", models=["m"],
    ))
    asyncio.run(local_db.add_provider(
        provider_id="b", display_name="B", tier="free",
        base_url="http://b.invalid", auth_type="none", models=["m"],
    ))
    # 手动标 a cooldown 5 分钟
    asyncio.run(local_db.set_provider_cooldown(a_id, 300, "manual"))

    call_log = []

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post("/v1/chat/completions", json={
            "model": "m", "messages": [{"role": "user", "content": "hi"}],
        })

    # A 应该完全没被叫到
    assert all("a.invalid" not in u for u in call_log)


def test_providers_endpoint_returns_cooldown_remaining(client):
    pid = asyncio.run(local_db.add_provider(
        provider_id="x", display_name="X", tier="free",
        base_url="http://x", auth_type="none", models=["m"],
    ))
    asyncio.run(local_db.set_provider_cooldown(pid, 120, "test"))

    r = client.get("/__local__/providers").json()
    p = next(x for x in r["providers"] if x["id"] == pid)
    assert p["cooldown_remaining_sec"] > 100
    assert p["cooldown_remaining_sec"] <= 120
    assert p["cooldown_reason"] == "test"


def test_clear_cooldown_endpoint(client):
    pid = asyncio.run(local_db.add_provider(
        provider_id="x", display_name="X", tier="free",
        base_url="http://x", auth_type="none", models=["m"],
    ))
    asyncio.run(local_db.set_provider_cooldown(pid, 120, "test"))
    r = client.post(f"/__local__/providers/{pid}/clear-cooldown")
    assert r.status_code == 200
    rec = asyncio.run(local_db.get_provider_cooldown(pid))
    assert rec is None


def test_no_retry_after_uses_default_300(client):
    """上游 429 但没 Retry-After 头时用默认 300s。"""
    asyncio.run(local_db.add_provider(
        provider_id="x", display_name="X", tier="free",
        base_url="http://x.invalid", auth_type="none", models=["m"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(429, json_body={"err": "rate"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post("/v1/chat/completions", json={
            "model": "m", "messages": [{"role": "user", "content": "hi"}],
        })

    p_row = next(p for p in asyncio.run(local_db.list_providers()) if p["provider_id"] == "x")
    rec = asyncio.run(local_db.get_provider_cooldown(p_row["id"]))
    assert rec is not None
    # 默认 300 秒
    assert 290 <= (rec["cooldown_until"] - int(time.time())) <= 305


# ── Cloudflare {ACCOUNT_ID} 模板替换 ────────────────────────────────


def test_cloudflare_account_id_substituted(client):
    r = client.post("/__local__/providers/from-catalog", json={
        "provider_id": "cloudflare-workers-ai",
        "api_key": "cf-token",
        "account_id": "abc123def456",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert "abc123def456" in body["base_url"]
    assert "{ACCOUNT_ID}" not in body["base_url"]


def test_cloudflare_missing_account_id_rejected(client):
    r = client.post("/__local__/providers/from-catalog", json={
        "provider_id": "cloudflare-workers-ai",
        "api_key": "cf-token",
    })
    assert r.status_code == 400
    assert "account_id" in r.json()["detail"]


def test_non_cloudflare_does_not_need_account_id(client):
    r = client.post("/__local__/providers/from-catalog", json={
        "provider_id": "groq",
        "api_key": "gsk_test",
    })
    assert r.status_code == 200

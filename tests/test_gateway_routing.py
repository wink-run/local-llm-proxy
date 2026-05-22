"""TC-①-302 / 305 —— 候选链故障转移 + 4xx 不重试 回归。

跑法：python -m pytest tests/test_gateway_routing.py -v
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import local_db  # noqa: E402
import local_gateway  # noqa: E402
import prompt_cache  # noqa: E402
import subscription_providers  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "routing.db"
    for mod in (local_db, prompt_cache, subscription_providers):
        monkeypatch.setattr(mod, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(local_db.init_local_db())
    asyncio.run(prompt_cache.init_cache_db())
    asyncio.run(subscription_providers.init_subscription_db())
    return TestClient(local_gateway.app)


def _add_provider(name, base_url, models, priority=100):
    asyncio.run(local_db.add_provider(
        provider_id=name, display_name=name, tier="paid",
        base_url=base_url, auth_type="none",
        models=models,
    ))
    # 用 priority 控制 custom 策略下的顺序
    rows = asyncio.run(local_db.list_providers())
    last_id = max(r["id"] for r in rows)
    asyncio.run(local_db.update_provider(last_id, priority=priority))


def _mock_response(status_code, json_body=None, text=""):
    r = MagicMock(spec=httpx.Response)
    r.status_code = status_code
    r.text = text
    r.headers = {"content-type": "application/json"} if json_body is not None else {"content-type": "text/plain"}
    r.json = MagicMock(return_value=json_body or {})
    return r


# ── TC-①-302 5xx 触发候选链下一个 ────────────────────────────────────


def test_5xx_triggers_failover_to_next_candidate(client):
    """provider A 500 → provider B 200。返回 B 的结果。"""
    asyncio.run(local_db.set_setting("strategy", "custom"))
    _add_provider("a-broken", "http://a.invalid", ["gpt-test"], priority=10)
    _add_provider("b-good", "http://b.invalid", ["gpt-test"], priority=20)

    success_body = {"id": "good", "choices": [{"message": {"role": "assistant", "content": "ok"}}]}

    call_log = []

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        if url.startswith("http://a"):
            return _mock_response(500, text="upstream blew up")
        return _mock_response(200, json_body=success_body)

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            json={"model": "gpt-test", "messages": [{"role": "user", "content": "hi"}]},
        )
    assert r.status_code == 200, r.text
    assert r.json()["id"] == "good"
    # 两个 provider 都被试过，B 在 A 之后
    assert any("a.invalid" in u for u in call_log)
    assert any("b.invalid" in u for u in call_log)
    assert call_log.index(next(u for u in call_log if "a.invalid" in u)) < call_log.index(next(u for u in call_log if "b.invalid" in u))


# ── TC-①-305 4xx 不重试 ──────────────────────────────────────────────


def test_4xx_does_not_failover(client):
    """provider A 返回 401 时直接返回，不会去试 B。"""
    asyncio.run(local_db.set_setting("strategy", "custom"))
    _add_provider("a-401", "http://a.invalid", ["gpt-test"], priority=10)
    _add_provider("b-good", "http://b.invalid", ["gpt-test"], priority=20)

    call_log = []
    err_body = {"error": {"message": "Invalid key"}}

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        if url.startswith("http://a"):
            return _mock_response(401, json_body=err_body)
        return _mock_response(200, json_body={"id": "wrong"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            json={"model": "gpt-test", "messages": [{"role": "user", "content": "hi"}]},
        )
    # 应该把 A 的 401 透传，**不**继续试 B
    assert r.status_code == 401
    assert all("b.invalid" not in u for u in call_log), \
        f"4xx should not trigger failover, but B was called: {call_log}"


# ── TC-①-303 全部失败 → 502 ──────────────────────────────────────────


def test_all_candidates_fail_returns_502(client):
    asyncio.run(local_db.set_setting("strategy", "custom"))
    _add_provider("a", "http://a.invalid", ["gpt-test"], priority=10)
    _add_provider("b", "http://b.invalid", ["gpt-test"], priority=20)

    async def fake_post(self, url, **kwargs):
        return _mock_response(503, text="down")

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            json={"model": "gpt-test", "messages": [{"role": "user", "content": "hi"}]},
        )
    assert r.status_code == 502
    assert "All upstream" in r.text


# ── TC-①-301 unknown model + 没有 wildcard 时 404 ─────────────────────


def test_unknown_model_404_when_no_wildcard(client):
    """如果所有 provider 都列了 models（无 wildcard），unknown model 应该 404。"""
    _add_provider("typed-only", "http://x.invalid", ["only-this-model"], priority=10)

    r = client.post(
        "/v1/chat/completions",
        json={"model": "nope", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert r.status_code == 404


def test_unknown_model_routes_to_wildcard_provider(client):
    """provider.models=[] 时作为 wildcard。"""
    _add_provider("wildcard", "http://w.invalid", [], priority=10)

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "from-wildcard"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            json={"model": "any-model", "messages": [{"role": "user", "content": "hi"}]},
        )
    assert r.status_code == 200
    assert r.json()["id"] == "from-wildcard"


# ── TC-①-602 prompt-cache 命中走快路径 ────────────────────────────────


def test_cache_hit_returns_without_calling_upstream(client):
    asyncio.run(local_db.set_setting("strategy", "custom"))
    _add_provider("a", "http://a.invalid", ["gpt-test"], priority=10)

    cached_payload = {"id": "from-cache", "choices": [{"message": {"content": "cached"}}]}
    body = {"model": "gpt-test", "messages": [{"role": "user", "content": "hi"}], "temperature": 0}
    key = prompt_cache.compute_cache_key(body)
    asyncio.run(prompt_cache.put(key, "gpt-test", cached_payload))

    call_log = []

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        return _mock_response(200, json_body={"id": "should-not-be-called"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post("/v1/chat/completions", json=body)

    assert r.status_code == 200
    data = r.json()
    assert data["id"] == "from-cache"
    assert data.get("_llp_cached") is True
    assert call_log == [], "upstream should NOT be called on cache hit"


# ── TC-①-301 候选链顺序按 cost 策略 ─────────────────────────────────


def test_cost_strategy_prefers_cheaper_provider(client):
    """price_in + price_out 升序"""
    asyncio.run(local_db.set_setting("strategy", "cost"))
    asyncio.run(local_db.add_provider(
        provider_id="expensive", display_name="expensive", tier="paid",
        base_url="http://exp.invalid", auth_type="none",
        models=["shared"], price_in=10.0, price_out=30.0,
    ))
    asyncio.run(local_db.add_provider(
        provider_id="cheap", display_name="cheap", tier="paid",
        base_url="http://cheap.invalid", auth_type="none",
        models=["shared"], price_in=0.5, price_out=1.5,
    ))

    call_log = []

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post("/v1/chat/completions", json={
            "model": "shared", "messages": [{"role": "user", "content": "hi"}],
        })

    # cheap 应该先被叫到
    assert "cheap.invalid" in call_log[0]

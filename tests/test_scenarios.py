"""RD-1 / RD-2 —— scenarios CRUD + 网关按 tb-* key 路由回归。

跑法：python -m pytest tests/test_scenarios.py -v
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

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
    db_path = tmp_path / "scn.db"
    for mod in (local_db, prompt_cache, subscription_providers):
        monkeypatch.setattr(mod, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(local_db.init_local_db())
    asyncio.run(prompt_cache.init_cache_db())
    asyncio.run(subscription_providers.init_subscription_db())
    return TestClient(local_gateway.app)


def _mock_response(status_code, json_body=None):
    r = MagicMock(spec=httpx.Response)
    r.status_code = status_code
    r.text = ""
    r.headers = {"content-type": "application/json"} if json_body is not None else {"content-type": "text/plain"}
    r.json = MagicMock(return_value=json_body or {})
    return r


# ── RD-1 CRUD ──────────────────────────────────────────────────────────


def test_create_scenario_assigns_tb_api_key(client):
    r = client.post("/__local__/scenarios", json={"name": "Claude Code"})
    assert r.status_code == 200
    s = r.json()
    assert s["api_key"].startswith("tb-")
    assert "claude" in s["api_key"]  # slugify 命名一部分


def test_list_scenarios_includes_stats(client):
    client.post("/__local__/scenarios", json={"name": "Test"})
    r = client.get("/__local__/scenarios")
    scns = r.json()["scenarios"]
    assert len(scns) == 1
    assert "stats_today" in scns[0]
    assert scns[0]["stats_today"]["calls"] == 0


def test_update_scenario_chain(client):
    s = client.post("/__local__/scenarios", json={"name": "writer"}).json()
    chain = [{"label": "优先", "candidates": [{"provider_id": "groq", "model": "llama-3.1-8b"}]}]
    r = client.patch(f"/__local__/scenarios/{s['id']}", json={"degradation_chain": chain})
    assert r.status_code == 200
    assert r.json()["degradation_chain"] == chain


def test_rotate_scenario_key_changes_value(client):
    s = client.post("/__local__/scenarios", json={"name": "x"}).json()
    r = client.post(f"/__local__/scenarios/{s['id']}/rotate-key")
    assert r.status_code == 200
    new_key = r.json()["api_key"]
    assert new_key != s["api_key"]
    assert new_key.startswith("tb-")


def test_delete_scenario(client):
    s = client.post("/__local__/scenarios", json={"name": "to-delete"}).json()
    client.delete(f"/__local__/scenarios/{s['id']}")
    assert client.get("/__local__/scenarios").json()["scenarios"] == []


# ── RD-2 网关按 tb-* key 路由 ──────────────────────────────────────────


def test_request_with_tb_key_uses_scenario_chain(client):
    """场景降级链 [step1: cheap, step2: expensive]。带 tb- key 请求时按链顺序。"""
    asyncio.run(local_db.add_provider(
        provider_id="cheap-prov", display_name="cheap", tier="free",
        base_url="http://cheap.invalid", auth_type="none", models=["m1"],
    ))
    asyncio.run(local_db.add_provider(
        provider_id="exp-prov", display_name="exp", tier="paid",
        base_url="http://exp.invalid", auth_type="none", models=["m2"],
    ))
    s = client.post("/__local__/scenarios", json={
        "name": "test-scn",
        "degradation_chain": [
            {"label": "优先", "candidates": [{"provider_id": "cheap-prov", "model": "m1"}]},
            {"label": "改选", "candidates": [{"provider_id": "exp-prov", "model": "m2"}]},
        ],
    }).json()

    call_log = []

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        if url.startswith("http://cheap"):
            return _mock_response(500, json_body={"err": "broken"})
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {s['api_key']}"},
            json={"model": "anything", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert r.status_code == 200
    # cheap 先被叫到，exp 第二个
    assert any("cheap.invalid" in u for u in call_log)
    assert any("exp.invalid" in u for u in call_log)
    # 顺序正确
    cheap_idx = next(i for i, u in enumerate(call_log) if "cheap.invalid" in u)
    exp_idx = next(i for i, u in enumerate(call_log) if "exp.invalid" in u)
    assert cheap_idx < exp_idx


def test_request_forces_model_from_scenario_candidate(client):
    """场景候选指定了具体 model 时，会改写请求 body 的 model。"""
    asyncio.run(local_db.add_provider(
        provider_id="p1", display_name="p1", tier="free",
        base_url="http://p1.invalid", auth_type="none",
        models=["forced-model"],
    ))
    s = client.post("/__local__/scenarios", json={
        "name": "force-model",
        "degradation_chain": [
            {"label": "优先", "candidates": [{"provider_id": "p1", "model": "forced-model"}]},
        ],
    }).json()

    captured_bodies = []

    async def fake_post(self, url, **kwargs):
        captured_bodies.append(kwargs.get("json"))
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {s['api_key']}"},
            json={"model": "client-asked-this", "messages": [{"role": "user", "content": "hi"}]},
        )

    # body.model 应被改写
    assert captured_bodies[0]["model"] == "forced-model"


def test_scenario_id_logged_in_call_logs(client):
    asyncio.run(local_db.add_provider(
        provider_id="p", display_name="p", tier="free",
        base_url="http://p.invalid", auth_type="none", models=["m"],
    ))
    s = client.post("/__local__/scenarios", json={
        "name": "log-test",
        "degradation_chain": [{"label": "优先", "candidates": [{"provider_id": "p", "model": "m"}]}],
    }).json()

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "ok", "usage": {"prompt_tokens": 5, "completion_tokens": 7}})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {s['api_key']}"},
            json={"model": "any", "messages": [{"role": "user", "content": "hi"}]},
        )

    recent = client.get("/__local__/dashboard/recent").json()["calls"]
    assert len(recent) == 1
    assert recent[0]["scenario_id"] == s["id"]
    assert recent[0]["app_source"] == "log-test"  # scenario name 反填到 app_source


def test_invalid_tb_key_falls_back_to_default_routing(client):
    """tb-* key 不存在时不应崩，而是退回到默认 provider pool 路由。"""
    asyncio.run(local_db.add_provider(
        provider_id="fallback", display_name="fallback", tier="free",
        base_url="http://f.invalid", auth_type="none", models=["m"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer tb-nonexistent-key-xxxxx"},
            json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert r.status_code == 200


# ── RD-3 KPI endpoint ────────────────────────────────────────────────


def test_gateway_kpis_empty_initially(client):
    r = client.get("/__local__/gateway/kpis").json()
    assert r["total_calls"] == 0
    assert r["error_rate"] == 0.0


def test_gateway_kpis_after_calls(client):
    asyncio.run(local_db.add_provider(
        provider_id="p", display_name="p", tier="free",
        base_url="http://p.invalid", auth_type="none", models=["m"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "ok", "usage": {"prompt_tokens": 1, "completion_tokens": 2}})

    with patch("httpx.AsyncClient.post", new=fake_post):
        for _ in range(3):
            client.post("/v1/chat/completions", json={"model": "m", "messages": [{"role": "user", "content": "x"}]})

    r = client.get("/__local__/gateway/kpis").json()
    assert r["total_calls"] == 3
    assert r["free_hit_rate"] == 100.0  # 全部走 free tier
    assert r["error_rate"] == 0.0

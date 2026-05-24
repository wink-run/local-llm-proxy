"""TPL-1 / TPL-2 —— scenario 模板 + X-LLP-Debug 头回归。

跑法：python -m pytest tests/test_templates_and_debug.py -v
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
sys.path.insert(0, str(ROOT / "server" / "local"))

import local_db  # noqa: E402
import local_gateway  # noqa: E402
import prompt_cache  # noqa: E402
import subscription_providers  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "tpl.db"
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


# ── TPL-1 模板 ──────────────────────────────────────────────────────────


def test_list_templates_returns_6(client):
    r = client.get("/__local__/scenarios/templates")
    tpls = r.json()["templates"]
    assert len(tpls) == 6
    ids = [t["id"] for t in tpls]
    for expected in ["claude-code-daily", "writing", "code-review", "long-context", "batch-cheap", "production-stable"]:
        assert expected in ids


def test_templates_show_missing_providers(client):
    r = client.get("/__local__/scenarios/templates")
    tpls = r.json()["templates"]
    daily = next(t for t in tpls if t["id"] == "claude-code-daily")
    # 还没装任何 provider，所以全 missing
    assert set(daily["missing_providers"]) >= {"ollama", "groq", "github-models"}


def test_templates_missing_shrinks_after_install(client):
    # 装一个 ollama
    asyncio.run(local_db.add_provider(
        provider_id="ollama", display_name="Ollama", tier="free",
        base_url="http://127.0.0.1:11434/v1", auth_type="none",
    ))
    r = client.get("/__local__/scenarios/templates")
    daily = next(t for t in r.json()["templates"] if t["id"] == "claude-code-daily")
    assert "ollama" not in daily["missing_providers"]
    assert "groq" in daily["missing_providers"]  # 仍缺


def test_create_from_template_builds_scenario(client):
    r = client.post("/__local__/scenarios/from-template", json={"template_id": "writing"})
    assert r.status_code == 200
    s = r.json()
    assert s["name"] == "写作创作"
    assert s["api_key"].startswith("tb-")
    assert len(s["degradation_chain"]) >= 1
    # 列表里能看到
    listed = client.get("/__local__/scenarios").json()["scenarios"]
    assert any(x["id"] == s["id"] for x in listed)


def test_create_from_template_with_custom_name(client):
    r = client.post("/__local__/scenarios/from-template", json={
        "template_id": "writing", "name": "我的写作场景",
    })
    assert r.json()["name"] == "我的写作场景"


def test_unknown_template_rejected(client):
    r = client.post("/__local__/scenarios/from-template", json={"template_id": "no-such"})
    assert r.status_code == 404


# ── TPL-2 X-LLP-Debug header ────────────────────────────────────────────


def test_debug_header_attaches_metadata_on_success(client):
    asyncio.run(local_db.add_provider(
        provider_id="dbg-prov", display_name="dbg", tier="free",
        base_url="http://d.invalid", auth_type="none", models=["m"],
    ))
    s = client.post("/__local__/scenarios", json={
        "name": "debug-scn",
        "degradation_chain": [
            {"label": "优先", "candidates": [{"provider_id": "dbg-prov", "model": "m"}]},
        ],
    }).json()

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "x", "choices": [{"message": {"content": "hi"}}], "usage": {"prompt_tokens": 1, "completion_tokens": 2}})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {s['api_key']}", "X-LLP-Debug": "1"},
            json={"model": "any", "messages": [{"role": "user", "content": "hi"}]},
        )

    body = r.json()
    assert "_llp_debug" in body
    dbg = body["_llp_debug"]
    assert dbg["scenario_name"] == "debug-scn"
    assert dbg["routed_to"] == "dbg-prov"
    assert dbg["actual_model"] == "m"
    assert dbg["step_label"] == "优先"
    assert dbg["tier"] == "free"
    assert dbg["latency_ms"] >= 0
    assert dbg["attempts"][-1]["outcome"] == "success"


def test_debug_attempts_logs_fallbacks(client):
    """5xx fallback 的尝试也在 attempts 里。"""
    asyncio.run(local_db.add_provider(
        provider_id="broken", display_name="broken", tier="free",
        base_url="http://a.invalid", auth_type="none", models=["m"],
    ))
    asyncio.run(local_db.add_provider(
        provider_id="working", display_name="working", tier="free",
        base_url="http://b.invalid", auth_type="none", models=["m"],
    ))
    s = client.post("/__local__/scenarios", json={
        "name": "fb-scn",
        "degradation_chain": [
            {"label": "step1", "candidates": [{"provider_id": "broken", "model": "m"}]},
            {"label": "step2", "candidates": [{"provider_id": "working", "model": "m"}]},
        ],
    }).json()

    async def fake_post(self, url, **kwargs):
        if "a.invalid" in url:
            return _mock_response(500)
        return _mock_response(200, json_body={"id": "x", "choices": [{}]})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {s['api_key']}", "X-LLP-Debug": "1"},
            json={"model": "any", "messages": [{"role": "user", "content": "hi"}]},
        )

    body = r.json()
    attempts = body["_llp_debug"]["attempts"]
    assert len(attempts) == 2
    assert attempts[0]["outcome"] == "5xx, fallback"
    assert attempts[0]["provider_id"] == "broken"
    assert attempts[1]["outcome"] == "success"
    assert attempts[1]["provider_id"] == "working"


def test_no_debug_header_means_no_metadata(client):
    """不带 X-LLP-Debug 时响应不应有 _llp_debug。"""
    asyncio.run(local_db.add_provider(
        provider_id="p", display_name="p", tier="free",
        base_url="http://p.invalid", auth_type="none", models=["m"],
    ))
    s = client.post("/__local__/scenarios", json={
        "name": "no-dbg",
        "degradation_chain": [{"label": "优先", "candidates": [{"provider_id": "p", "model": "m"}]}],
    }).json()

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "x", "choices": [{}]})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {s['api_key']}"},
            json={"model": "any", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert "_llp_debug" not in r.json()

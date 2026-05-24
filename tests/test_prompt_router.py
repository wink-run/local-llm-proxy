"""PROMPT-1/2 —— routing_rules + prompt analysis rule engine。"""

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
import prompt_router  # noqa: E402
import subscription_providers  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "rules.db"
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


# ── 规则引擎单元 ────────────────────────────────────────────────────


def test_estimate_tokens_basic():
    msgs = [{"role": "user", "content": "a" * 300}]
    assert prompt_router.estimate_tokens(msgs) == 100  # 300/3


def test_match_token_count_gt():
    rule = {"match_kind": "token_count_gt", "match_value": "100", "enabled": True}
    long_body = {"messages": [{"role": "user", "content": "x" * 600}]}  # est=200
    short_body = {"messages": [{"role": "user", "content": "x"}]}
    assert prompt_router._match_rule(rule, long_body, {}) is not None
    assert prompt_router._match_rule(rule, short_body, {}) is None


def test_match_has_tools():
    rule = {"match_kind": "has_tools", "match_value": "true", "enabled": True}
    with_tools = {"tools": [{"type": "function"}], "messages": []}
    no_tools = {"messages": []}
    assert prompt_router._match_rule(rule, with_tools, {}) is not None
    assert prompt_router._match_rule(rule, no_tools, {}) is None


def test_match_system_regex():
    rule = {"match_kind": "system_regex", "match_value": "(?i)\\bcommit message\\b", "enabled": True}
    body = {"messages": [
        {"role": "system", "content": "Generate a commit message for the diff"},
        {"role": "user", "content": "diff..."},
    ]}
    matched = prompt_router._match_rule(rule, body, {})
    assert matched is not None
    assert "commit message" in matched.lower()


def test_match_header_hint_wildcard():
    rule = {"match_kind": "header_hint", "match_value": "*", "enabled": True}
    assert prompt_router._match_rule(rule, {"messages": []}, {"x-llp-hint": "gpt-5.5"}) is not None
    assert prompt_router._match_rule(rule, {"messages": []}, {}) is None


def test_match_header_hint_exact():
    rule = {"match_kind": "header_hint", "match_value": "fast", "enabled": True}
    assert prompt_router._match_rule(rule, {"messages": []}, {"x-llp-hint": "fast"}) is not None
    assert prompt_router._match_rule(rule, {"messages": []}, {"x-llp-hint": "slow"}) is None


def test_match_rules_priority_order():
    """两条都命中时，priority 小者赢。"""
    rules = [
        {"id": 1, "name": "high-prio", "match_kind": "has_tools", "match_value": "true",
         "target_model": "first", "priority": 1, "enabled": True},
        {"id": 2, "name": "low-prio", "match_kind": "has_tools", "match_value": "true",
         "target_model": "second", "priority": 100, "enabled": True},
    ]
    body = {"tools": [{}], "messages": []}
    m = prompt_router.match_rules(rules, body, {})
    assert m.target_model == "first"


def test_match_rules_skips_disabled():
    rules = [{"id": 1, "name": "x", "match_kind": "has_tools", "match_value": "true",
              "target_model": "X", "priority": 1, "enabled": False}]
    body = {"tools": [{}], "messages": []}
    assert prompt_router.match_rules(rules, body, {}) is None


def test_header_hint_with_empty_target_model_uses_header_value():
    rules = [{"id": 1, "name": "hint", "match_kind": "header_hint", "match_value": "*",
              "target_model": "", "target_provider": "", "priority": 1, "enabled": True}]
    m = prompt_router.match_rules(rules, {"messages": []}, {"x-llp-hint": "gpt-5.5-pro"})
    assert m.target_model == "gpt-5.5-pro"


# ── 内置规则 ────────────────────────────────────────────────────────


def test_builtin_rules_seeded(client):
    r = client.get("/__local__/rules").json()
    names = [x["name"] for x in r["rules"]]
    for expected in ["long-context-quality", "tools-quality", "code-review",
                      "commit-msg-cheap", "translation-cheap", "explicit-hint"]:
        assert expected in names, f"missing builtin rule {expected}"


def test_cannot_delete_builtin_rule(client):
    r = client.get("/__local__/rules").json()
    builtin = next(x for x in r["rules"] if x["is_builtin"] == 1)
    resp = client.delete(f"/__local__/rules/{builtin['id']}")
    assert resp.status_code == 400


def test_custom_rule_upsert_then_delete(client):
    r = client.post("/__local__/rules", json={
        "name": "my-test", "match_kind": "has_tools", "match_value": "true",
        "target_model": "test-model",
    })
    assert r.status_code == 200
    rid = r.json()["id"]
    r2 = client.delete(f"/__local__/rules/{rid}")
    assert r2.status_code == 200


def test_toggle_rule(client):
    r = client.get("/__local__/rules").json()
    builtin = next(x for x in r["rules"] if x["is_builtin"] == 1)
    client.post(f"/__local__/rules/{builtin['id']}/toggle?enabled=false")
    listed = client.get("/__local__/rules").json()["rules"]
    found = next(x for x in listed if x["id"] == builtin["id"])
    assert found["enabled"] == 0


# ── 网关命中规则后改写 model ────────────────────────────────────────


def test_request_with_commit_message_routes_to_cheap(client):
    """命中 commit-msg-cheap 规则后，body.model 应被改成 llama-4-8b-instant。"""
    asyncio.run(local_db.add_provider(
        provider_id="groq", display_name="Groq", tier="free",
        base_url="http://groq.invalid", auth_type="none",
        models=["llama-4-8b-instant", "llama-4-70b-instruct"],
    ))

    captured_bodies = []

    async def fake_post(self, url, **kwargs):
        captured_bodies.append(kwargs.get("json"))
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post("/v1/chat/completions",
                         headers={"X-LLP-Debug": "1"},
                         json={
                             "model": "gpt-5.5",  # 客户端原本想用 gpt-5.5
                             "messages": [
                                 {"role": "system", "content": "Generate a commit message for this diff"},
                                 {"role": "user", "content": "..."},
                             ],
                         })

    assert r.status_code == 200
    # 规则把 model 改成了 llama-4-8b-instant
    assert captured_bodies[0]["model"] == "llama-4-8b-instant"
    body = r.json()
    assert body["_llp_debug"]["rule_match"]["rule_name"] == "commit-msg-cheap"


def test_request_with_long_context_routes_to_opus(client):
    asyncio.run(local_db.add_provider(
        provider_id="anthropic", display_name="Anthropic", tier="paid",
        base_url="http://anth.invalid", auth_type="none",
        models=["claude-opus-4-7"], protocol="anthropic",
    ))

    captured_bodies = []
    async def fake_post(self, url, **kwargs):
        captured_bodies.append(kwargs.get("json"))
        return _mock_response(200, json_body={"id": "msg_x", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}})

    long_text = "a" * 30000  # est = 10000 > 8000

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post("/v1/chat/completions",
                         headers={"X-LLP-Debug": "1"},
                         json={"model": "gpt-5.5-mini",
                                "messages": [{"role": "user", "content": long_text}]})

    body = r.json()
    assert body["_llp_debug"]["rule_match"]["rule_name"] == "long-context-quality"
    assert body["_llp_debug"]["actual_model"] == "claude-opus-4-7"


def test_request_without_match_no_rule(client):
    """普通短消息不应命中任何规则。"""
    asyncio.run(local_db.add_provider(
        provider_id="p", display_name="P", tier="free",
        base_url="http://p.invalid", auth_type="none", models=["gpt-5.5-mini"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        r = client.post("/v1/chat/completions",
                         headers={"X-LLP-Debug": "1"},
                         json={"model": "gpt-5.5-mini",
                                "messages": [{"role": "user", "content": "hi"}]})

    assert r.json()["_llp_debug"]["rule_match"] is None

"""TC-M11/M13/M15 —— Dashboard aggregate + routing_policies + QuickStart 回归。

跑法：python -m pytest tests/test_dashboard_policies_quickstart.py -v
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

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
    db_path = tmp_path / "dash.db"
    for mod in (local_db, prompt_cache, subscription_providers):
        monkeypatch.setattr(mod, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(local_db.init_local_db())
    asyncio.run(prompt_cache.init_cache_db())
    asyncio.run(subscription_providers.init_subscription_db())
    return TestClient(local_gateway.app)


def _mock_response(status_code, json_body=None):
    from unittest.mock import MagicMock
    r = MagicMock(spec=httpx.Response)
    r.status_code = status_code
    r.text = ""
    r.headers = {"content-type": "application/json"} if json_body is not None else {"content-type": "text/plain"}
    r.json = MagicMock(return_value=json_body or {})
    return r


# ── M13 routing_policies ────────────────────────────────────────────────


def test_5_builtin_policies_seeded(client):
    r = client.get("/__local__/policies")
    names = [p["name"] for p in r.json()["policies"]]
    for expected in ["cost-first", "quality-first", "free-only", "paid-only", "under-budget"]:
        assert expected in names, f"builtin policy '{expected}' missing"


def test_cannot_delete_builtin_policy(client):
    policies = client.get("/__local__/policies").json()["policies"]
    builtin = next(p for p in policies if p["name"] == "cost-first")
    r = client.delete(f"/__local__/policies/{builtin['id']}")
    assert r.status_code == 400


def test_custom_policy_upsert_then_delete(client):
    r = client.post("/__local__/policies", json={
        "name": "my-custom", "tier_order": ["free"], "allowed_tiers": ["free"],
        "max_cost_per_1m": 1.0,
    })
    assert r.status_code == 200
    pid = r.json()["id"]
    # 删除自定义策略
    r2 = client.delete(f"/__local__/policies/{pid}")
    assert r2.status_code == 200


def test_free_only_policy_filters_paid_providers(client):
    """policy.allowed_tiers=['free'] 时，paid provider 不在候选中。"""
    # 添加一个 free + 一个 paid
    asyncio.run(local_db.add_provider(
        provider_id="freeprov", display_name="free", tier="free",
        base_url="http://free.invalid", auth_type="none", models=["shared-m"],
    ))
    asyncio.run(local_db.add_provider(
        provider_id="paidprov", display_name="paid", tier="paid",
        base_url="http://paid.invalid", auth_type="none", models=["shared-m"],
    ))

    free_only = asyncio.run(local_db.get_routing_policy_by_name("free-only"))
    candidates = asyncio.run(local_gateway._candidates_for_model("shared-m", policy=free_only))
    ids = [c["provider_id"] for c in candidates]
    assert "freeprov" in ids
    assert "paidprov" not in ids


def test_cost_first_policy_orders_free_before_paid(client):
    asyncio.run(local_db.add_provider(
        provider_id="cheap-paid", tier="paid", base_url="http://x", auth_type="none",
        models=["shared"], display_name="cheap-paid",
        price_in=0.01, price_out=0.01,
    ))
    asyncio.run(local_db.add_provider(
        provider_id="free-prov", tier="free", base_url="http://y", auth_type="none",
        models=["shared"], display_name="free-prov",
    ))
    cost_first = asyncio.run(local_db.get_routing_policy_by_name("cost-first"))
    candidates = asyncio.run(local_gateway._candidates_for_model("shared", policy=cost_first))
    # cost-first 的 tier_order = [free, shared, paid]
    assert candidates[0]["provider_id"] == "free-prov"


# ── M14 app_bindings.routing_policy_id ──────────────────────────────────


def test_set_app_policy_then_request_uses_it(client):
    """X-Source-App 头 → 查 binding → 取 policy → 决定候选链顺序。"""
    asyncio.run(local_db.add_provider(
        provider_id="paid-x", tier="paid", base_url="http://paid.invalid", auth_type="none",
        models=["m"], display_name="paid-x",
    ))
    asyncio.run(local_db.add_provider(
        provider_id="free-x", tier="free", base_url="http://free.invalid", auth_type="none",
        models=["m"], display_name="free-x",
    ))
    # 模拟 app_bindings 表里有 claude_code 行
    asyncio.run(local_db.upsert_app_binding("claude_code", "http://x/v1", "lp-x…"))
    # 绑定 free-only policy
    free_only = asyncio.run(local_db.get_routing_policy_by_name("free-only"))
    r = client.post(f"/__local__/apps/claude_code/policy", json={"policy_id": free_only["id"]})
    assert r.status_code == 200

    call_log = []

    async def fake_post(self, url, **kwargs):
        call_log.append(url)
        return _mock_response(200, json_body={"id": "ok"})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post(
            "/v1/chat/completions",
            headers={"X-Source-App": "claude_code"},
            json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
        )
    # free-only 应过滤掉 paid
    assert all("paid.invalid" not in u for u in call_log), \
        f"free-only policy did not filter paid provider: {call_log}"


# ── M11 call_logs + Dashboard ────────────────────────────────────────────


def test_call_log_written_on_successful_request(client):
    asyncio.run(local_db.add_provider(
        provider_id="logged", tier="free", base_url="http://l.invalid", auth_type="none",
        models=["m"], display_name="logged",
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={
            "id": "x", "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 34},
        })

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post(
            "/v1/chat/completions",
            headers={"X-Source-App": "claude_code"},
            json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
        )

    recent = client.get("/__local__/dashboard/recent").json()["calls"]
    assert len(recent) == 1
    c = recent[0]
    assert c["model"] == "m"
    assert c["routed_to"] == "logged"
    assert c["tier"] == "free"
    assert c["app_source"] == "claude_code"
    assert c["input_tokens"] == 12
    assert c["output_tokens"] == 34
    assert c["success"] == 1


def test_dashboard_summary_aggregates_by_tier(client):
    asyncio.run(local_db.add_provider(
        provider_id="t1", tier="free", base_url="http://t1", auth_type="none",
        models=["m"], display_name="t1",
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={
            "id": "x", "choices": [{}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20},
        })

    with patch("httpx.AsyncClient.post", new=fake_post):
        for _ in range(3):
            client.post(
                "/v1/chat/completions",
                json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
            )

    s = client.get("/__local__/dashboard/summary?window=all").json()
    assert s["tier_capacity"]["free"]["providers"] == 1
    assert s["tier_usage"]["free"]["calls"] == 3
    assert s["tier_usage"]["free"]["input_tokens"] == 30
    assert s["tier_usage"]["free"]["output_tokens"] == 60


def test_cache_hit_logged_as_cached(client):
    """prompt-cache 命中也会写 call_log，tier=cache。"""
    body = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "temperature": 0}
    key = prompt_cache.compute_cache_key(body)
    asyncio.run(prompt_cache.put(key, "m", {"id": "cached", "choices": []}))
    asyncio.run(local_db.add_provider(
        provider_id="never-called", tier="free", base_url="http://x", auth_type="none",
        models=["m"], display_name="never",
    ))

    async def fake_post(self, url, **kwargs):
        raise AssertionError("should not call upstream on cache hit")

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post("/v1/chat/completions", json=body)

    recent = client.get("/__local__/dashboard/recent").json()["calls"]
    assert recent[0]["tier"] == "cache"
    assert recent[0]["cached"] == 1


# ── M15 QuickStart ──────────────────────────────────────────────────────


def test_quickstart_detect_returns_apps_and_recommendation(client):
    # 模拟 ollama 不在线（不发请求）
    async def fake_get(self, url, **kwargs):
        raise httpx.ConnectError("nope")

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = client.get("/__local__/quickstart/detect")
    assert r.status_code == 200
    body = r.json()
    assert body["ollama"]["alive"] is False
    assert len(body["apps"]) == 8  # 8 个支持的工具
    assert body["needs_quickstart"] is True
    assert any(rec["kind"] == "free_provider" for rec in body["recommendation"])


def test_quickstart_run_creates_provider_and_writes_app(tmp_path, monkeypatch, client):
    """事务性 run：加 provider + 写 app binding + 关联 policy。"""
    # 把 app_writers schema 重定向到 tmp（不要写真实 ~/.claude）
    import app_writers
    orig_path = app_writers.SCHEMAS["claude_code"].path
    sandbox_app = tmp_path / "claude" / "settings.local.json"
    app_writers.SCHEMAS["claude_code"].path = sandbox_app
    monkeypatch.setattr(app_writers, "BACKUP_DIR", tmp_path / "backups")

    try:
        r = client.post("/__local__/quickstart/run", json={
            "free_provider_id": "ollama",
            "api_key": "",
            "app_names": ["claude_code"],
            "policy_name": "cost-first",
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["provider_id"] == "ollama"
        assert body["policy_id"] is not None
        assert len(body["written"]) == 1

        # 验证 binding 已写 + 关联 policy
        bindings = client.get("/__local__/apps").json()["apps"]
        cc = next(a for a in bindings if a["app_name"] == "claude_code")
        assert cc["bound"] is True
        # 文件已实际写入
        assert sandbox_app.exists()
    finally:
        app_writers.SCHEMAS["claude_code"].path = orig_path


def test_quickstart_run_rejects_unknown_provider(client):
    r = client.post("/__local__/quickstart/run", json={
        "free_provider_id": "nonexistent-provider",
        "app_names": [],
    })
    assert r.status_code == 404

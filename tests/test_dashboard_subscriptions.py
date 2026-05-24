"""DASH-A/B —— dashboard 聚合 + subscriptions CRUD + burn rate + alerts。"""

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
import dashboard as dashboard_mod  # noqa: E402
import prompt_cache  # noqa: E402
import subscription_providers  # noqa: E402
import subscriptions as subscriptions_mod  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "dash.db"
    for mod in (local_db, prompt_cache, subscription_providers):
        monkeypatch.setattr(mod, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(local_db.init_local_db())
    asyncio.run(prompt_cache.init_cache_db())
    asyncio.run(subscription_providers.init_subscription_db())
    asyncio.run(subscriptions_mod.init_subscriptions_table())
    dashboard_mod.load_model_prices()
    return TestClient(local_gateway.app)


def _mock_response(status_code, json_body=None):
    r = MagicMock(spec=httpx.Response)
    r.status_code = status_code
    r.text = ""
    r.headers = {"content-type": "application/json"} if json_body is not None else {"content-type": "text/plain"}
    r.json = MagicMock(return_value=json_body or {})
    return r


# ── DASH-A: savings 估值 ────────────────────────────────────────────


def test_savings_zero_when_no_calls(client):
    r = client.get("/__local__/dashboard/savings?window=all").json()
    assert r["saved_usd"] == 0
    assert r["paid_equivalent_usd"] == 0


def test_savings_counts_free_as_saving(client):
    """跑一次 free tier 调用：paid_equivalent > 0，saved_usd > 0。"""
    asyncio.run(local_db.add_provider(
        provider_id="freep", display_name="freep", tier="free",
        base_url="http://f.invalid", auth_type="none", models=["gpt-5.5-mini"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "x", "choices": [{}],
                                                "usage": {"prompt_tokens": 100_000, "completion_tokens": 100_000}})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post("/v1/chat/completions",
                    json={"model": "gpt-5.5-mini", "messages": [{"role": "user", "content": "x"}]})

    r = client.get("/__local__/dashboard/savings?window=all").json()
    # gpt-5.5-mini: 0.15/1M in + 0.6/1M out
    # 100k in = 0.015, 100k out = 0.06 → paid_eq = 0.075
    assert r["paid_equivalent_usd"] > 0.07
    assert r["saved_usd"] > 0.07  # 全部都是 free，等于全省
    assert r["saved_pct"] == 100.0


def test_savings_when_actually_paid_zero(client):
    """付费源不算节省。"""
    asyncio.run(local_db.add_provider(
        provider_id="paidp", display_name="paid", tier="paid",
        base_url="http://p.invalid", auth_type="none", models=["gpt-5.5-mini"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "x", "choices": [{}],
                                                "usage": {"prompt_tokens": 100_000, "completion_tokens": 100_000}})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post("/v1/chat/completions",
                    json={"model": "gpt-5.5-mini", "messages": [{"role": "user", "content": "x"}]})

    r = client.get("/__local__/dashboard/savings?window=all").json()
    assert r["saved_usd"] == 0


# ── DASH-A: trend ───────────────────────────────────────────────────


def test_trend_empty(client):
    r = client.get("/__local__/dashboard/trend?window=7d").json()
    assert r["window"] == "7d"
    assert r["buckets"] == []


def test_trend_aggregates_buckets(client):
    asyncio.run(local_db.add_provider(
        provider_id="p", display_name="p", tier="free",
        base_url="http://p.invalid", auth_type="none", models=["m"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "x", "choices": [{}],
                                                "usage": {"prompt_tokens": 10, "completion_tokens": 20}})

    with patch("httpx.AsyncClient.post", new=fake_post):
        for _ in range(3):
            client.post("/v1/chat/completions",
                        json={"model": "m", "messages": [{"role": "user", "content": "x"}]})

    r = client.get("/__local__/dashboard/trend?window=7d").json()
    assert len(r["buckets"]) == 1  # 都在今天
    assert r["buckets"][0]["free"] == 90  # 3 × 30 tokens


# ── DASH-A: attribution ─────────────────────────────────────────────


def test_attribution_groups_by_app(client):
    asyncio.run(local_db.add_provider(
        provider_id="p", display_name="p", tier="free",
        base_url="http://p.invalid", auth_type="none", models=["m"],
    ))

    async def fake_post(self, url, **kwargs):
        return _mock_response(200, json_body={"id": "x", "choices": [{}],
                                                "usage": {"prompt_tokens": 10, "completion_tokens": 20}})

    with patch("httpx.AsyncClient.post", new=fake_post):
        client.post("/v1/chat/completions",
                    headers={"X-Source-App": "claude_code"},
                    json={"model": "m", "messages": [{"role": "user", "content": "x"}]})
        client.post("/v1/chat/completions",
                    headers={"X-Source-App": "cursor"},
                    json={"model": "m", "messages": [{"role": "user", "content": "x"}]})

    r = client.get("/__local__/dashboard/attribution?window=all").json()
    apps = {a["app"]: a for a in r["items"]}
    assert "claude_code" in apps and "cursor" in apps
    assert apps["claude_code"]["calls"] == 1
    assert apps["cursor"]["calls"] == 1


# ── DASH-B: subscriptions CRUD ──────────────────────────────────────


def test_create_subscription(client):
    r = client.post("/__local__/subscriptions", json={
        "provider_id": "anthropic-official",
        "display_name": "Claude Pro",
        "plan_kind": "plan",
        "plan_name": "Pro",
        "monthly_cost": 20.0,
        "auto_renew": True,
    })
    assert r.status_code == 200
    sub = r.json()
    assert sub["display_name"] == "Claude Pro"
    assert sub["plan_kind"] == "plan"


def test_list_subscriptions_enriches_burn_rate(client):
    client.post("/__local__/subscriptions", json={
        "provider_id": "openai-official",
        "display_name": "OpenAI",
        "plan_kind": "payg",
        "balance_remaining": 10.0,
    })
    r = client.get("/__local__/subscriptions").json()
    assert len(r["subscriptions"]) == 1
    sub = r["subscriptions"][0]
    assert "burn" in sub
    assert "days_until_depletion" in sub
    assert "related_scenarios" in sub


def test_update_subscription_balance(client):
    s = client.post("/__local__/subscriptions", json={
        "provider_id": "openai-official",
        "display_name": "x",
        "plan_kind": "payg",
        "balance_remaining": 10.0,
    }).json()
    r = client.patch(f"/__local__/subscriptions/{s['id']}", json={"balance_remaining": 5.0})
    assert r.json()["balance_remaining"] == 5.0


def test_delete_subscription(client):
    s = client.post("/__local__/subscriptions", json={
        "provider_id": "openai-official",
        "display_name": "x",
    }).json()
    client.delete(f"/__local__/subscriptions/{s['id']}")
    assert client.get("/__local__/subscriptions").json()["subscriptions"] == []


# ── DASH-B: burn rate ───────────────────────────────────────────────


def test_burn_rate_zero_for_no_usage(client):
    sub_id = client.post("/__local__/subscriptions", json={
        "provider_id": "openai-official",
        "display_name": "x",
        "plan_kind": "payg",
    }).json()["id"]
    r = client.get("/__local__/subscriptions").json()["subscriptions"][0]
    assert r["burn"]["daily_avg_usd"] == 0
    assert r["days_until_depletion"] is None  # 没用量 + 没余额


def test_days_until_depletion_calculated(client):
    """有 burn rate 和 balance 时算耗尽天数。"""
    # 直接构造 burn rate：跑 7 天前的调用太麻烦，绕过：手动写 call_log
    asyncio.run(local_db.add_provider(
        provider_id="openai-official", display_name="OpenAI", tier="paid",
        base_url="http://x", auth_type="none", models=["gpt-5.5"],
    ))
    # 模拟昨天有一笔 1M tokens gpt-5.5 的调用
    import aiosqlite
    async def insert():
        async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
            await db.execute(
                "INSERT INTO call_logs(timestamp, model, routed_to, tier, "
                "input_tokens, output_tokens, latency_ms, success) "
                "VALUES (datetime('now', '-1 day'), 'gpt-5.5', 'openai-official', 'paid', "
                "500000, 500000, 100, 1)"
            )
            await db.commit()
    asyncio.run(insert())

    client.post("/__local__/subscriptions", json={
        "provider_id": "openai-official",
        "display_name": "OpenAI",
        "plan_kind": "payg",
        "balance_remaining": 100.0,  # 还剩 $100
    })
    r = client.get("/__local__/subscriptions").json()["subscriptions"][0]
    # gpt-5.5: 5/1M in + 15/1M out → 0.5M in = 2.5; 0.5M out = 7.5; total 10
    # 7d 内只一次 $10，daily = 10/7 ≈ 1.43
    # 100 / 1.43 ≈ 70 天
    assert r["burn"]["total_cost_usd"] > 9.9
    assert r["days_until_depletion"] is not None
    assert r["days_until_depletion"] > 50


# ── DASH-B: alerts ──────────────────────────────────────────────────


def test_alerts_low_balance(client):
    client.post("/__local__/subscriptions", json={
        "provider_id": "openai-official",
        "display_name": "OpenAI",
        "plan_kind": "payg",
        "quota_total": 100.0,
        "balance_remaining": 5.0,  # 5%，低于 20% 阈值
    })
    r = client.get("/__local__/alerts").json()
    assert len(r["alerts"]) >= 1
    assert any(a["kind"] == "low_balance" for a in r["alerts"])


def test_alerts_renewal_soon(client):
    from datetime import datetime, timedelta
    # 用「明天」+ alert_days_before=2 确保稳定触发（无论 UTC 时间几点）
    tomorrow = (datetime.utcnow() + timedelta(days=1)).strftime("%Y-%m-%d")
    client.post("/__local__/subscriptions", json={
        "provider_id": "anthropic-official",
        "display_name": "Claude Pro",
        "plan_kind": "plan",
        "renews_at": tomorrow,
        "alert_days_before": 2,
    })
    r = client.get("/__local__/alerts").json()
    assert any(a["kind"] == "renewal_soon" for a in r["alerts"]), f"alerts: {r['alerts']}"


def test_alerts_disabled_when_alert_flag_off(client):
    client.post("/__local__/subscriptions", json={
        "provider_id": "openai-official",
        "display_name": "x",
        "plan_kind": "payg",
        "quota_total": 100.0,
        "balance_remaining": 5.0,
        "alert_enabled": False,
    })
    r = client.get("/__local__/alerts").json()
    assert r["alerts"] == []


# ── KPI 加入 savings 字段 ───────────────────────────────────────────


def test_gateway_kpis_includes_savings(client):
    r = client.get("/__local__/gateway/kpis").json()
    assert "saved_usd" in r
    assert "saved_pct" in r
    assert "paid_equivalent_usd" in r

"""TC-③-201 ~ 206 —— 高级模式 + ToS Ack 审计回归。

跑法：python -m pytest tests/test_tos_acks.py -v
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import local_db  # noqa: E402
import local_gateway  # noqa: E402
import subscription_providers  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "tos.db"
    monkeypatch.setattr(local_db, "LOCAL_DB_PATH", str(db_path))
    monkeypatch.setattr(subscription_providers, "LOCAL_DB_PATH", str(db_path))
    # 重新 init schemas
    asyncio.run(local_db.init_local_db())
    asyncio.run(subscription_providers.init_subscription_db())
    # prompt_cache 也要 init（lifespan 里会用）
    import prompt_cache
    monkeypatch.setattr(prompt_cache, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(prompt_cache.init_cache_db())
    # TestClient 不会触发 lifespan，但我们提前 init 即可
    return TestClient(local_gateway.app)


# ── TC-③-201 ack 文本含关键关键词 ──────────────────────────────────


def test_advanced_mode_text_contains_4_risks(client):
    r = client.get("/__local__/contribute/advanced-mode/text")
    assert r.status_code == 200
    text = r.json()["text"]
    # 4 条具体风险编号
    assert "1." in text and "2." in text and "3." in text and "4." in text
    # 关键合规词
    for kw in ["ToS", "封号", "风控", "法律", "数据隐私"]:
        assert kw in text, f"ack text missing keyword '{kw}'"


# ── TC-③-202 不带 ack:true → 400 ───────────────────────────────────


def test_enable_advanced_without_ack_rejected(client):
    r = client.post("/__local__/contribute/advanced-mode/enable", json={"ack": False})
    assert r.status_code == 400


def test_enable_advanced_with_ack_succeeds(client):
    r = client.post("/__local__/contribute/advanced-mode/enable", json={"ack": True})
    assert r.status_code == 200
    assert r.json()["advanced_mode"] is True


# ── TC-③-203 enable 后写 tos_acks 表 ───────────────────────────────


def test_enable_writes_tos_ack_record(client):
    client.post(
        "/__local__/contribute/advanced-mode/enable",
        json={"ack": True, "user_hint": "ci-test"},
    )
    r = client.get("/__local__/contribute/tos-acks")
    acks = r.json()["acks"]
    assert any(a["action"] == "enable_advanced" for a in acks)
    enable = next(a for a in acks if a["action"] == "enable_advanced")
    assert enable["user_hint"] == "ci-test"
    assert "4 条具体风险" in enable["ack_text"]


# ── TC-③-104 / 204 subscription 类型受 advanced_mode 守门 ──────────


def test_subscription_source_blocked_when_advanced_off(client):
    r = client.post(
        "/__local__/contribute/sources",
        json={"source_kind": "subscription", "display_name": "test"},
    )
    assert r.status_code == 403


def test_subscription_source_allowed_after_enable(client):
    client.post("/__local__/contribute/advanced-mode/enable", json={"ack": True})
    r = client.post(
        "/__local__/contribute/sources",
        json={"source_kind": "subscription", "display_name": "test-sub"},
    )
    assert r.status_code == 200
    sources = client.get("/__local__/contribute/sources").json()["sources"]
    assert any(s["display_name"] == "test-sub" and s["source_kind"] == "subscription" for s in sources)


def test_local_source_always_allowed(client):
    """local 类型不受 advanced_mode 影响。"""
    r = client.post(
        "/__local__/contribute/sources",
        json={"source_kind": "local", "display_name": "my-ollama", "models": ["qwen3-8b"]},
    )
    assert r.status_code == 200
    sources = client.get("/__local__/contribute/sources").json()["sources"]
    assert any(s["source_kind"] == "local" for s in sources)


# ── TC-③-205 disable 也落 ack 记录 ─────────────────────────────────


def test_disable_writes_separate_ack(client):
    client.post("/__local__/contribute/advanced-mode/enable", json={"ack": True})
    client.post("/__local__/contribute/advanced-mode/disable")
    acks = client.get("/__local__/contribute/tos-acks").json()["acks"]
    actions = [a["action"] for a in acks]
    assert "enable_advanced" in actions
    assert "disable_advanced" in actions


# ── TC-③-206 disable 后 subscription DB 行保留 ──────────────────────


def test_subscription_data_preserved_after_disable(client):
    client.post("/__local__/contribute/advanced-mode/enable", json={"ack": True})
    client.post(
        "/__local__/contribute/sources",
        json={"source_kind": "subscription", "display_name": "preserve-me"},
    )
    client.post("/__local__/contribute/advanced-mode/disable")
    # DB 行仍在；UI 隐藏与否是 client 决定
    sources = client.get("/__local__/contribute/sources").json()["sources"]
    assert any(s["display_name"] == "preserve-me" for s in sources)


# ── TC-③-105 toggle / delete ───────────────────────────────────────


def test_toggle_and_delete_source(client):
    r = client.post(
        "/__local__/contribute/sources",
        json={"source_kind": "local", "display_name": "x"},
    )
    sid = r.json()["id"]
    # toggle on
    client.post(f"/__local__/contribute/sources/{sid}/toggle?enabled=true")
    s = client.get("/__local__/contribute/sources").json()["sources"][0]
    assert s["enabled"] == 1
    # toggle off
    client.post(f"/__local__/contribute/sources/{sid}/toggle?enabled=false")
    s = client.get("/__local__/contribute/sources").json()["sources"][0]
    assert s["enabled"] == 0
    # delete
    client.delete(f"/__local__/contribute/sources/{sid}")
    assert client.get("/__local__/contribute/sources").json()["sources"] == []

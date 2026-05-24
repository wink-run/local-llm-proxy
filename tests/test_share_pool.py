"""P2P-1/2 —— share_pool.py 抓 VPS + connect/disconnect 流程。"""

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
import share_pool  # noqa: E402
import subscription_providers  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "share.db"
    for mod in (local_db, prompt_cache, subscription_providers):
        monkeypatch.setattr(mod, "LOCAL_DB_PATH", str(db_path))
    asyncio.run(local_db.init_local_db())
    asyncio.run(prompt_cache.init_cache_db())
    asyncio.run(subscription_providers.init_subscription_db())
    share_pool.clear_cache()
    return TestClient(local_gateway.app)


def _mock_get(status_code, json_body=None):
    r = MagicMock(spec=httpx.Response)
    r.status_code = status_code
    r.text = ""
    r.headers = {"content-type": "application/json"} if json_body is not None else {}
    r.json = MagicMock(return_value=json_body or {})
    return r


# ── share_pool helper ──────────────────────────────────────────────


def test_fetch_network_ok():
    share_pool.clear_cache()
    body = {"summary": {"online_workers": 3, "active_users": 2}, "workers": []}
    async def fake_get(self, url, **kwargs):
        return _mock_get(200, body)

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = asyncio.run(share_pool.fetch_network("http://vps.test"))
    assert r["ok"] is True
    assert r["summary"]["online_workers"] == 3


def test_fetch_models():
    share_pool.clear_cache()
    body = {"data": [{"id": "m1"}, {"id": "m2"}]}
    async def fake_get(self, url, **kwargs):
        return _mock_get(200, body)

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = asyncio.run(share_pool.fetch_models("http://vps.test"))
    assert r == ["m1", "m2"]


def test_fetch_network_unreachable():
    share_pool.clear_cache()
    async def fake_get(self, url, **kwargs):
        raise httpx.ConnectError("down")

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = asyncio.run(share_pool.fetch_network("http://vps.test"))
    assert r["ok"] is False


def test_fetch_cached(monkeypatch):
    """第二次调用应该走缓存，不再发请求。"""
    share_pool.clear_cache()
    call_count = {"n": 0}
    async def fake_get(self, url, **kwargs):
        call_count["n"] += 1
        return _mock_get(200, {"summary": {}, "workers": []})

    with patch("httpx.AsyncClient.get", new=fake_get):
        asyncio.run(share_pool.fetch_network("http://vps.test"))
        asyncio.run(share_pool.fetch_network("http://vps.test"))
    assert call_count["n"] == 1


def test_verify_credentials_ok():
    async def fake_get(self, url, **kwargs):
        return _mock_get(200, {"data": [{"id": "x"}, {"id": "y"}]})

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = asyncio.run(share_pool.verify_credentials("http://vps.test", "sk-x"))
    assert r["ok"] is True
    assert r["model_count"] == 2


def test_verify_credentials_401():
    async def fake_get(self, url, **kwargs):
        return _mock_get(401, {"error": "invalid key"})

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = asyncio.run(share_pool.verify_credentials("http://vps.test", "sk-bad"))
    assert r["ok"] is False
    assert r["status"] == 401


# ── /__local__/share-pool 端点 ─────────────────────────────────────


def test_share_pool_status_empty(client):
    r = client.get("/__local__/share-pool").json()
    assert r["available"] is False
    assert r["connected"] == []
    assert len(r["catalog"]) >= 1   # shared-network 模板


def test_share_pool_connect_creates_provider(client):
    async def fake_get(self, url, **kwargs):
        if "/v1/models" in url:
            return _mock_get(200, {"data": [{"id": "qwen3-72b"}, {"id": "llama-4-70b"}]})
        if "/public/network" in url:
            return _mock_get(200, {"summary": {"online_workers": 2}, "workers": []})
        return _mock_get(404)

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = client.post("/__local__/share-pool/connect", json={
            "vps_url": "http://vps.test",
            "api_key": "sk-test",
        })
    assert r.status_code == 200
    body = r.json()
    assert body["vps_url"] == "http://vps.test"
    assert "qwen3-72b" in body["models"]

    # 验证 local_provider 已添加
    providers = client.get("/__local__/providers").json()["providers"]
    shared = [p for p in providers if p["tier"] == "shared"]
    assert len(shared) == 1
    assert shared[0]["base_url"] == "http://vps.test/v1"


def test_share_pool_connect_rejects_bad_key(client):
    async def fake_get(self, url, **kwargs):
        return _mock_get(401, {"error": "invalid"})

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = client.post("/__local__/share-pool/connect", json={
            "vps_url": "http://vps.test",
            "api_key": "sk-bad",
        })
    assert r.status_code == 400


def test_share_pool_status_after_connect(client):
    async def fake_get(self, url, **kwargs):
        if "/public/network" in url:
            return _mock_get(200, {"summary": {"online_workers": 3, "active_users": 2}, "workers": [
                {"worker_id": "w1", "name": "张*", "models": ["qwen3"], "stars": 5, "multiplier": 1.4}
            ]})
        return _mock_get(200, {"data": [{"id": "qwen3"}]})

    with patch("httpx.AsyncClient.get", new=fake_get):
        client.post("/__local__/share-pool/connect", json={
            "vps_url": "http://vps.test", "api_key": "sk-test",
        })
        r = client.get("/__local__/share-pool").json()

    assert r["available"] is True
    assert len(r["connected"]) == 1
    conn = r["connected"][0]
    assert conn["vps_url"] == "http://vps.test"
    assert conn["online"] is True
    assert conn["summary"]["online_workers"] == 3
    assert len(conn["workers"]) == 1


def test_share_pool_disconnect(client):
    async def fake_get(self, url, **kwargs):
        return _mock_get(200, {"data": [{"id": "x"}], "summary": {}, "workers": []})

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = client.post("/__local__/share-pool/connect", json={
            "vps_url": "http://vps.test", "api_key": "sk-test",
        })
        pid = r.json()["id"]
        client.post(f"/__local__/share-pool/disconnect/{pid}")
        listed = client.get("/__local__/providers").json()["providers"]
    assert not any(p["tier"] == "shared" for p in listed)


def test_share_pool_strips_trailing_v1(client):
    """如果 vps_url 末尾带 /v1，应自动去掉。"""
    async def fake_get(self, url, **kwargs):
        return _mock_get(200, {"data": [], "summary": {}, "workers": []})

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = client.post("/__local__/share-pool/connect", json={
            "vps_url": "http://vps.test/v1", "api_key": "sk-test",
        })
    assert r.json()["vps_url"] == "http://vps.test"

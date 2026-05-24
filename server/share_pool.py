"""P2P 共享池客户端：抓 VPS 的 /public/network + /v1/models。

把 VPS 端的 worker_pool 状态拉回本地，让 Sources Layer 3 / Dashboard 能展示
"现在分享池里有多少节点 / 多少模型 / 谁在线"。

设计：DESIGN_v2.md §2.5 Layer 3
"""

from __future__ import annotations

import time
from typing import Optional

import httpx


# ── 30s 缓存（避免每次 UI 刷新都打 VPS） ────────────────────────────

_CACHE_TTL_SEC = 30
_cache: dict[str, dict] = {}


def _cache_key(vps_url: str, path: str) -> str:
    return f"{vps_url.rstrip('/')}|{path}"


async def _cached_get(vps_url: str, path: str, *, timeout: float = 5.0) -> Optional[dict]:
    key = _cache_key(vps_url, path)
    now = time.time()
    cached = _cache.get(key)
    if cached and (now - cached["ts"]) < _CACHE_TTL_SEC:
        return cached["data"]
    url = vps_url.rstrip("/") + path
    try:
        async with httpx.AsyncClient(timeout=timeout) as cli:
            r = await cli.get(url)
            if r.status_code >= 400:
                return None
            data = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    _cache[key] = {"ts": now, "data": data}
    return data


def clear_cache() -> None:
    _cache.clear()


# ── VPS 端点查询 ───────────────────────────────────────────────────


async def fetch_network(vps_url: str) -> dict:
    """GET {vps}/public/network → 在线 worker + summary。"""
    data = await _cached_get(vps_url, "/public/network")
    if data is None:
        return {"ok": False, "summary": {}, "workers": []}
    return {"ok": True, **data}


async def fetch_models(vps_url: str) -> list[str]:
    """GET {vps}/v1/models → 模型列表（聚合自所有 worker）。"""
    data = await _cached_get(vps_url, "/v1/models")
    if data is None:
        return []
    items = data.get("data") or []
    return [m["id"] for m in items if isinstance(m, dict) and m.get("id")]


async def verify_credentials(vps_url: str, api_key: str) -> dict:
    """验证用户的 sk-* key 能否调 /v1/models（轻量请求测可用性）。"""
    url = vps_url.rstrip("/") + "/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10) as cli:
            r = await cli.get(url, headers={"Authorization": f"Bearer {api_key}"})
        if r.status_code < 400:
            try:
                count = len((r.json() or {}).get("data") or [])
            except ValueError:
                count = 0
            return {"ok": True, "status": r.status_code, "model_count": count}
        return {
            "ok": False, "status": r.status_code,
            "error": (r.text or "")[:300] or f"HTTP {r.status_code}",
        }
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

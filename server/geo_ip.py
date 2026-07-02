# IP → 经纬度（供 P2P 全球地图展示；结果内存缓存，不对外暴露原始 IP）
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import logging
import time
from typing import Optional

import httpx

logger = logging.getLogger("server")

_CACHE: dict[str, tuple[float, Optional[dict]]] = {}
_CACHE_TTL = 86400  # 24h
_LOOKUP_LOCK = asyncio.Lock()


def _is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.strip())
        return addr.is_global
    except ValueError:
        return False


def client_ip_from_ws(ws) -> Optional[str]:
    """WebSocket 客户端 IP（优先 X-Forwarded-For，适配反代）。"""
    headers = getattr(ws, "headers", None) or {}
    xff = headers.get("x-forwarded-for") or headers.get("X-Forwarded-For")
    if xff:
        ip = xff.split(",")[0].strip()
        if ip:
            return ip
    client = getattr(ws, "client", None)
    if client and client.host:
        return client.host
    return None


async def resolve_ip_geo(ip: Optional[str]) -> Optional[dict]:
    """解析公网 IP → { lat, lng, country_code, city }；私网/无效返回 None。"""
    if not ip or not _is_public_ip(ip):
        return None

    now = time.time()
    cached = _CACHE.get(ip)
    if cached and now - cached[0] < _CACHE_TTL:
        return cached[1]

    async with _LOOKUP_LOCK:
        cached = _CACHE.get(ip)
        if cached and now - cached[0] < _CACHE_TTL:
            return cached[1]

        geo: Optional[dict] = None
        try:
            url = f"http://ip-api.com/json/{ip}?fields=status,lat,lon,countryCode,city"
            async with httpx.AsyncClient(timeout=4.0) as client:
                r = await client.get(url)
                if r.status_code == 200:
                    data = r.json()
                    if data.get("status") == "success":
                        lat, lng = data.get("lat"), data.get("lon")
                        if lat is not None and lng is not None:
                            geo = {
                                "lat": float(lat),
                                "lng": float(lon),
                                "country_code": (data.get("countryCode") or "").upper(),
                                "city": (data.get("city") or "").strip(),
                            }
        except Exception as e:
            logger.debug("[geo_ip] lookup failed ip=%s: %s", ip, e)

        _CACHE[ip] = (time.time(), geo)
        return geo


# 虚拟 Agent 无真实 IP：按 worker_id 稳定随机落在中国主要城市（地图展示用）
_VIRTUAL_CN_CITIES = (
    {"name": "北京", "lat": 39.9042, "lng": 116.4074},
    {"name": "西安", "lat": 34.3416, "lng": 108.9398},
    {"name": "上海", "lat": 31.2304, "lng": 121.4737},
    {"name": "深圳", "lat": 22.5431, "lng": 114.0579},
    {"name": "广州", "lat": 23.1291, "lng": 113.2644},
    {"name": "杭州", "lat": 30.2741, "lng": 120.1551},
    {"name": "成都", "lat": 30.5728, "lng": 104.0668},
)


def virtual_worker_geo(worker_id: str) -> dict:
    """虚拟 Worker 地图坐标：同一 worker_id 始终落在同一城市（带微小偏移）。"""
    digest = hashlib.md5(str(worker_id or "vw").encode()).hexdigest()
    idx = int(digest[:8], 16) % len(_VIRTUAL_CN_CITIES)
    city = _VIRTUAL_CN_CITIES[idx]
    j = int(digest[8:16], 16)
    lat_off = ((j & 0xFF) / 255 - 0.5) * 0.08
    lng_off = (((j >> 8) & 0xFF) / 255 - 0.5) * 0.08
    return {
        "lat": city["lat"] + lat_off,
        "lng": city["lng"] + lng_off,
        "country_code": "CN",
        "city": city["name"],
    }

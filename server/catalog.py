"""供给源目录 —— 通过 GET /api/catalog 下发给客户端。

数据源：static/defaults/providers.registry.yaml（可被 DB config.providers 覆盖）。
改 registry 即可让所有客户端拿到新源，无需发版客户端。
"""

from provider_registry import (
    TIERS,
    catalog_from_doc,
    catalog_providers,
    catalog_providers_sync,
    load_registry_doc,
)


async def catalog_public_payload() -> dict:
    """registry providers + billing_sources 中的 APP/API 订阅源（个人源模板）。"""
    from billing_sources import normalize_source, sort_sources

    doc = await load_registry_doc()
    subscription_sources: list[dict] = []
    for raw in sort_sources(doc.get("billing_sources") or []):
        s = normalize_source(raw)
        cat = s.get("category")
        if cat not in ("app_sub", "api_sub"):
            continue
        sid = s.get("source_id") or s.get("id")
        if not sid:
            continue
        models = [
            {"name": m["id"], "type": m.get("modality") or "chat"}
            for m in (s.get("models") or [])
            if m.get("id")
        ]
        subscription_sources.append({
            "id": sid,
            "kind": cat,
            "label": s.get("label") or sid,
            "icon": s.get("icon") or "🔧",
            "agent_id": s.get("agent_id") or "",
            "plan_provider_id": s.get("plan_provider_id"),
            "subscription_to_api": bool(s.get("subscription_to_api")),
            "base_url": s.get("base_url") or "",
            "api_format": s.get("api_format") or "openai",
            "models": models,
            "pricing": dict(s.get("pricing") or {}),
            "plans": list(s.get("plans") or []),
        })
    return {
        "tiers": list(TIERS),
        "providers": catalog_from_doc(doc),
        "subscription_sources": subscription_sources,
    }


# 同步兜底（import 时可用；HTTP 接口请用 await catalog_public_payload()）
PROVIDER_CATALOG = catalog_providers_sync()

__all__ = [
    "TIERS",
    "PROVIDER_CATALOG",
    "catalog_providers",
    "catalog_providers_sync",
    "catalog_public_payload",
]

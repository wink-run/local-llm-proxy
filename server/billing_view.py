"""云端用户中心：合并系统计费目录与用户 billing_json，生成个人页视图。"""

from __future__ import annotations

from typing import Any

import yaml

import database as db
from config_merge import merge_apps_doc, _default_apps_doc


def _norm_plan(p: Any) -> dict | None:
    if isinstance(p, list) and len(p) >= 2:
        return {"id": str(p[0]), "label": str(p[1]), "monthly_usd": None}
    if not isinstance(p, dict):
        return None
    pid = str(p.get("id") or "")
    if not pid:
        return None
    monthly = p.get("monthly_usd")
    return {
        "id": pid,
        "label": str(p.get("label") or pid),
        "monthly_usd": float(monthly) if monthly not in (None, "") else None,
    }


def _norm_payg_entry(p: dict) -> dict:
    pid = str(p.get("id") or p.get("provider_id") or "")
    models: list[str] = []
    pricing: dict[str, dict] = {}
    if isinstance(p.get("pricing"), dict):
        for model, rates in p["pricing"].items():
            if isinstance(rates, dict):
                pricing[str(model)] = dict(rates)
    for m in p.get("models") or []:
        if isinstance(m, str):
            models.append(m)
        elif isinstance(m, dict):
            mid = m.get("id") or m.get("model")
            if not mid:
                continue
            models.append(str(mid))
            rates = {k: v for k, v in m.items() if k not in ("id", "model")}
            if rates:
                pricing[str(mid)] = {**(pricing.get(str(mid)) or {}), **rates}
    return {
        "id": pid,
        "provider_id": pid,
        "label": p.get("label") or p.get("name") or pid,
        "icon": p.get("icon") or "🔧",
        "aliases": [str(a) for a in (p.get("aliases") or [])],
        "models": models,
        "pricing": pricing,
    }


async def _load_apps_doc() -> dict:
    """读取并合并系统 apps 配置（DB 上传 + 内置默认）。"""
    raw = await db.get_config("config.apps", "")
    if raw and raw.strip():
        try:
            parsed = yaml.safe_load(raw) or {}
        except yaml.YAMLError:
            parsed = {}
        return merge_apps_doc(parsed if isinstance(parsed, dict) else {})
    return merge_apps_doc(_default_apps_doc())


def _subscription_plans(apps: dict, user_billing: dict) -> dict[str, list]:
    yaml_plans = apps.get("subscription_plans") or {}
    user_plans = user_billing.get("subscription_plans") or {}
    ids = set(yaml_plans.keys()) | set(user_plans.keys())
    out: dict[str, list] = {}
    for pid in ids:
        raw = user_plans.get(pid, yaml_plans.get(pid, []))
        out[pid] = [pl for pl in (_norm_plan(x) for x in (raw or [])) if pl]
    return out


def _subscription_app_catalog(apps: dict, plans: dict[str, list]) -> list[dict]:
    out = []
    for a in apps.get("subscription_apps") or []:
        if not isinstance(a, dict):
            continue
        plan_key = a.get("plan_provider_id") or a.get("provider_id")
        app_plans = plans.get(plan_key, []) if plan_key else []
        out.append({
            "source_id": a.get("source_id") or a.get("id") or a.get("agent_id"),
            "agent_id": a.get("agent_id"),
            "provider_id": a.get("provider_id"),
            "plan_provider_id": plan_key,
            "subscription_to_api": a.get("subscription_to_api") is True,
            "app_name": a.get("app_name") or a.get("name") or a.get("agent_id"),
            "app_icon": a.get("app_icon") or a.get("icon") or "🔧",
            "plans": app_plans,
        })
    return out


def _api_subscription_catalog(apps: dict, plans: dict[str, list]) -> list[dict]:
    out = []
    for a in apps.get("api_subscription_apps") or []:
        if not isinstance(a, dict):
            continue
        plan_key = a.get("plan_provider_id")
        app_plans = plans.get(plan_key, []) if plan_key else []
        out.append({
            "source_id": a.get("source_id") or a.get("id"),
            "plan_provider_id": plan_key,
            "app_name": a.get("app_name") or a.get("name") or a.get("source_id"),
            "app_icon": a.get("app_icon") or a.get("icon") or "🔑",
            "plans": app_plans,
        })
    return out


def _payg_provider_catalog(apps: dict) -> list[dict]:
    return [_norm_payg_entry(p) for p in (apps.get("payg_providers") or []) if isinstance(p, dict)]


def _provider_pricing(apps: dict, user_billing: dict) -> dict[str, dict]:
    yaml_pricing: dict[str, dict] = {}
    for p in _payg_provider_catalog(apps):
        pid = p.get("provider_id")
        if pid and p.get("pricing"):
            yaml_pricing[pid] = dict(p["pricing"])
    overrides = user_billing.get("provider_pricing_overrides") or {}
    ids = set(yaml_pricing.keys()) | set(overrides.keys())
    merged: dict[str, dict] = {}
    for pid in ids:
        merged[pid] = {**(yaml_pricing.get(pid) or {})}
        for model, rates in (overrides.get(pid) or {}).items():
            merged[pid][model] = {**(merged[pid].get(model) or {}), **(rates or {})}
    return merged


def _resolve_sub_use_api(sub: dict, catalog_by_source: dict) -> bool:
    if sub.get("subscription_kind") == "api":
        return True
    if sub.get("subscription_to_api") is not None:
        return sub.get("subscription_to_api") is True
    cat = catalog_by_source.get(sub.get("source_id"))
    return cat.get("subscription_to_api") is True if cat else False


def _subscription_gateway_provider_id(sub: dict, catalog_by_source: dict) -> str | None:
    if not sub:
        return None
    if sub.get("custom"):
        return sub.get("source_id") or sub.get("plan_provider_id")
    if sub.get("subscription_kind") == "api":
        return sub.get("plan_provider_id")
    cat = catalog_by_source.get(sub.get("source_id"))
    return cat.get("plan_provider_id") if cat else None


def _resolve_subscription_gateway_ids(user_billing: dict, catalog_by_source: dict) -> list[str]:
    ids: set[str] = set()
    for sub in user_billing.get("user_subscriptions") or []:
        pid = _subscription_gateway_provider_id(sub, catalog_by_source)
        if pid and _resolve_sub_use_api(sub, catalog_by_source):
            ids.add(pid)
    return sorted(ids)


def _resolve_gateway_payg_ids(user_billing: dict) -> list[str]:
    return sorted({
        p.get("provider_id") for p in (user_billing.get("user_payg_providers") or [])
        if p.get("provider_id")
    })


def _resolve_user_gateway_ids(user_billing: dict, catalog_by_source: dict) -> list[str]:
    return sorted(set(_resolve_subscription_gateway_ids(user_billing, catalog_by_source))
                  | set(_resolve_gateway_payg_ids(user_billing)))


def _resolve_stats_only_ids(user_billing: dict, catalog_by_source: dict) -> list[str]:
    gateway = set(_resolve_user_gateway_ids(user_billing, catalog_by_source))
    payg_ids = {p.get("provider_id") for p in (user_billing.get("user_payg_providers") or [])}
    stats_only: set[str] = set()
    for sub in user_billing.get("user_subscriptions") or []:
        cat = catalog_by_source.get(sub.get("source_id"))
        pid = cat.get("plan_provider_id") if cat else None
        if pid and pid not in gateway and pid not in payg_ids:
            stats_only.add(pid)
    return sorted(stats_only)


async def build_user_accounts_view(user_billing: dict) -> dict:
    """生成与客户端 billing-config.getUserAccounts 对齐的云端视图。"""
    billing = user_billing
    apps = await _load_apps_doc()
    plans = _subscription_plans(apps, billing)
    sub_catalog = _subscription_app_catalog(apps, plans)
    catalog_by_source = {c["source_id"]: c for c in sub_catalog if c.get("source_id")}
    provider_pricing = _provider_pricing(apps, billing)
    gateway_sub = _resolve_subscription_gateway_ids(billing, catalog_by_source)
    gateway_payg = _resolve_gateway_payg_ids(billing)
    return {
        "subscription_catalog": sub_catalog,
        "api_subscription_catalog": _api_subscription_catalog(apps, plans),
        "payg_provider_catalog": _payg_provider_catalog(apps),
        "user_subscriptions": billing.get("user_subscriptions") or [],
        "user_payg_providers": billing.get("user_payg_providers") or [],
        "paid_provider_ids": sorted({
            *(gateway_sub or []),
            *(gateway_payg or []),
            *_resolve_stats_only_ids(billing, catalog_by_source),
        }),
        "gateway_provider_ids": _resolve_user_gateway_ids(billing, catalog_by_source),
        "gateway_subscription_provider_ids": gateway_sub,
        "gateway_payg_provider_ids": gateway_payg,
        "stats_only_provider_ids": _resolve_stats_only_ids(billing, catalog_by_source),
        "subscription_plans": plans,
        "provider_pricing": provider_pricing,
        "provider_pricing_overrides": billing.get("provider_pricing_overrides") or {},
        "provider_labels": {
            p["provider_id"]: p.get("label") or p["provider_id"]
            for p in _payg_provider_catalog(apps) if p.get("provider_id")
        },
    }


async def build_user_center(uid: int, days: int = 1) -> dict:
    """云端用户中心聚合：资料、账户、用量、流水、结算。"""
    if days not in (1, 7, 30):
        days = 1
    user = await db.get_user_by_id(uid) or {}
    billing = await db.get_user_billing(uid)
    accounts = await build_user_accounts_view(billing)
    inventory = await db.get_user_inventory_stats(uid, days)
    transactions = await db.get_transactions(uid, limit=20)
    settlements = await db.get_settlements(uid, limit=20)
    return {
        "profile": {
            "id": user.get("id"),
            "email": user.get("email"),
            "nickname": user.get("nickname"),
            "credits_balance": user.get("credits_balance", 0),
            "credits_earned": user.get("credits_earned", 0),
            "credits_spent": user.get("credits_spent", 0),
            "referral_code": user.get("referral_code"),
        },
        "accounts": accounts,
        "usage": {**inventory, "days": days},
        "transactions": transactions,
        "settlements": settlements,
    }

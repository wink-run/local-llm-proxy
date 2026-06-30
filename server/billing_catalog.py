"""云端个人页：从 config.apps 构建订阅/按量目录，与 user billing_json 合并返回。"""

from __future__ import annotations

import yaml

import database as db
from config_merge import _default_apps_doc, merge_apps_doc


def _norm_plan(raw: dict | None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    pid = str(raw.get("id") or "").strip()
    if not pid:
        return None
    label = str(raw.get("label") or pid).strip()
    monthly = raw.get("monthly_usd")
    if monthly is not None:
        try:
            monthly = float(monthly)
        except (TypeError, ValueError):
            monthly = None
    return {"id": pid, "label": label, "monthly_usd": monthly}


def _norm_payg_entry(raw: dict) -> dict:
    pid = raw.get("id") or raw.get("provider_id") or ""
    pricing = raw.get("pricing") if isinstance(raw.get("pricing"), dict) else {}
    models = list(raw.get("models") or [])
    return {
        "id": pid,
        "provider_id": pid,
        "label": raw.get("label") or pid,
        "icon": raw.get("icon") or "🔧",
        "aliases": list(raw.get("aliases") or []),
        "models": models,
        "pricing": pricing,
    }


async def load_merged_apps_doc() -> dict:
    """读取 DB config.apps 并与内置默认合并。"""
    content = await db.get_config("config.apps", "")
    defaults = _default_apps_doc()
    if not (content or "").strip():
        return dict(defaults)
    parsed = yaml.safe_load(content) or {}
    doc = merge_apps_doc(parsed if isinstance(parsed, dict) else {})
    # 目录段以默认 yaml 为底，管理员配置可覆盖
    for key in ("subscription_plans", "payg_providers"):
        if not defaults.get(key):
            continue
        if key == "subscription_plans":
            if key not in doc or not isinstance(doc.get(key), dict):
                doc[key] = dict(defaults[key])
            else:
                doc[key] = {**defaults[key], **doc[key]}
        elif key == "payg_providers":
            if not doc.get(key):
                doc[key] = list(defaults[key])
    return doc


def _subscription_plans(apps_doc: dict, user_billing: dict) -> dict:
    yaml_plans = apps_doc.get("subscription_plans") if isinstance(apps_doc.get("subscription_plans"), dict) else {}
    user_plans = user_billing.get("subscription_plans") if isinstance(user_billing.get("subscription_plans"), dict) else {}
    ids = set(yaml_plans.keys()) | set(user_plans.keys())
    out: dict = {}
    for pid in ids:
        raw = user_plans.get(pid) if pid in user_plans else yaml_plans.get(pid, [])
        out[pid] = [_norm_plan(p) for p in (raw or []) if _norm_plan(p)]
    return out


def _yaml_provider_pricing(apps_doc: dict) -> dict:
    out: dict = {}
    for raw in apps_doc.get("payg_providers") or []:
        if not isinstance(raw, dict):
            continue
        norm = _norm_payg_entry(raw)
        pid = norm["provider_id"]
        if pid and norm["pricing"]:
            out[pid] = norm["pricing"]
    return out


def _merge_provider_pricing(apps_doc: dict, user_billing: dict) -> dict:
    yaml = _yaml_provider_pricing(apps_doc)
    overrides = user_billing.get("provider_pricing_overrides") or {}
    ids = set(yaml.keys()) | set(overrides.keys())
    merged: dict = {}
    for pid in ids:
        merged[pid] = {**(yaml.get(pid) or {})}
        for model, rates in (overrides.get(pid) or {}).items():
            if model == "_excluded_models":
                continue
            if not isinstance(rates, dict):
                continue
            merged[pid][model] = {**(merged[pid].get(model) or {}), **rates}
    return merged


def _subscription_app_catalog(apps_doc: dict, plans: dict) -> list:
    out = []
    for a in apps_doc.get("subscription_apps") or []:
        if not isinstance(a, dict):
            continue
        plan_key = a.get("plan_provider_id") or a.get("provider_id")
        app_plans = []
        if isinstance(a.get("plans"), list) and a["plans"]:
            app_plans = [_norm_plan(p) for p in a["plans"] if _norm_plan(p)]
        elif plan_key and plans.get(plan_key):
            app_plans = plans[plan_key]
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


def _api_subscription_catalog(apps_doc: dict, plans: dict) -> list:
    out = []
    for a in apps_doc.get("api_subscription_apps") or []:
        if not isinstance(a, dict):
            continue
        plan_key = a.get("plan_provider_id")
        app_plans = []
        if isinstance(a.get("plans"), list) and a["plans"]:
            app_plans = [_norm_plan(p) for p in a["plans"] if _norm_plan(p)]
        elif plan_key and plans.get(plan_key):
            app_plans = plans[plan_key]
        out.append({
            "source_id": a.get("source_id") or a.get("id"),
            "plan_provider_id": plan_key,
            "app_name": a.get("app_name") or a.get("name") or a.get("source_id"),
            "app_icon": a.get("app_icon") or a.get("icon") or "🔑",
            "plans": app_plans,
        })
    return out


def _payg_provider_catalog(apps_doc: dict) -> list:
    return [_norm_payg_entry(p) for p in (apps_doc.get("payg_providers") or []) if isinstance(p, dict)]


def _provider_labels(catalog: list) -> dict:
    labels: dict = {}
    for p in catalog:
        pid = p.get("provider_id") or p.get("id")
        if pid:
            labels[pid] = p.get("label") or pid
    return labels


async def build_user_accounts_snapshot(user_billing: dict) -> dict:
    """与客户端 getUserAccounts 字段对齐，供云端用户中心使用。"""
    apps_doc = await load_merged_apps_doc()
    plans = _subscription_plans(apps_doc, user_billing)
    payg_catalog = _payg_provider_catalog(apps_doc)
    provider_pricing = _merge_provider_pricing(apps_doc, user_billing)
    return {
        "subscription_catalog": _subscription_app_catalog(apps_doc, plans),
        "api_subscription_catalog": _api_subscription_catalog(apps_doc, plans),
        "payg_provider_catalog": payg_catalog,
        "user_subscriptions": list(user_billing.get("user_subscriptions") or []),
        "user_payg_providers": list(user_billing.get("user_payg_providers") or []),
        "subscription_plans": plans,
        "provider_pricing": provider_pricing,
        "provider_pricing_overrides": user_billing.get("provider_pricing_overrides") or {},
        "provider_labels": _provider_labels(payg_catalog),
    }

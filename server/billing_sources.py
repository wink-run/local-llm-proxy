"""个人源目录 — 统一表单 schema，编译为 config.sources / providers.registry 下发（与应用清单分离）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

import database as db
from config_merge import _default_sources_doc
from provider_registry import serialize_registry_doc

CONFIG_KEY = "config.billing_sources"
_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_REGISTRY_DEFAULT = _DEFAULTS_DIR / "providers.registry.yaml"

CATEGORIES = ("payg", "app_sub", "api_sub")
TIERS = ("free", "paid", "p2p")
AUTH_METHODS = ("api_key", "oauth")
API_FORMATS = ("openai", "anthropic", "gemini")
MODALITIES = ("chat", "image", "embedding")
HANDLERS = ("local", "openai", "anthropic", "gemini", "p2p", "agnes-image")


def _registry_default_doc() -> dict:
    if not _REGISTRY_DEFAULT.is_file():
        return {}
    return yaml.safe_load(_REGISTRY_DEFAULT.read_text(encoding="utf-8")) or {}


def _parse_json_or_yaml(text: str) -> dict:
    text = (text or "").strip()
    if not text:
        return {}
    try:
        parsed = yaml.safe_load(text)
        if isinstance(parsed, dict):
            return parsed
    except yaml.YAMLError:
        pass
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return {}


def _norm_model(m: Any) -> dict | None:
    if isinstance(m, str) and m.strip():
        return {"id": m.strip(), "modality": "chat", "pricing": {}}
    if not isinstance(m, dict):
        return None
    mid = str(m.get("id") or m.get("name") or m.get("model") or "").strip()
    if not mid:
        return None
    modality = str(m.get("modality") or m.get("type") or "chat").strip().lower()
    if modality not in MODALITIES:
        modality = "chat"
    pricing = {}
    raw_p = m.get("pricing")
    if isinstance(raw_p, dict):
        pricing = {k: raw_p[k] for k in ("in", "out", "cacheRead", "cacheWrite") if raw_p.get(k) is not None}
    else:
        for k in ("in", "out", "cacheRead", "cacheWrite"):
            if m.get(k) is not None:
                pricing[k] = m[k]
    return {"id": mid, "modality": modality, "pricing": pricing}


def _norm_plan(p: Any) -> dict | None:
    if not isinstance(p, dict):
        return None
    pid = str(p.get("id") or "").strip()
    if not pid:
        return None
    monthly = p.get("monthly_usd")
    if monthly is not None and monthly != "":
        try:
            monthly = float(monthly)
        except (TypeError, ValueError):
            monthly = None
    else:
        monthly = None
    return {
        "id": pid,
        "label": str(p.get("label") or pid),
        "monthly_usd": monthly,
    }


def normalize_source(raw: dict) -> dict:
    """表单 → 规范化个人源条目。"""
    p = raw if isinstance(raw, dict) else {}
    cat = str(p.get("category") or "payg").strip()
    if cat not in CATEGORIES:
        cat = "payg"
    sid = str(p.get("id") or p.get("source_id") or "").strip()
    source_id = str(p.get("source_id") or sid).strip()

    models: list[dict] = []
    pricing_flat: dict[str, dict] = {}
    for m in p.get("models") or []:
        nm = _norm_model(m)
        if nm:
            models.append(nm)
            if nm["pricing"]:
                pricing_flat[nm["id"]] = dict(nm["pricing"])

    # 兼容旧 pricing 段
    if isinstance(p.get("pricing"), dict):
        for mid, rates in p["pricing"].items():
            if isinstance(rates, dict):
                pricing_flat[str(mid)] = {**(pricing_flat.get(str(mid)) or {}), **rates}
                if not any(x["id"] == str(mid) for x in models):
                    models.append({"id": str(mid), "modality": "chat", "pricing": dict(rates)})

    plans = [_norm_plan(x) for x in (p.get("plans") or [])]
    plans = [x for x in plans if x]

    key_prefix: list[str] = []
    raw_kp = p.get("key_prefix")
    if isinstance(raw_kp, list):
        key_prefix = [str(x).strip() for x in raw_kp if str(x).strip()]
    elif isinstance(raw_kp, str) and raw_kp.strip():
        key_prefix = [x.strip() for x in raw_kp.split(",") if x.strip()]

    aliases: list[str] = []
    raw_al = p.get("aliases")
    if isinstance(raw_al, list):
        aliases = [str(x).strip() for x in raw_al if str(x).strip()]

    auth = str(p.get("auth") or "api_key").strip()
    if auth not in AUTH_METHODS:
        auth = "oauth" if p.get("oauth") else "api_key"

    tier = str(p.get("tier") or "paid").strip()
    if tier not in TIERS:
        tier = "paid"

    api_format = str(p.get("api_format") or "openai").strip()
    if api_format not in API_FORMATS:
        api_format = "openai"

    handler = str(p.get("handler") or "openai").strip()
    if handler not in HANDLERS:
        handler = "openai"

    out: dict[str, Any] = {
        "id": sid,
        "category": cat,
        "source_id": source_id,
        "label": str(p.get("label") or sid),
        "icon": str(p.get("icon") or "🔧"),
        "tier": tier,
        "base_url": str(p.get("base_url") or ""),
        "auth": auth,
        "api_format": api_format,
        "handler": handler,
        "hint": str(p.get("hint") or ""),
        "keyless": bool(p.get("keyless")),
        "key_prefix": key_prefix,
        "signup_url": str(p.get("signup_url") or ""),
        "aliases": aliases,
        "enabled_default": bool(p.get("enabled_default")),
        "models": models,
        "pricing": pricing_flat,
        "plans": plans,
        "agent_id": str(p.get("agent_id") or "").strip(),
        "plan_provider_id": p.get("plan_provider_id"),
        "subscription_to_api": bool(p.get("subscription_to_api")),
    }
    oauth = p.get("oauth")
    if isinstance(oauth, dict) and oauth.get("provider"):
        out["oauth"] = {
            "provider": str(oauth["provider"]),
            "label": str(oauth.get("label") or oauth["provider"]),
        }
        out["auth"] = "oauth"
    return out


def validate_source(p: dict, *, require_id: bool = True) -> None:
    from fastapi import HTTPException

    if require_id and not str(p.get("id") or "").strip():
        raise HTTPException(400, "id 不能为空")
    cat = p.get("category") or "payg"
    if cat not in CATEGORIES:
        raise HTTPException(400, f"category 必须是 {', '.join(CATEGORIES)} 之一")
    if p.get("tier") not in TIERS:
        raise HTTPException(400, f"tier 必须是 {', '.join(TIERS)} 之一")
    if p.get("auth") not in AUTH_METHODS:
        raise HTTPException(400, f"auth 必须是 {', '.join(AUTH_METHODS)} 之一")
    if p.get("api_format") not in API_FORMATS:
        raise HTTPException(400, f"api_format 必须是 {', '.join(API_FORMATS)} 之一")


def _models_to_registry(models: list[dict]) -> list:
    out = []
    for m in models:
        entry: dict[str, Any] = {"name": m["id"], "type": m.get("modality") or "chat"}
        out.append(entry)
    return out


def _models_to_payg_names(models: list[dict]) -> list[str]:
    return [m["id"] for m in models if m.get("id")]


def _pricing_from_models(models: list[dict], extra: dict | None = None) -> dict:
    out = dict(extra or {})
    for m in models:
        if m.get("pricing"):
            out[m["id"]] = dict(m["pricing"])
    return out


def compile_billing_sections(sources: list[dict]) -> dict:
    """编译为 config.apps 中的计费四段。"""
    subscription_apps: list[dict] = []
    api_subscription_apps: list[dict] = []
    subscription_plans: dict[str, list] = {}
    payg_providers: list[dict] = []

    for raw in sources:
        s = normalize_source(raw)
        cat = s["category"]
        if cat == "app_sub":
            subscription_apps.append({
                "source_id": s["source_id"] or s["id"],
                "agent_id": s.get("agent_id") or s["id"],
                "app_name": s["label"],
                "app_icon": s["icon"],
                "plan_provider_id": s.get("plan_provider_id"),
                "subscription_to_api": s.get("subscription_to_api") is True,
            })
            ppid = s.get("plan_provider_id")
            if ppid and s.get("plans"):
                subscription_plans[ppid] = [
                    {"id": pl["id"], "label": pl["label"], "monthly_usd": pl.get("monthly_usd")}
                    for pl in s["plans"]
                ]
        elif cat == "api_sub":
            pid = s.get("plan_provider_id") or s["id"]
            api_subscription_apps.append({
                "source_id": s["source_id"] or s["id"],
                "app_name": s["label"],
                "app_icon": s["icon"],
                "plan_provider_id": pid,
            })
            if s.get("plans"):
                subscription_plans[pid] = [
                    {"id": pl["id"], "label": pl["label"], "monthly_usd": pl.get("monthly_usd")}
                    for pl in s["plans"]
                ]
        elif cat == "payg":
            pricing = _pricing_from_models(s.get("models") or [], s.get("pricing"))
            payg_providers.append({
                "id": s["id"],
                "label": s["label"],
                "icon": s["icon"],
                "aliases": s.get("aliases") or [],
                "models": _models_to_payg_names(s.get("models") or []),
                "pricing": pricing,
            })
            # 有套餐的按量源也写入 subscription_plans（如火山 API 订阅）
            if s.get("plans") and s.get("plan_provider_id"):
                subscription_plans[s["plan_provider_id"]] = [
                    {"id": pl["id"], "label": pl["label"], "monthly_usd": pl.get("monthly_usd")}
                    for pl in s["plans"]
                ]

    return {
        "subscription_apps": subscription_apps,
        "api_subscription_apps": api_subscription_apps,
        "subscription_plans": subscription_plans,
        "payg_providers": payg_providers,
    }


def compile_registry_providers(sources: list[dict]) -> list[dict]:
    """编译供给源 registry（网关 + catalog 用）。"""
    providers: list[dict] = []
    seen: set[str] = set()

    for raw in sources:
        s = normalize_source(raw)
        if s["category"] == "app_sub":
            continue  # APP 订阅无独立 base_url，不走 registry
        pid = s["id"]
        if not pid or pid in seen:
            continue
        seen.add(pid)

        modalities: dict[str, bool] = {"language": True}
        for m in s.get("models") or []:
            mod = m.get("modality") or "chat"
            if mod == "image":
                modalities["image"] = True
            elif mod == "embedding":
                modalities["embedding"] = True

        reg = {
            "id": pid,
            "label": s["label"],
            "icon": s["icon"],
            "tier": s["tier"],
            "hint": s.get("hint") or "",
            "base_url": s.get("base_url") or "",
            "modalities": modalities,
            "models": _models_to_registry(s.get("models") or []),
            "pricing": _pricing_from_models(s.get("models") or [], s.get("pricing")),
            "handler": s.get("handler") or "openai",
            "api_format": s.get("api_format") or "openai",
            "enabled_default": bool(s.get("enabled_default")),
            "keyless": bool(s.get("keyless")),
            "key_prefix": s.get("key_prefix") or [],
            "signup_url": s.get("signup_url") or "",
        }
        if s["category"] == "payg":
            reg["payg"] = True
        if s.get("aliases"):
            reg["aliases"] = list(s["aliases"])
        if s.get("oauth"):
            reg["oauth"] = dict(s["oauth"])
        providers.append(reg)

    return providers


def import_from_legacy(apps_doc: dict | None = None, registry_doc: dict | None = None) -> list[dict]:
    """从 legacy apps + registry 导入为统一 sources。"""
    apps = apps_doc if isinstance(apps_doc, dict) else _default_sources_doc()
    registry = registry_doc if isinstance(registry_doc, dict) else _registry_default_doc()
    reg_by_id = {p["id"]: p for p in (registry.get("providers") or []) if p.get("id")}
    payg_by_id = {p["id"]: p for p in (apps.get("payg_providers") or []) if p.get("id")}
    plans = apps.get("subscription_plans") if isinstance(apps.get("subscription_plans"), dict) else {}
    sources: list[dict] = []
    seen: set[str] = set()

    def _models_from_reg_and_payg(rid: str) -> list[dict]:
        reg = reg_by_id.get(rid) or {}
        payg = payg_by_id.get(rid) or {}
        pricing = {**(reg.get("pricing") or {}), **(payg.get("pricing") or {})}
        models: list[dict] = []
        for m in reg.get("models") or payg.get("models") or []:
            nm = _norm_model(m)
            if nm:
                nm["pricing"] = {**(pricing.get(nm["id"]) or {}), **(nm.get("pricing") or {})}
                models.append(nm)
        for mid, rates in pricing.items():
            if not any(x["id"] == mid for x in models):
                models.append({"id": mid, "modality": "chat", "pricing": dict(rates)})
        return models

    for app in apps.get("subscription_apps") or []:
        if not isinstance(app, dict):
            continue
        sid = app.get("source_id") or app.get("agent_id")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        ppid = app.get("plan_provider_id")
        reg = reg_by_id.get(ppid) if ppid else {}
        reg = reg or {}
        sources.append(normalize_source({
            "id": sid,
            "category": "app_sub",
            "source_id": sid,
            "agent_id": app.get("agent_id") or sid,
            "label": app.get("app_name") or sid,
            "icon": app.get("app_icon") or "🔧",
            "tier": "paid",
            "plan_provider_id": ppid,
            "subscription_to_api": app.get("subscription_to_api") is True,
            "auth": "oauth" if app.get("subscription_to_api") else "api_key",
            "base_url": reg.get("base_url") or "",
            "api_format": reg.get("api_format") or "openai",
            "oauth": reg.get("oauth"),
            # 关联套餐模板（个人页选套餐用）
            "plans": plans.get(ppid) or [] if ppid else [],
        }))

    for app in apps.get("api_subscription_apps") or []:
        if not isinstance(app, dict):
            continue
        sid = app.get("source_id")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        ppid = app.get("plan_provider_id") or sid
        sources.append(normalize_source({
            "id": sid,
            "category": "api_sub",
            "source_id": sid,
            "label": app.get("app_name") or sid,
            "icon": app.get("app_icon") or "🔧",
            "tier": "paid",
            "plan_provider_id": ppid,
            "auth": "api_key",
            "plans": plans.get(ppid) or [],
        }))

    for payg in apps.get("payg_providers") or []:
        if not isinstance(payg, dict):
            continue
        pid = payg.get("id")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        reg = reg_by_id.get(pid) or {}
        sources.append(normalize_source({
            "id": pid,
            "category": "payg",
            "label": payg.get("label") or reg.get("label") or pid,
            "icon": payg.get("icon") or reg.get("icon") or "🔧",
            "tier": reg.get("tier") or "paid",
            "base_url": reg.get("base_url") or "",
            "auth": "oauth" if reg.get("oauth") else "api_key",
            "api_format": reg.get("api_format") or "openai",
            "handler": reg.get("handler") or "openai",
            "hint": reg.get("hint") or "",
            "key_prefix": reg.get("key_prefix") or [],
            "signup_url": reg.get("signup_url") or "",
            "aliases": payg.get("aliases") or reg.get("aliases") or [],
            "oauth": reg.get("oauth"),
            "keyless": reg.get("keyless"),
            "enabled_default": reg.get("enabled_default"),
            "models": _models_from_reg_and_payg(pid),
            "pricing": payg.get("pricing") or reg.get("pricing") or {},
        }))

    # registry 中未出现在 payg 的免费/网关源
    for reg in registry.get("providers") or []:
        pid = reg.get("id")
        if not pid or pid in seen:
            continue
        if reg.get("tier") == "p2p":
            sources.append(normalize_source({
                **reg,
                "category": "payg",
                "auth": "api_key",
                "models": _models_from_reg_and_payg(pid),
            }))
            seen.add(pid)
            continue
        if not reg.get("payg") and reg.get("tier") == "free":
            sources.append(normalize_source({
                **reg,
                "category": "payg",
                "auth": "oauth" if reg.get("oauth") else "api_key",
                "models": _models_from_reg_and_payg(pid),
            }))
            seen.add(pid)

    return sources


async def load_sources_doc() -> dict:
    raw = await db.get_config(CONFIG_KEY, "")
    if raw.strip():
        doc = _parse_json_or_yaml(raw)
        if doc.get("sources"):
            return {"version": doc.get("version") or 1, "sources": doc["sources"]}
    # 首次：从 legacy 默认导入
    sources = import_from_legacy()
    return {"version": 1, "sources": sources}


def load_sources_doc_sync() -> dict:
    return {"version": 1, "sources": import_from_legacy()}


async def save_sources_doc(doc: dict) -> None:
    payload = {
        "version": doc.get("version") or 1,
        "sources": [normalize_source(s) for s in (doc.get("sources") or []) if s.get("id")],
    }
    await db.set_config(CONFIG_KEY, json.dumps(payload, ensure_ascii=False, indent=2))


async def publish_sources(doc: dict | None = None) -> dict:
    """编译并写入独立的 config.sources（仅 4 计费段）+ config.providers。
    不再触碰 config.apps —— 应用清单（tools/api_key_apps）与源彻底分离。"""
    if doc is None:
        doc = await load_sources_doc()
    sources = doc.get("sources") or []
    billing = compile_billing_sections(sources)
    registry_providers = compile_registry_providers(sources)

    # 写入独立源下发文件 config.sources（应用清单 config.apps 不受影响）
    sources_doc: dict = {"version": 1}
    for key in ("subscription_apps", "api_subscription_apps", "subscription_plans", "payg_providers"):
        sources_doc[key] = billing[key]
    sources_yaml = yaml.dump(
        sources_doc, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    await db.set_config("config.sources", sources_yaml)

    reg_doc = {"version": 1, "providers": registry_providers}
    await db.set_config("config.providers", serialize_registry_doc(reg_doc))

    return {
        "sources_bytes": len(sources_yaml),
        "apps_bytes": len(sources_yaml),   # 向后兼容旧 admin 前端字段名
        "registry_count": len(registry_providers),
        "sources_count": len(sources),
    }


def list_sources_normalized(doc: dict | None = None) -> list[dict]:
    if doc is None:
        doc = load_sources_doc_sync()
    return [normalize_source(s) for s in (doc.get("sources") or []) if s.get("id")]

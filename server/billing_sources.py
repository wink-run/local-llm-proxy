"""个人源目录 — 统一表单 schema，编译为 config.providers（providers.registry.yaml）下发。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

import database as db
from provider_registry import serialize_registry_doc, sync_catalog_models_pricing

CONFIG_KEY = "config.billing_sources"
PROVIDERS_CONFIG_KEY = "config.providers"
_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_REGISTRY_DEFAULT = _DEFAULTS_DIR / "providers.registry.yaml"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_CLIENT_CONFIG = _REPO_ROOT / "client" / "electron" / "config"
_CLIENT_REGISTRY = _CLIENT_CONFIG / "providers.registry.yaml"
_BILLING_KEYS = ("subscription_apps", "api_subscription_apps", "subscription_plans", "payg_providers")

CATEGORIES = ("payg", "app_sub", "api_sub")
TIERS = ("free", "paid", "p2p")
AUTH_METHODS = ("api_key", "oauth")
API_FORMATS = ("openai", "anthropic", "gemini")
MODALITIES = ("chat", "vision", "image", "embedding")
HANDLERS = ("local", "openai", "anthropic", "gemini", "p2p", "agnes-image", "jimeng-api")


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
        pricing = {k: raw_p[k] for k in ("in", "out", "cacheRead", "cacheWrite", "image") if raw_p.get(k) is not None}
    else:
        for k in ("in", "out", "cacheRead", "cacheWrite", "image"):
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


def _sort_key(s: dict) -> int:
    """仅按序号排序；同序号保持稳定顺序（即 JSON 中的自然顺序）。"""
    try:
        return int(s.get("sort_order") or 0)
    except (TypeError, ValueError):
        return 0


def sort_sources(sources: list[dict]) -> list[dict]:
    return sorted(sources, key=_sort_key)


def renumber_sources(sources: list[dict]) -> list[dict]:
    """排序后重排为连续自然序号 1, 2, 3…"""
    out: list[dict] = []
    for i, raw in enumerate(sort_sources(sources), 1):
        s = normalize_source(raw)
        s["sort_order"] = i
        out.append(s)
    return out


def _parse_sort_order(raw: Any) -> int:
    if raw is None or raw == "":
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


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
        "sort_order": _parse_sort_order(p.get("sort_order")),
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
    # 纯 APP 订阅（不可转 API）不下发模型；API 订阅与可转 API 的 APP 订阅保留 base_url / 模型刊例
    sub_to_api = out["subscription_to_api"]
    if cat == "app_sub" and not sub_to_api:
        out["models"] = []
        out["pricing"] = {}
    if cat == "app_sub" and not out["agent_id"]:
        out["agent_id"] = sid
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
    """每个模型都写入 pricing 键（含空 {}），避免 registry 模型数与刊例价键不一致。"""
    out = dict(extra or {})
    for m in models:
        mid = str(m.get("id") or "").strip()
        if not mid:
            continue
        out[mid] = dict(m.get("pricing") or {})
    return out


def compile_billing_sections(sources: list[dict]) -> dict:
    """编译为 config.apps 中的计费四段。"""
    subscription_apps: list[dict] = []
    api_subscription_apps: list[dict] = []
    subscription_plans: dict[str, list] = {}
    payg_providers: list[dict] = []

    for raw in sort_sources(sources):
        s = normalize_source(raw)
        cat = s["category"]
        if cat == "app_sub":
            app_entry: dict[str, Any] = {
                "source_id": s["source_id"] or s["id"],
                "agent_id": s.get("agent_id") or s["id"],
                "app_name": s["label"],
                "app_icon": s["icon"],
                "plan_provider_id": s.get("plan_provider_id"),
                "subscription_to_api": s.get("subscription_to_api") is True,
            }
            # 可转 API：下发默认模型与刊例（客户端 fillSub / 供给源页展示）
            if s.get("subscription_to_api"):
                model_names = _models_to_payg_names(s.get("models") or [])
                pricing = _pricing_from_models(s.get("models") or [], s.get("pricing"))
                if model_names:
                    app_entry["models"] = model_names
                if pricing:
                    app_entry["pricing"] = pricing
            subscription_apps.append(app_entry)
            ppid = s.get("plan_provider_id")
            plan_key = ppid or s.get("source_id") or s["id"]
            if plan_key and s.get("plans"):
                subscription_plans[plan_key] = [
                    {"id": pl["id"], "label": pl["label"], "monthly_usd": pl.get("monthly_usd")}
                    for pl in s["plans"]
                ]
        elif cat == "api_sub":
            pid = s.get("plan_provider_id") or s["id"]
            api_entry: dict[str, Any] = {
                "source_id": s["source_id"] or s["id"],
                "app_name": s["label"],
                "app_icon": s["icon"],
                "plan_provider_id": pid,
            }
            model_names = _models_to_payg_names(s.get("models") or [])
            pricing = _pricing_from_models(s.get("models") or [], s.get("pricing"))
            if model_names:
                api_entry["models"] = model_names
            if pricing:
                api_entry["pricing"] = pricing
            api_subscription_apps.append(api_entry)
            plan_key = s.get("plan_provider_id") or s.get("source_id") or s["id"]
            if plan_key and s.get("plans"):
                subscription_plans[plan_key] = [
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


def _registry_modalities(models: list[dict]) -> dict[str, bool]:
    modalities: dict[str, bool] = {"language": True}
    for m in models or []:
        mod = m.get("modality") or m.get("type") or "chat"
        if mod == "image":
            modalities["image"] = True
        elif mod == "embedding":
            modalities["embedding"] = True
        elif mod == "vision":
            modalities["vision"] = True
    return modalities


def _build_registry_entry(s: dict, pid: str) -> dict:
    models = s.get("models") or []
    reg: dict[str, Any] = {
        "id": pid,
        "label": s["label"],
        "icon": s["icon"],
        "tier": s["tier"],
        "hint": s.get("hint") or "",
        "base_url": s.get("base_url") or "",
        "modalities": _registry_modalities(models),
        "models": _models_to_registry(models),
        "pricing": _pricing_from_models(models, s.get("pricing")),
        "handler": s.get("handler") or "openai",
        "api_format": s.get("api_format") or "openai",
        "enabled_default": bool(s.get("enabled_default")),
        "keyless": bool(s.get("keyless")),
        "key_prefix": s.get("key_prefix") or [],
        "signup_url": s.get("signup_url") or "",
    }
    if s.get("aliases"):
        reg["aliases"] = list(s["aliases"])
    if s.get("oauth"):
        reg["oauth"] = dict(s["oauth"])
    synced_models, synced_pricing = sync_catalog_models_pricing(reg["models"], reg["pricing"])
    reg["models"] = synced_models
    reg["pricing"] = synced_pricing
    return reg


def _merge_registry_entry(existing: dict, incoming: dict) -> None:
    """同 plan_provider_id 的 payg 与可转 API 订阅条目合并。"""
    if incoming.get("oauth"):
        existing["oauth"] = incoming["oauth"]
    if incoming.get("base_url"):
        existing["base_url"] = incoming["base_url"]
    if incoming.get("models"):
        existing["models"] = incoming["models"]
        existing["modalities"] = incoming.get("modalities") or existing.get("modalities")
    if incoming.get("pricing"):
        existing["pricing"] = {**(existing.get("pricing") or {}), **incoming["pricing"]}
    for k in ("handler", "api_format", "hint", "signup_url", "keyless", "key_prefix", "aliases"):
        if incoming.get(k) not in (None, "", [], False):
            existing[k] = incoming[k]


def compile_registry_providers(sources: list[dict]) -> list[dict]:
    """编译供给源 registry（网关 + catalog 用）。"""
    by_id: dict[str, dict] = {}

    for raw in sort_sources(sources):
        s = normalize_source(raw)
        cat = s["category"]
        if cat == "app_sub":
            if not s.get("subscription_to_api"):
                continue  # 纯直连订阅不走 registry
            pid = str(s.get("plan_provider_id") or s["id"]).strip()
        elif cat == "api_sub":
            pid = str(s.get("plan_provider_id") or s["id"]).strip()
        else:
            pid = str(s["id"]).strip()
        if not pid:
            continue

        reg = _build_registry_entry(s, pid)
        if cat == "payg":
            reg["payg"] = True
        if cat == "app_sub" and s.get("subscription_to_api"):
            reg["keyless"] = True

        if pid in by_id:
            _merge_registry_entry(by_id[pid], reg)
        else:
            by_id[pid] = reg

    return list(by_id.values())


def _models_from_legacy_entry(entry: dict) -> tuple[list[dict], dict]:
    """旧四段 YAML 条目 → models + pricing。"""
    pricing = dict(entry.get("pricing") or {})
    models: list[dict] = []
    for m in entry.get("models") or []:
        if isinstance(m, str) and m.strip():
            mid = m.strip()
            models.append({"id": mid, "modality": "chat", "pricing": dict(pricing.get(mid) or {})})
        elif isinstance(m, dict):
            nm = _norm_model(m)
            if nm:
                models.append(nm)
                if nm["pricing"]:
                    pricing[nm["id"]] = dict(nm["pricing"])
    for mid, rates in pricing.items():
        if isinstance(rates, dict) and not any(x["id"] == str(mid) for x in models):
            models.append({"id": str(mid), "modality": "chat", "pricing": dict(rates)})
    return models, pricing


def import_from_billing_sections_doc(doc: dict) -> list[dict]:
    """从旧 config.sources 四段 YAML 合成 billing_sources（仅 DB 迁移用）。"""
    if not isinstance(doc, dict):
        return []
    plans_map = doc.get("subscription_plans") or {}
    raw_sources: list[dict] = []
    order = 0

    for a in doc.get("subscription_apps") or []:
        if not isinstance(a, dict):
            continue
        key = str(a.get("source_id") or a.get("id") or a.get("agent_id") or "").strip()
        if not key:
            continue
        ppid = a.get("plan_provider_id")
        models, pricing = _models_from_legacy_entry(a)
        raw_sources.append({
            "sort_order": order + 1,
            "id": key,
            "category": "app_sub",
            "source_id": key,
            "agent_id": a.get("agent_id") or key,
            "label": a.get("app_name") or key,
            "icon": a.get("app_icon") or "🔧",
            "plan_provider_id": ppid,
            "subscription_to_api": a.get("subscription_to_api") is True,
            "plans": plans_map.get(ppid or key) or [],
            "models": models,
            "pricing": pricing,
        })
        order += 1

    for a in doc.get("api_subscription_apps") or []:
        if not isinstance(a, dict):
            continue
        key = str(a.get("source_id") or a.get("id") or "").strip()
        if not key:
            continue
        ppid = a.get("plan_provider_id") or key
        models, pricing = _models_from_legacy_entry(a)
        raw_sources.append({
            "sort_order": order + 1,
            "id": key,
            "category": "api_sub",
            "source_id": key,
            "label": a.get("app_name") or key,
            "icon": a.get("app_icon") or "🔧",
            "plan_provider_id": ppid,
            "plans": plans_map.get(ppid) or [],
            "models": models,
            "pricing": pricing,
        })
        order += 1

    for p in doc.get("payg_providers") or []:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or p.get("provider_id") or "").strip()
        if not pid:
            continue
        models, pricing = _models_from_legacy_entry(p)
        raw_sources.append({
            "sort_order": order + 1,
            "id": pid,
            "category": "payg",
            "label": p.get("label") or pid,
            "icon": p.get("icon") or "🔧",
            "aliases": p.get("aliases") or [],
            "models": models,
            "pricing": pricing,
        })
        order += 1

    return sort_sources([normalize_source(s) for s in raw_sources if s.get("id")])


def import_from_legacy(apps_doc: dict | None = None, registry_doc: dict | None = None) -> list[dict]:
    """从 providers.registry 的 billing_sources 读取（唯一默认数据源）。"""
    registry = registry_doc if isinstance(registry_doc, dict) else _registry_default_doc()
    bs = registry.get("billing_sources")
    if isinstance(bs, list) and bs:
        return sort_sources([normalize_source(s) for s in bs if s.get("id")])
    # DB 迁移：旧 config.sources / config.apps 四段
    if isinstance(apps_doc, dict):
        legacy = import_from_billing_sections_doc(apps_doc)
        if legacy:
            return legacy
    return []


async def load_sources_doc() -> dict:
    """从 DB 读取个人源目录；未导入前回退 config.providers.billing_sources。"""
    raw = await db.get_config(CONFIG_KEY, "")
    if raw.strip():
        doc = _parse_json_or_yaml(raw)
        if "sources" in doc:
            return {"version": doc.get("version") or 1, "sources": doc.get("sources") or []}
    prov_raw = await db.get_config(PROVIDERS_CONFIG_KEY, "")
    if prov_raw.strip():
        prov = _parse_json_or_yaml(prov_raw)
        bs = prov.get("billing_sources")
        if isinstance(bs, list) and bs:
            return {"version": prov.get("version") or 1, "sources": list(bs)}
    return {"version": 1, "sources": []}


def load_sources_doc_sync() -> dict:
    """同步读取 DB（list_sources_normalized 无 doc 时的兜底）。"""
    import psycopg2
    from db_pool import get_database_url

    try:
        with psycopg2.connect(get_database_url()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT value FROM system_config WHERE key=%s", (CONFIG_KEY,),
                )
                row = cur.fetchone()
                if row and row[0] and str(row[0]).strip():
                    doc = _parse_json_or_yaml(str(row[0]))
                    if "sources" in doc:
                        return {"version": doc.get("version") or 1, "sources": doc.get("sources") or []}
                cur.execute(
                    "SELECT value FROM system_config WHERE key=%s", (PROVIDERS_CONFIG_KEY,),
                )
                row2 = cur.fetchone()
                if row2 and row2[0] and str(row2[0]).strip():
                    prov = _parse_json_or_yaml(str(row2[0]))
                    bs = prov.get("billing_sources")
                    if isinstance(bs, list) and bs:
                        return {"version": prov.get("version") or 1, "sources": list(bs)}
    except Exception:
        pass
    return {"version": 1, "sources": []}


async def save_sources_doc(doc: dict) -> None:
    items = [normalize_source(s) for s in (doc.get("sources") or []) if s.get("id")]
    payload = {
        "version": doc.get("version") or 1,
        "sources": renumber_sources(items),
    }
    await db.set_config(CONFIG_KEY, json.dumps(payload, ensure_ascii=False, indent=2))


async def publish_sources(doc: dict | None = None) -> dict:
    """编译并写入 config.providers（providers.registry.yaml 为唯一下发格式）。"""
    if doc is None:
        doc = await load_sources_doc()
    sources = doc.get("sources") or []
    registry_providers = compile_registry_providers(sources)

    reg_doc = {
        "version": 1,
        "providers": registry_providers,
        "billing_sources": sort_sources([normalize_source(s) for s in sources]),
    }
    registry_yaml = serialize_registry_doc(reg_doc)
    await db.set_config("config.providers", registry_yaml)

    return {
        "registry_bytes": len(registry_yaml),
        "sources_bytes": len(registry_yaml),  # 向后兼容 admin 前端字段名
        "apps_bytes": len(registry_yaml),
        "registry_count": len(registry_providers),
        "sources_count": len(sources),
    }


def legacy_sources_yaml_from_billing_sources(sources: list[dict]) -> str:
    """[deprecated] 由 billing_sources 编译旧四段 YAML，供 GET /config/sources 兼容。"""
    billing = compile_billing_sections(sources)
    doc: dict = {"version": 1}
    for key in _BILLING_KEYS:
        doc[key] = billing[key]
    return yaml.dump(
        doc, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()


def _read_text_prefix_until(path: Path, marker: str) -> str:
    """保留默认文件头部注释/基础设施段，从 marker 起由导出内容替换。"""
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8")
    idx = text.find(marker)
    if idx < 0:
        return ""
    return text[:idx].rstrip() + "\n\n"


def _merge_registry_for_export(sources: list[dict]) -> list[dict]:
    """编译 registry，并保留默认文件中未纳入个人源表单的条目（如 Ollama、compatible 源）。"""
    compiled = compile_registry_providers(sources)
    by_id = {p["id"]: p for p in compiled if p.get("id")}
    if _REGISTRY_DEFAULT.is_file():
        existing = yaml.safe_load(_REGISTRY_DEFAULT.read_text(encoding="utf-8")) or {}
        for p in existing.get("providers") or []:
            pid = p.get("id")
            if pid and pid not in by_id:
                by_id[pid] = p
    # 保持原文件大致顺序：先已有顺序，再追加新编译项
    ordered: list[dict] = []
    seen: set[str] = set()
    if _REGISTRY_DEFAULT.is_file():
        existing = yaml.safe_load(_REGISTRY_DEFAULT.read_text(encoding="utf-8")) or {}
        for p in existing.get("providers") or []:
            pid = p.get("id")
            if pid and pid in by_id:
                ordered.append(by_id.pop(pid))
                seen.add(pid)
    for p in compiled:
        if p.get("id") and p["id"] not in seen:
            ordered.append(p)
            seen.add(p["id"])
    for p in by_id.values():
        if p.get("id") not in seen:
            ordered.append(p)
    return ordered


def _build_registry_default_yaml(sources: list[dict]) -> str:
    providers = _merge_registry_for_export(sources)
    doc = {
        "version": 1,
        "providers": providers,
        "billing_sources": sort_sources([normalize_source(s) for s in sources]),
    }
    prefix = _read_text_prefix_until(_REGISTRY_DEFAULT, "providers:")
    body = serialize_registry_doc(doc)
    if prefix:
        lines = body.splitlines()
        while lines and not lines[0].strip().startswith("providers:"):
            lines.pop(0)
        body = "\n".join(lines)
        if not body.endswith("\n"):
            body += "\n"
        return prefix + body
    return body


def _write_export_file(path: Path, content: str) -> dict:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        rel = path.relative_to(_REPO_ROOT) if path.is_relative_to(_REPO_ROOT) else path.name
        return {"path": str(rel), "bytes": len(content.encode("utf-8")), "ok": True}
    except OSError as e:
        rel = path.relative_to(_REPO_ROOT) if path.is_relative_to(_REPO_ROOT) else path.name
        return {"path": str(rel), "ok": False, "error": str(e)}


async def export_to_defaults(doc: dict | None = None) -> dict:
    """将当前个人源目录写入 providers.registry.yaml（服务端 + 客户端）。"""
    if doc is None:
        doc = await load_sources_doc()
    sources = doc.get("sources") or []
    if not sources:
        from fastapi import HTTPException
        raise HTTPException(400, "目录为空，无法导出")

    registry_yaml = _build_registry_default_yaml(sources)
    files = [
        _write_export_file(_REGISTRY_DEFAULT, registry_yaml),
        _write_export_file(_CLIENT_REGISTRY, registry_yaml),
    ]

    ok_count = sum(1 for f in files if f.get("ok"))
    return {
        "sources_count": len(sources),
        "files_written": ok_count,
        "files": files,
    }


def list_sources_normalized(doc: dict | None = None) -> list[dict]:
    if doc is None:
        doc = load_sources_doc_sync()
    items = [normalize_source(s) for s in (doc.get("sources") or []) if s.get("id")]
    return sort_sources(items)

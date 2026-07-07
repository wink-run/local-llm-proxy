"""应用 handler 注册表 — 客户端内置代理/会话逻辑，配置侧只需 handler + vars。"""

from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

_REPO_ROOT = Path(__file__).resolve().parent.parent
_HANDLERS_CLIENT = _REPO_ROOT / "client" / "electron" / "config" / "app-handlers.yaml"
_HANDLERS_SERVER = Path(__file__).resolve().parent / "static" / "defaults" / "app-handlers.yaml"
_SCANS_CLIENT = _REPO_ROOT / "client" / "electron" / "config" / "session-scans.yaml"
_SCANS_SERVER = Path(__file__).resolve().parent / "static" / "defaults" / "session-scans.yaml"

# 旧实体 id → handler（DB 迁移用）
_LEGACY_ID_TO_HANDLER: dict[str, str] = {
    "claude-code": "claude-code-cli",
    "codex": "codex-cli",
    "opencode": "opencode-cli",
    "hermes": "hermes-cli",
    "claude-desktop": "claude-desktop-api",
    "codex-desktop": "codex-desktop-api",
    "openclaw": "openclaw-api",
    "cursor": "cursor-stats",
    "copilot": "copilot-stats",
    "qwen-code": "qwen-stats",
    "antigravity": "antigravity-stats",
    "grok": "grok-stats",
    "workbuddy": "workbuddy-stats",
    "trae": "trae-work-stats",
    "trae-work": "trae-work-stats",
    "Trae": "trae-work-stats",
}


@lru_cache(maxsize=1)
def load_handlers_doc() -> dict:
    path = _HANDLERS_CLIENT if _HANDLERS_CLIENT.is_file() else _HANDLERS_SERVER
    if not path.is_file():
        return {"version": 1, "handlers": {}, "default_entities": []}
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    doc.setdefault("handlers", {})
    doc.setdefault("default_entities", [])
    return doc


def handlers_map() -> dict[str, dict]:
    return load_handlers_doc().get("handlers") or {}


@lru_cache(maxsize=1)
def load_session_scans_doc() -> dict:
    path = _SCANS_CLIENT if _SCANS_CLIENT.is_file() else _SCANS_SERVER
    if not path.is_file():
        return {"version": 1, "scans": {}}
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    doc.setdefault("scans", {})
    return doc


def session_scans_by_id() -> dict[str, dict]:
    return load_session_scans_doc().get("scans") or {}


def resolve_session_scan(
    session: dict | None,
    vars_: dict | None,
    handler_id: str,
    cloud_scans: dict[str, dict] | None = None,
) -> dict:
    """解析会话补录规则：vars.session_scan > handler.session.scan > scans[source_id]。"""
    v = vars_ if isinstance(vars_, dict) else {}
    if isinstance(v.get("session_scan"), dict):
        return dict(v["session_scan"])
    h = handlers_map().get(handler_id) or {}
    sess = session if isinstance(session, dict) else (h.get("session") if isinstance(h.get("session"), dict) else None)
    if isinstance(sess, dict) and isinstance(sess.get("scan"), dict):
        return dict(sess["scan"])
    sid = str(sess.get("source_id") or "").strip() if isinstance(sess, dict) else ""
    if sid:
        merged = {**session_scans_by_id(), **(cloud_scans or {})}
        return dict(merged.get(sid) or {})
    return {}


CAP_KEYS = ("gateway_proxy", "session_trace", "session_usage_import")


def _capability_items(h: dict) -> list[dict]:
    """管理后台：三项能力对所有 handler 均可勾选，由运营自主决定。"""
    catalog = load_handlers_doc().get("capability_catalog") or {}
    out: list[dict] = []
    for key in CAP_KEYS:
        meta = catalog.get(key) if isinstance(catalog.get(key), dict) else {}
        out.append({
            "id": key,
            "supported": True,
            "label_zh": meta.get("label_zh") or key,
            "label_en": meta.get("label_en") or key,
        })
    return out


def handler_max_capabilities(h: dict) -> dict[str, bool]:
    """运营可勾选任意能力；运行时能否生效由 handler 内置 proxy/session 决定。"""
    return {key: True for key in CAP_KEYS}


def default_user_capabilities(h: dict) -> dict[str, bool]:
    """未配置 vars.capabilities 时：按 handler.capabilities 字段给默认勾选建议。"""
    caps = set(h.get("capabilities") or [])
    return {
        "gateway_proxy": "gateway_proxy" in caps,
        "session_trace": "session_import" in caps or "session_trace" in caps,
        "session_usage_import": "session_import" in caps,
    }


def resolve_user_capabilities(h: dict, vars_: dict) -> dict[str, bool]:
    """以运营勾选为准（不再按 handler 基础设施裁剪）。"""
    defaults = default_user_capabilities(h)
    raw = vars_.get("capabilities") if isinstance(vars_.get("capabilities"), dict) else {}
    out: dict[str, bool] = {}
    for key in CAP_KEYS:
        if key in raw:
            out[key] = bool(raw[key])
        else:
            out[key] = defaults[key]
    return out


def handler_has_patch_route(hid: str) -> bool:
    h = handlers_map().get(hid) or {}
    proxy = h.get("proxy") if isinstance(h.get("proxy"), dict) else {}
    pr = proxy.get("patch_route") if isinstance(proxy.get("patch_route"), dict) else {}
    return bool(pr.get("strategy"))


def resolve_route_multi_select(h: dict, vars_: dict) -> bool:
    """vars.route_multi_select 覆盖 handler.patch_route.multi_select 默认。"""
    if "route_multi_select" in vars_:
        return bool(vars_["route_multi_select"])
    proxy = h.get("proxy") if isinstance(h.get("proxy"), dict) else {}
    pr = proxy.get("patch_route") if isinstance(proxy.get("patch_route"), dict) else {}
    return bool(pr.get("multi_select"))


def list_handlers_meta() -> list[dict]:
    """管理后台：handler 下拉列表。"""
    out: list[dict] = []
    for hid, h in sorted(handlers_map().items()):
        caps = h.get("capabilities") or []
        preview: dict[str, Any] = {}
        try:
            preview = expand_entity({"id": "_preview", "handler": hid})
        except ValueError:
            pass
        cap_items = _capability_items(h)
        default_caps = default_user_capabilities(h)
        proxy = h.get("proxy") if isinstance(h.get("proxy"), dict) else {}
        pr = proxy.get("patch_route") if isinstance(proxy.get("patch_route"), dict) else {}
        out.append({
            "id": hid,
            "label": h.get("label") or hid,
            "label_zh": h.get("label_zh") or h.get("label") or hid,
            "description": h.get("description") or "",
            "default_icon": h.get("default_icon") or "🔧",
            "default_name": h.get("default_name") or hid,
            "capabilities": caps,
            "capability_items": cap_items,
            "default_capabilities": default_caps,
            "gateway_proxy": "gateway_proxy" in caps,
            "session_import": "session_import" in caps,
            "proxy_mode": preview.get("proxy_mode"),
            "default_route_bindable": preview.get("route_bindable", True),
            "default_allow_direct": preview.get("allow_direct", False),
            "has_patch_route": bool(pr.get("strategy")),
            "default_route_multi_select": bool(pr.get("multi_select")),
        })
    return out


def default_entities_compact() -> list[dict]:
    """从 app-handlers.yaml 的 default_entities 生成紧凑实体列表。"""
    doc = load_handlers_doc()
    handlers = handlers_map()
    entities: list[dict] = []
    for i, row in enumerate(doc.get("default_entities") or []):
        if not isinstance(row, dict):
            continue
        eid = str(row.get("id") or "").strip()
        hid = str(row.get("handler") or "").strip()
        if not eid or not hid or hid not in handlers:
            continue
        h = handlers[hid]
        entities.append(normalize_compact_entity({
            "sort_order": row.get("sort_order") if row.get("sort_order") is not None else (i + 1) * 10,
            "id": eid,
            "handler": hid,
            "name": row.get("name") or h.get("default_name") or eid,
            "icon": row.get("icon") or h.get("default_icon") or "🔧",
            "vars": {
                **(row.get("vars") if isinstance(row.get("vars"), dict) else {}),
                "capabilities": (row.get("vars") or {}).get("capabilities")
                if isinstance((row.get("vars") or {}).get("capabilities"), dict)
                else default_user_capabilities(h),
            },
        }))
    return entities


def _norm_str_list(val: Any) -> list[str]:
    if isinstance(val, list):
        return [str(x).strip() for x in val if str(x).strip()]
    if isinstance(val, str) and val.strip():
        return [x.strip() for x in val.split(",") if x.strip()]
    return []


def _norm_vars(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for k, v in raw.items():
        key = str(k).strip()
        if not key:
            continue
        if key == "models":
            out[key] = _norm_str_list(v)
        else:
            out[key] = v
    return out


def normalize_compact_entity(raw: dict) -> dict:
    """紧凑存储格式：id + handler + vars。"""
    eid = str(raw.get("id") or "").strip()
    hid = str(raw.get("handler") or "").strip()
    h = handlers_map().get(hid) or {}
    return {
        "sort_order": int(raw.get("sort_order") or 0),
        "id": eid,
        "handler": hid,
        "name": str(raw.get("name") or h.get("default_name") or eid).strip(),
        "icon": str(raw.get("icon") or h.get("default_icon") or "🔧").strip(),
        "vars": _norm_vars(raw.get("vars")),
    }


def _apply_vars_to_proxy(proxy: dict, vars_: dict) -> dict:
    out = deepcopy(proxy)
    for key in ("route_bindable", "allow_direct"):
        if key in vars_:
            out[key] = bool(vars_[key])
    return out


def _apply_vars_to_session(session: dict, vars_: dict) -> dict:
    out = deepcopy(session)
    if "route_bindable" in vars_:
        out["route_bindable"] = bool(vars_["route_bindable"])
    if "models" in vars_ and vars_["models"]:
        out["models"] = _norm_str_list(vars_["models"])
    return out


def expand_entity(compact: dict) -> dict:
    """handler + vars → 完整实体（供 compile_apps_doc 使用）。"""
    c = normalize_compact_entity(compact)
    hid = c["handler"]
    h = handlers_map().get(hid)
    if not h:
        raise ValueError(f"未知 handler: {hid}")

    vars_ = c.get("vars") or {}
    proxy = h.get("proxy") if isinstance(h.get("proxy"), dict) else None
    session = h.get("session") if isinstance(h.get("session"), dict) else None

    user_caps = resolve_user_capabilities(h, vars_)
    gateway_proxy = user_caps["gateway_proxy"] and bool(proxy)
    session_trace = user_caps["session_trace"] and bool(session)
    session_usage_import = user_caps["session_usage_import"] and bool(session)
    session_import = session_trace or session_usage_import

    entity: dict[str, Any] = {
        "sort_order": c.get("sort_order") or 0,
        "id": c["id"],
        "name": vars_.get("name") or c.get("name") or h.get("default_name") or c["id"],
        "icon": vars_.get("icon") or c.get("icon") or h.get("default_icon") or "🔧",
        "handler": hid,
        "vars": vars_,
        "capabilities": user_caps,
        "gateway_proxy": gateway_proxy,
        "session_import": session_import,
        "session_trace": session_trace,
        "session_usage_import": session_usage_import,
    }

    if gateway_proxy and proxy:
        p = _apply_vars_to_proxy(proxy, vars_)
        mode = str(p.get("mode") or "cli").strip()
        entity["proxy_mode"] = mode
        entity["route_bindable"] = bool(p.get("route_bindable", True))
        if mode == "cli":
            entity["protocol"] = str(p.get("protocol") or "openai")
            entity["strategy"] = str(p.get("strategy") or "base_url-env")
            entity["detect_command"] = str(p.get("detect_command") or "")
            entity["detect_version_arg"] = str(p.get("detect_version_arg") or "--version")
            entity["detect_config_dirs"] = _norm_str_list(p.get("detect_config_dirs"))
            entity["inject_env"] = dict(p.get("inject_env") or {})
        else:
            entity["detect_type"] = str(p.get("detect_type") or "appx")
            entity["detect_value"] = str(p.get("detect_value") or "")
            entity["config_file"] = str(p.get("config_file") or "")
            entity["marker"] = str(p.get("marker") or "tokenbank")
            entity["enable_3p"] = bool(p.get("enable_3p"))
            entity["allow_direct"] = bool(p.get("allow_direct", False))
            entity["patch"] = dict(p.get("patch") or {})
            entity["env"] = dict(p.get("env") or {})

    if session_import and session:
        s = _apply_vars_to_session(session, vars_)
        entity["standalone"] = bool(s.get("standalone", not gateway_proxy))
        entity["session_source_id"] = str(s.get("source_id") or c["id"])
        scan = resolve_session_scan(session, vars_, hid)
        if scan:
            entity["session_scan"] = scan
        # route_bindable：网关代理用 proxy 配置；独立会话用 session 配置；附属会话且无网关 → 不可绑路由
        if gateway_proxy:
            entity.setdefault("route_bindable", bool((proxy or {}).get("route_bindable", True)))
        elif entity["standalone"]:
            entity["route_bindable"] = bool(s["route_bindable"]) if "route_bindable" in s else False
        else:
            entity["route_bindable"] = False
        if s.get("models"):
            entity["models"] = _norm_str_list(s["models"])
        elif scan.get("models"):
            entity["models"] = _norm_str_list(scan["models"])
        # 运营配置：计费/供给字段（vars 覆盖 handler / scan 默认）
        for key in ("data_source", "provider_id", "tier", "billing_type"):
            if vars_.get(key) not in (None, ""):
                entity[key] = vars_[key]
            elif scan.get(key):
                entity[key] = scan[key]
    elif gateway_proxy:
        entity["standalone"] = False
    else:
        entity["standalone"] = True

    if handler_has_patch_route(hid):
        entity["route_multi_select"] = resolve_route_multi_select(h, vars_)

    return entity


def infer_handler_from_legacy(entity: dict) -> str | None:
    """旧扁平实体 → 推断 handler id。"""
    eid = str(entity.get("id") or "").strip()
    if entity.get("handler"):
        return str(entity["handler"]).strip()
    if eid in _LEGACY_ID_TO_HANDLER:
        return _LEGACY_ID_TO_HANDLER[eid]

    proxy_mode = str(entity.get("proxy_mode") or "").strip()
    if entity.get("gateway_proxy") and proxy_mode == "cli":
        cmd = str(entity.get("detect_command") or "").strip()
        for hid, h in handlers_map().items():
            p = h.get("proxy") or {}
            if p.get("mode") == "cli" and str(p.get("detect_command") or "") == cmd:
                return hid
    if entity.get("gateway_proxy") and proxy_mode == "api_key":
        dv = str(entity.get("detect_value") or "").strip()
        for hid, h in handlers_map().items():
            p = h.get("proxy") or {}
            if p.get("mode") == "api_key" and str(p.get("detect_value") or "") == dv:
                return hid
    if entity.get("session_import") and not entity.get("gateway_proxy"):
        sid = str(entity.get("session_source_id") or eid).strip()
        for hid, h in handlers_map().items():
            s = h.get("session") or {}
            if str(s.get("source_id") or "") == sid:
                return hid
    return None


def legacy_to_compact(entity: dict) -> dict | None:
    """将旧扁平实体转为 handler + vars（无法推断则返回 None）。"""
    hid = infer_handler_from_legacy(entity)
    if not hid:
        return None
    h = handlers_map().get(hid) or {}
    expanded = expand_entity({"id": entity.get("id"), "handler": hid, "name": entity.get("name"), "icon": entity.get("icon")})
    vars_: dict[str, Any] = {}
    # 从旧扁平字段推导用户能力勾选
    max_caps = handler_max_capabilities(h)
    caps: dict[str, bool] = {}
    if entity.get("gateway_proxy") is not None:
        caps["gateway_proxy"] = bool(entity.get("gateway_proxy"))
    if entity.get("session_import") is not None:
        caps["session_trace"] = bool(entity.get("session_import"))
        caps["session_usage_import"] = bool(entity.get("session_import"))
    if caps:
        vars_["capabilities"] = {k: caps.get(k, max_caps.get(k, False)) for k in CAP_KEYS}
    for key in ("name", "icon", "route_bindable", "allow_direct", "models"):
        if key in entity and entity[key] not in (None, "", []):
            ev = expanded.get(key)
            if key == "models":
                if _norm_str_list(entity.get(key)) != _norm_str_list(ev):
                    vars_[key] = _norm_str_list(entity.get(key))
            elif entity.get(key) != ev:
                vars_[key] = entity[key]
    return normalize_compact_entity({
        "sort_order": entity.get("sort_order"),
        "id": entity.get("id"),
        "handler": hid,
        "name": entity.get("name") or h.get("default_name"),
        "icon": entity.get("icon") or h.get("default_icon"),
        "vars": vars_,
    })


def validate_compact_entity(e: dict) -> None:
    c = normalize_compact_entity(e)
    if not c.get("id"):
        raise ValueError("实体 id 必填")
    if not c.get("handler"):
        raise ValueError("handler 必填")
    if c["handler"] not in handlers_map():
        raise ValueError(f"未知 handler: {c['handler']}")
    if not c.get("name"):
        raise ValueError("名称必填")
    h = handlers_map().get(c["handler"])
    if not h:
        raise ValueError(f"未知 handler: {c['handler']}")
    caps = resolve_user_capabilities(h, c.get("vars") or {})
    if not any(caps.values()):
        raise ValueError("至少启用一项 Handler 能力")

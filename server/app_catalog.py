"""应用目录 — handler + vars 紧凑配置，发布为 config.apps（app_entities + 基础设施）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

import app_handlers as ah
import database as db

CONFIG_KEY = "config.app_catalog"
_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_APPS_DEFAULT = _DEFAULTS_DIR / "apps.default.yaml"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_CLIENT_DEFAULT = _REPO_ROOT / "client" / "electron" / "config" / "tokenbank.default.yaml"

PROTOCOLS = ("anthropic", "openai", "gemini", "responses")
STRATEGIES = ("base_url-env", "mitm-env", "mitm-system")
PROXY_MODES = ("cli", "api_key")
DETECT_TYPES = ("appx", "command")
TIERS = ("free", "paid", "p2p")
BILLING_TYPES = ("subscription", "api-key", "payg")


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


def _sort_key(item: dict) -> int:
    try:
        return int(item.get("sort_order") or 0)
    except (TypeError, ValueError):
        return 0


def _norm_str_list(val: Any) -> list[str]:
    if isinstance(val, list):
        return [str(x).strip() for x in val if str(x).strip()]
    if isinstance(val, str) and val.strip():
        return [x.strip() for x in val.split(",") if x.strip()]
    return []


def _norm_env_map(val: Any) -> dict[str, str]:
    if isinstance(val, dict):
        return {str(k): str(v) for k, v in val.items() if k}
    if isinstance(val, list):
        out: dict[str, str] = {}
        for row in val:
            if isinstance(row, dict) and row.get("key"):
                out[str(row["key"])] = str(row.get("value") or "")
        return out
    return {}


def normalize_tool(raw: dict) -> dict:
    """CLI 工具 YAML 条目 → 扁平字段（支持 detect.command / inject.env 嵌套）。"""
    detect = raw.get("detect") if isinstance(raw.get("detect"), dict) else {}
    inject = raw.get("inject") if isinstance(raw.get("inject"), dict) else {}
    inject_env = inject.get("env") if isinstance(inject.get("env"), dict) else raw.get("inject_env")
    return {
        "sort_order": _sort_key(raw),
        "id": str(raw.get("id") or "").strip(),
        "name": str(raw.get("name") or raw.get("id") or "").strip(),
        "protocol": str(raw.get("protocol") or "openai").strip(),
        "strategy": str(raw.get("strategy") or "base_url-env").strip(),
        "route_bindable": bool(raw.get("route_bindable", True)),
        "detect_command": str(detect.get("command") or raw.get("detect_command") or "").strip(),
        "detect_version_arg": str(
            detect.get("version-arg") or detect.get("version_arg") or raw.get("detect_version_arg") or "--version"
        ).strip(),
        "detect_config_dirs": _norm_str_list(
            detect.get("config-dirs") or detect.get("config_dirs") or raw.get("detect_config_dirs")
        ),
        "inject_env": _norm_env_map(inject_env),
    }


def normalize_api_key_app(raw: dict) -> dict:
    """API Key 应用 YAML 条目 → 扁平字段。"""
    patch = raw.get("patch") if isinstance(raw.get("patch"), dict) else {}
    env = raw.get("env") if isinstance(raw.get("env"), dict) else {}
    detect_type = "appx" if raw.get("appx") else "command" if raw.get("command") else str(raw.get("detect_type") or "appx")
    return {
        "sort_order": _sort_key(raw),
        "id": str(raw.get("id") or "").strip(),
        "name": str(raw.get("name") or raw.get("id") or "").strip(),
        "icon": str(raw.get("icon") or "🔧").strip(),
        "detect_type": detect_type if detect_type in DETECT_TYPES else "appx",
        "detect_value": str(raw.get("appx") or raw.get("command") or raw.get("detect_value") or "").strip(),
        "config_file": str(raw.get("config_file") or "").strip(),
        "marker": str(raw.get("marker") or "tokenbank").strip(),
        "enable_3p": bool(raw.get("enable_3p")),
        "route_bindable": bool(raw.get("route_bindable", True)),
        "allow_direct": bool(raw.get("allow_direct", False)),
        "patch": patch,
        "env": env,
    }


def normalize_session_source(raw: dict) -> dict:
    """会话统计源 → 扁平字段。"""
    if not raw:
        return {}
    return {
        "sort_order": _sort_key(raw),
        "id": str(raw.get("id") or "").strip(),
        "data_source": str(raw.get("data_source") or f"session-{raw.get('id', '')}").strip(),
        "agent_id": str(raw.get("agent_id") or raw.get("id") or "").strip(),
        "provider_id": str(raw.get("provider_id") or raw.get("agent_id") or raw.get("id") or "").strip(),
        "tier": str(raw.get("tier") or "paid").strip(),
        "billing_type": str(raw.get("billing_type") or "subscription").strip(),
        "direct_only": bool(raw.get("direct_only")),
        "app_name": str(raw.get("app_name") or raw.get("name") or "").strip(),
        "app_icon": str(raw.get("app_icon") or "🔧").strip(),
        "models": _norm_str_list(raw.get("models")),
        "enabled": raw.get("enabled") is not False,
    }


# ── 用户可见实体（紧凑 schema：handler + vars）────────────────────────────────

def normalize_entity(raw: dict) -> dict:
    """DB 存储格式：id + handler + vars；旧扁平条目自动迁移为 handler。"""
    if raw.get("handler"):
        return ah.normalize_compact_entity(raw)
    compact = ah.legacy_to_compact(raw)
    if compact:
        return compact
    # 无法推断 handler 的旧数据：保留扁平字段供一次性 compile（下次保存应选手 handler）
    return _normalize_legacy_entity(raw)


def _normalize_legacy_entity(raw: dict) -> dict:
    """旧扁平实体（无 handler）— 仅用于兼容 compile，不推荐新写入。"""
    gateway_proxy = bool(raw.get("gateway_proxy"))
    proxy_mode = str(raw.get("proxy_mode") or "").strip()
    if gateway_proxy and proxy_mode not in PROXY_MODES:
        proxy_mode = "cli" if raw.get("detect_command") or raw.get("protocol") else "api_key"
    session_import = bool(raw.get("session_import"))
    standalone = raw.get("standalone")
    if standalone is None:
        standalone = session_import and not gateway_proxy
    patch = raw.get("patch") if isinstance(raw.get("patch"), dict) else {}
    env = raw.get("env") if isinstance(raw.get("env"), dict) else {}
    detect_type = str(raw.get("detect_type") or "appx")
    eid = str(raw.get("id") or "").strip()
    return {
        "sort_order": _sort_key(raw),
        "id": eid,
        "name": str(raw.get("name") or raw.get("app_name") or eid).strip(),
        "icon": str(raw.get("icon") or raw.get("app_icon") or "🔧").strip(),
        "enabled": raw.get("enabled") is not False,
        "gateway_proxy": gateway_proxy,
        "proxy_mode": proxy_mode if gateway_proxy else None,
        "session_import": session_import,
        "standalone": bool(standalone),
        "route_bindable": bool(raw.get("route_bindable", True)),
        "protocol": str(raw.get("protocol") or "openai").strip(),
        "strategy": str(raw.get("strategy") or "base_url-env").strip(),
        "detect_command": str(raw.get("detect_command") or "").strip(),
        "detect_version_arg": str(raw.get("detect_version_arg") or "--version").strip(),
        "detect_config_dirs": _norm_str_list(raw.get("detect_config_dirs")),
        "inject_env": _norm_env_map(raw.get("inject_env")),
        "detect_type": detect_type if detect_type in DETECT_TYPES else "appx",
        "detect_value": str(raw.get("detect_value") or raw.get("appx") or raw.get("command") or "").strip(),
        "config_file": str(raw.get("config_file") or "").strip(),
        "marker": str(raw.get("marker") or "tokenbank").strip(),
        "enable_3p": bool(raw.get("enable_3p")),
        "allow_direct": bool(raw.get("allow_direct", False)),
        "patch": patch,
        "env": env,
        "session_source_id": str(raw.get("session_source_id") or raw.get("session_id") or eid).strip(),
        "data_source": str(raw.get("data_source") or "").strip(),
        "provider_id": str(raw.get("provider_id") or eid).strip(),
        "tier": str(raw.get("tier") or "paid").strip(),
        "billing_type": str(raw.get("billing_type") or "subscription").strip(),
        "models": _norm_str_list(raw.get("models")),
    }


def expand_entity_for_compile(raw: dict) -> dict:
    """编译前展开：handler → 完整代理/会话字段。"""
    norm = normalize_entity(raw)
    if norm.get("handler"):
        return ah.expand_entity(norm)
    return norm


def entity_summary_fields(compact: dict) -> dict:
    """管理列表展示用：与用户勾选 capabilities 一致。"""
    try:
        exp = expand_entity_for_compile(compact)
    except ValueError:
        return {}
    caps = exp.get("capabilities") or ah.resolve_user_capabilities(
        ah.handlers_map().get(compact.get("handler") or "", {}),
        (compact.get("vars") or {}),
    )
    has_gateway = bool(caps.get("gateway_proxy"))
    has_session = bool(caps.get("session_trace") or caps.get("session_usage_import"))
    route_bindable = False
    if has_gateway:
        route_bindable = bool(exp.get("route_bindable", True))
    elif has_session and exp.get("standalone"):
        route_bindable = bool(exp.get("route_bindable", False))
    return {
        "gateway_proxy": has_gateway,
        "proxy_mode": exp.get("proxy_mode") if has_gateway else None,
        "session_import": has_session,
        "session_trace": bool(caps.get("session_trace")),
        "session_usage_import": bool(caps.get("session_usage_import")),
        "capabilities": caps,
        "standalone": bool(exp.get("standalone")) if has_session else False,
        "route_bindable": route_bindable,
    }


def validate_entity(e: dict) -> None:
    norm = normalize_entity(e)
    if norm.get("handler"):
        ah.validate_compact_entity(norm)
        return
    if not norm.get("id"):
        raise ValueError("实体 id 必填")
    if not norm.get("gateway_proxy") and not norm.get("session_import"):
        raise ValueError("请选择 handler，或至少启用网关代理/会话统计")


def _apps_default_doc() -> dict:
    if not _APPS_DEFAULT.is_file():
        return {}
    return yaml.safe_load(_APPS_DEFAULT.read_text(encoding="utf-8")) or {}


def _session_defaults_by_id() -> dict[str, dict]:
    if not _CLIENT_DEFAULT.is_file():
        return {}
    doc = yaml.safe_load(_CLIENT_DEFAULT.read_text(encoding="utf-8")) or {}
    return {s["id"]: s for s in (doc.get("session_sources") or []) if isinstance(s, dict) and s.get("id")}


# ── 旧三列表 → 实体（加载 DB 时自动迁移）────────────────────────────────────────

def _tool_to_entity(t: dict, sess: dict | None) -> dict:
    """从 tools YAML 条目（含 detect/inject 嵌套）转为实体。"""
    nt = normalize_tool(t)
    ns = normalize_session_source(sess) if sess else None
    return normalize_entity({
        "sort_order": nt.get("sort_order"),
        "id": nt.get("id"),
        "name": nt.get("name"),
        "icon": "🤖",
        "gateway_proxy": True,
        "proxy_mode": "cli",
        "session_import": bool(ns),
        "standalone": False,
        "route_bindable": nt.get("route_bindable", True),
        "protocol": nt.get("protocol"),
        "strategy": nt.get("strategy"),
        "detect_command": nt.get("detect_command"),
        "detect_version_arg": nt.get("detect_version_arg"),
        "detect_config_dirs": nt.get("detect_config_dirs"),
        "inject_env": nt.get("inject_env"),
        "session_source_id": ns.get("id") if ns else "",
        "data_source": ns.get("data_source") if ns else "",
        "provider_id": ns.get("provider_id") if ns else nt.get("id"),
        "tier": ns.get("tier") if ns else "paid",
        "billing_type": ns.get("billing_type") if ns else "subscription",
        "models": ns.get("models") if ns else [],
    })


def _api_to_entity(a: dict) -> dict:
    na = normalize_api_key_app(a)
    return normalize_entity({
        "sort_order": na.get("sort_order"),
        "id": na.get("id"),
        "name": na.get("name"),
        "icon": na.get("icon"),
        "gateway_proxy": True,
        "proxy_mode": "api_key",
        "session_import": False,
        "standalone": False,
        "route_bindable": na.get("route_bindable", True),
        "detect_type": na.get("detect_type"),
        "detect_value": na.get("detect_value"),
        "config_file": na.get("config_file"),
        "marker": na.get("marker"),
        "enable_3p": na.get("enable_3p"),
        "allow_direct": na.get("allow_direct"),
        "patch": na.get("patch"),
        "env": na.get("env"),
    })


def _session_to_entity(s: dict) -> dict:
    agent = str(s.get("agent_id") or s.get("id") or "").strip()
    direct_only = bool(s.get("direct_only"))
    return normalize_entity({
        "sort_order": s.get("sort_order"),
        "id": agent or s.get("id"),
        "name": s.get("app_name") or agent,
        "icon": s.get("app_icon") or "🔧",
        "gateway_proxy": False,
        "session_import": True,
        "standalone": True,
        "route_bindable": not direct_only,
        "session_source_id": s.get("id"),
        "data_source": s.get("data_source"),
        "provider_id": s.get("provider_id"),
        "tier": s.get("tier"),
        "billing_type": s.get("billing_type"),
        "models": s.get("models"),
        "enabled": s.get("enabled") is not False,
    })


def _merge_entity(base: dict, overlay: dict) -> dict:
    """用默认实体补全 DB 里缺字段的条目（不覆盖已有非空值）。"""
    out = dict(base)
    for key, val in overlay.items():
        if key not in out or out[key] in (None, "", [], {}):
            out[key] = val
            continue
        # inject_env / patch / env：默认有内容、当前为空 dict 时补全
        if key in ("inject_env", "patch", "env") and isinstance(out.get(key), dict) and not out[key] and val:
            out[key] = val
    return normalize_entity(out)


def enrich_entities_from_defaults(entities: list[dict]) -> list[dict]:
    """加载 DB 后：旧扁平条目迁移为 handler；缺 handler 的用默认清单补全。"""
    defaults = {e["id"]: e for e in import_from_defaults().get("entities") or []}
    out: list[dict] = []
    for e in entities:
        norm = normalize_entity(e)
        if norm.get("handler"):
            if e.get("id") in defaults:
                d = defaults[e["id"]]
                if not norm.get("name"):
                    norm["name"] = d.get("name")
                    norm["icon"] = d.get("icon")
                # 补全用户能力勾选默认值
                vars_ = norm.get("vars") or {}
                if not isinstance(vars_.get("capabilities"), dict):
                    vars_["capabilities"] = (d.get("vars") or {}).get("capabilities") or {}
                    norm["vars"] = vars_
            out.append(norm)
            continue
        if e.get("id") in defaults:
            out.append(defaults[e["id"]])
        else:
            out.append(norm)
    return out


def legacy_doc_to_entities(doc: dict) -> list[dict]:
    """将旧版 tools / api_key_apps / session_sources 合并为实体列表。"""
    tools = doc.get("tools") or []
    api_apps = doc.get("api_key_apps") or []
    sessions = doc.get("session_sources") or []

    sess_by_agent: dict[str, dict] = {}
    for s in sessions:
        if isinstance(s, dict) and s.get("agent_id"):
            sess_by_agent[str(s["agent_id"])] = s

    entities: list[dict] = []
    attached_sess_ids: set[str] = set()

    for t in tools:
        if not isinstance(t, dict) or not t.get("id"):
            continue
        tid = str(t["id"])
        sess = sess_by_agent.get(tid)
        if sess:
            attached_sess_ids.add(str(sess.get("id")))
        entities.append(_tool_to_entity(t, sess))

    for a in api_apps:
        if isinstance(a, dict) and a.get("id"):
            entities.append(_api_to_entity(a))

    entity_ids = {e["id"] for e in entities}
    for s in sessions:
        if not isinstance(s, dict) or not s.get("id"):
            continue
        sid = str(s["id"])
        if sid in attached_sess_ids:
            continue
        agent = str(s.get("agent_id") or sid)
        if agent in entity_ids:
            continue
        entities.append(_session_to_entity(s))
        entity_ids.add(agent)

    return sorted(entities, key=_sort_key)


def import_from_defaults() -> dict:
    """从 app-handlers.yaml 默认实体清单导入。"""
    entities = ah.default_entities_compact()
    if entities:
        return {"version": 1, "entities": entities}
    # 回退：旧 apps.default + session_sources 合并
    apps = _apps_default_doc()
    sessions = list(_session_defaults_by_id().values())
    legacy = {
        "version": 1,
        "tools": apps.get("tools") or [],
        "api_key_apps": apps.get("api_key_apps") or [],
        "session_sources": sessions,
    }
    migrated = []
    for e in legacy_doc_to_entities(legacy):
        c = ah.legacy_to_compact(e) or normalize_entity(e)
        migrated.append(c)
    return {"version": 1, "entities": migrated}


# ── 实体 → 客户端三段 YAML ────────────────────────────────────────────────────

def _compile_tool(e: dict) -> dict:
    out: dict[str, Any] = {
        "id": e["id"],
        "name": e["name"],
        "protocol": e.get("protocol") or "openai",
        "route_bindable": e.get("route_bindable", True),
        "strategy": e.get("strategy") or "base_url-env",
    }
    if e.get("detect_command"):
        detect: dict[str, Any] = {"command": e["detect_command"]}
        if e.get("detect_version_arg"):
            detect["version-arg"] = e["detect_version_arg"]
        if e.get("detect_config_dirs"):
            detect["config-dirs"] = e["detect_config_dirs"]
        out["detect"] = detect
    env = e.get("inject_env") or {}
    if env:
        out["inject"] = {"env": env}
    return out


def _compile_api_key_app(e: dict) -> dict:
    out: dict[str, Any] = {
        "id": e["id"],
        "name": e["name"],
        "icon": e.get("icon") or "🔧",
        "config_file": e.get("config_file") or "",
        "marker": e.get("marker") or "tokenbank",
        "route_bindable": e.get("route_bindable", True),
        "allow_direct": e.get("allow_direct", False),
    }
    if e.get("enable_3p"):
        out["enable_3p"] = True
    if e.get("detect_type") == "command":
        out["command"] = e.get("detect_value") or ""
    else:
        out["appx"] = e.get("detect_value") or ""
    if e.get("patch"):
        out["patch"] = e["patch"]
    if e.get("env"):
        out["env"] = e["env"]
    return out


def _compile_session_source(e: dict, defaults: dict[str, dict]) -> dict | None:
    if not e.get("session_import"):
        return None
    sid = e.get("session_source_id") or e["id"]
    base = dict(defaults.get(sid) or defaults.get(e["id"]) or {})
    overlay: dict[str, Any] = {
        "id": sid,
        "agent_id": e["id"],
        "standalone": bool(e.get("standalone")),
        "app_name": e.get("name"),
        "app_icon": e.get("icon"),
    }
    for key in ("data_source", "provider_id", "tier", "billing_type"):
        if e.get(key):
            overlay[key] = e[key]
    if e.get("models"):
        overlay["models"] = e["models"]
    caps = e.get("capabilities") if isinstance(e.get("capabilities"), dict) else {}
    if "session_trace" in caps:
        overlay["session_trace"] = bool(caps["session_trace"])
    if "session_usage_import" in caps:
        overlay["session_usage_import"] = bool(caps["session_usage_import"])
    # 无网关代理时：route_bindable 反推 direct_only
    if not e.get("gateway_proxy"):
        overlay["direct_only"] = not e.get("route_bindable", True)
    elif e.get("standalone") is False:
        overlay["direct_only"] = False
    merged = {**base, **overlay}
    if "direct_only" not in overlay and "direct_only" in base:
        merged["direct_only"] = base["direct_only"]
    return merged


def compile_apps_doc(doc: dict) -> dict:
    """实体列表 → 客户端 config.apps（基础设施 + app_entities + 按需附带的 handlers/session_scans）。"""
    defaults = _apps_default_doc()
    entities = doc.get("entities") or []

    out: dict[str, Any] = {"version": doc.get("version") or defaults.get("version") or 1}
    for key in ("gateway", "mitm", "claude_models"):
        if defaults.get(key) is not None:
            out[key] = defaults[key]
    app_entities: list[dict] = []
    if entities:
        app_entities = [
            {
                "sort_order": e.get("sort_order") or 0,
                "id": e.get("id"),
                "handler": e.get("handler"),
                "name": e.get("name"),
                "icon": e.get("icon"),
                "vars": e.get("vars") or {},
            }
            for e in entities
            if e.get("id") and e.get("handler")
        ]
        out["app_entities"] = app_entities

    # 发布时附带实体所需的 handler 定义与扫描规则，客户端可无需预置即可展开
    handlers_out: dict[str, dict] = {}
    session_scans_out: dict[str, dict] = {}
    hmap = ah.handlers_map()
    for compact in app_entities:
        hid = str(compact.get("handler") or "").strip()
        if hid and hid in hmap:
            handlers_out[hid] = hmap[hid]
        try:
            expanded = ah.expand_entity(compact)
        except ValueError:
            continue
        sid = expanded.get("session_source_id")
        scan = expanded.get("session_scan")
        if sid and isinstance(scan, dict) and scan:
            session_scans_out[str(sid)] = scan
    if handlers_out:
        out["handlers"] = handlers_out
    if session_scans_out:
        out["session_scans"] = session_scans_out
    return out


async def load_catalog_doc() -> dict:
    raw = await db.get_config(CONFIG_KEY, "")
    if raw.strip():
        doc = _parse_json_or_yaml(raw)
        if doc:
            if doc.get("entities"):
                entities = enrich_entities_from_defaults(doc.get("entities") or [])
                return {"version": doc.get("version") or 1, "entities": entities}
            # 自动迁移旧三列表格式
            if doc.get("tools") or doc.get("api_key_apps") or doc.get("session_sources"):
                return {"version": doc.get("version") or 1, "entities": legacy_doc_to_entities(doc)}
    return {"version": 1, "entities": []}


async def save_catalog_doc(doc: dict) -> None:
    entities = [normalize_entity(e) for e in (doc.get("entities") or []) if e.get("id")]
    payload = {"version": doc.get("version") or 1, "entities": entities}
    await db.set_config(CONFIG_KEY, json.dumps(payload, ensure_ascii=False, indent=2))


async def publish_catalog(doc: dict | None = None) -> dict:
    if doc is None:
        doc = await load_catalog_doc()
    compiled = compile_apps_doc(doc)
    yaml_text = yaml.dump(
        compiled, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    await db.set_config("config.apps", yaml_text)
    entities = doc.get("entities") or []
    return {
        "apps_bytes": len(yaml_text.encode("utf-8")),
        "entities_count": len(entities),
        "app_entities_count": len(compiled.get("app_entities") or []),
    }


def export_to_defaults(doc: dict) -> dict:
    compiled = compile_apps_doc(doc)
    if not _APPS_DEFAULT.is_file():
        return {"ok": False, "error": "apps.default.yaml not found"}
    text = _APPS_DEFAULT.read_text(encoding="utf-8")
    lines = text.splitlines()
    out_lines: list[str] = []
    skip = False
    for line in lines:
        if line.strip().startswith("tools:"):
            skip = True
            continue
        if skip and line.strip().startswith("# ── API Key"):
            skip = False
        if skip:
            continue
        if line.strip().startswith("api_key_apps:"):
            skip = True
            continue
        if skip and (line.strip().startswith("# 个人页") or line.strip().startswith("# 已迁出")):
            skip = False
        if skip:
            continue
        out_lines.append(line)
    body = yaml.dump(
        {"tools": compiled.get("tools") or [], "api_key_apps": compiled.get("api_key_apps") or []},
        allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    merged = "\n".join(out_lines).rstrip() + "\n\n" + body + "\n"
    _APPS_DEFAULT.write_text(merged, encoding="utf-8")
    return {"path": str(_APPS_DEFAULT.relative_to(_REPO_ROOT)), "bytes": len(merged.encode("utf-8")), "ok": True}

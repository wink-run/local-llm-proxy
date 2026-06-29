"""将 DB 中的 config.apps 与 static/defaults/apps.default.yaml 合并，补全新增字段。"""

from __future__ import annotations

from pathlib import Path

import yaml

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_APPS_DEFAULT = _DEFAULTS_DIR / "apps.default.yaml"
_SOURCES_DEFAULT = _DEFAULTS_DIR / "sources.default.yaml"

# 「源」目录段（已从 apps.default.yaml 迁出至 sources.default.yaml，独立下发 config.sources）
_BILLING_KEYS = ("subscription_apps", "api_subscription_apps", "subscription_plans", "payg_providers")


def _default_apps_doc() -> dict:
    if not _APPS_DEFAULT.is_file():
        return {}
    return yaml.safe_load(_APPS_DEFAULT.read_text(encoding="utf-8")) or {}


def _default_sources_doc() -> dict:
    if not _SOURCES_DEFAULT.is_file():
        return {}
    return yaml.safe_load(_SOURCES_DEFAULT.read_text(encoding="utf-8")) or {}


def merge_subscription_apps(current: list | None, defaults: list | None) -> list:
    """按 source_id 合并订阅应用目录，补全 subscription_to_api / plan_provider_id 等字段。"""
    def_list = list(defaults or [])
    cur_list = list(current or [])
    def_by = {a["source_id"]: dict(a) for a in def_list if a.get("source_id")}

    if not cur_list:
        return def_list

    out: list[dict] = []
    seen: set[str] = set()
    for app in cur_list:
        if not isinstance(app, dict):
            continue
        sid = app.get("source_id")
        if not sid:
            out.append(app)
            continue
        seen.add(sid)
        base = def_by.get(sid) or {}
        merged = {**base, **app}
        # DB/管理员配置未显式设置时，用内置默认补全
        if app.get("subscription_to_api") is None and "subscription_to_api" in base:
            merged["subscription_to_api"] = base["subscription_to_api"]
        if app.get("plan_provider_id") is None and base.get("plan_provider_id") is not None:
            merged["plan_provider_id"] = base["plan_provider_id"]
        out.append(merged)

    # 默认 yaml 新增的应用追加到末尾
    for sid, base in def_by.items():
        if sid not in seen:
            out.append(dict(base))
    return out


def merge_apps_doc(current: dict | None) -> dict:
    """应用清单（tools / api_key_apps）。计费/源段已迁出至 sources.default.yaml，
    这里主动剥离，确保应用下发文件（config.apps）不再含任何源目录段。"""
    if not isinstance(current, dict):
        return {}
    return {k: v for k, v in current.items() if k not in _BILLING_KEYS}


def merge_api_subscription_apps(current: list | None, defaults: list | None) -> list:
    """API 订阅目录以内置默认为准，忽略已从默认移除的 source_id。"""
    def_list = list(defaults or [])
    if not def_list:
        return list(current or [])
    cur_by: dict[str, dict] = {}
    for app in current or []:
        if isinstance(app, dict) and app.get("source_id"):
            cur_by[app["source_id"]] = dict(app)
    out: list[dict] = []
    for base in def_list:
        if not isinstance(base, dict):
            continue
        sid = base.get("source_id")
        if not sid:
            continue
        over = cur_by.get(sid) or {}
        merged = {**base, **over}
        if over.get("plan_provider_id") is None and base.get("plan_provider_id") is not None:
            merged["plan_provider_id"] = base["plan_provider_id"]
        out.append(merged)
    return out


def merge_apps_yaml_text(content: str) -> str:
    """将 YAML 文本与内置默认合并后重新序列化。"""
    text = (content or "").strip()
    if not text:
        return text
    parsed = yaml.safe_load(text) or {}
    merged = merge_apps_doc(parsed)
    return yaml.dump(
        merged,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    ).rstrip()


def merge_sources_doc(current: dict | None) -> dict:
    """合并「源」目录段与内置默认（sources.default.yaml）。
    subscription_apps / api_subscription_apps 按 source_id 合并补全；
    subscription_plans / payg_providers 当前优先、空则回退默认。"""
    if not isinstance(current, dict):
        current = {}
    defaults = _default_sources_doc()
    out = dict(current)
    if defaults.get("subscription_apps") or out.get("subscription_apps"):
        out["subscription_apps"] = merge_subscription_apps(
            out.get("subscription_apps"),
            defaults.get("subscription_apps"),
        )
    if defaults.get("api_subscription_apps") or out.get("api_subscription_apps"):
        out["api_subscription_apps"] = merge_api_subscription_apps(
            out.get("api_subscription_apps"),
            defaults.get("api_subscription_apps"),
        )
    for key in ("subscription_plans", "payg_providers"):
        if not out.get(key) and defaults.get(key):
            out[key] = defaults[key]
    return out


def merge_sources_yaml_text(content: str) -> str:
    """源 YAML 文本与内置默认合并后序列化。空文本回退为内置默认全集。"""
    text = (content or "").strip()
    parsed = yaml.safe_load(text) if text else {}
    if not isinstance(parsed, dict):
        parsed = {}
    merged = merge_sources_doc(parsed)
    return yaml.dump(
        merged,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    ).rstrip()

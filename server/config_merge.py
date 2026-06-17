"""将 DB 中的 config.apps 与 static/defaults/apps.default.yaml 合并，补全新增字段。"""

from __future__ import annotations

from pathlib import Path

import yaml

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_APPS_DEFAULT = _DEFAULTS_DIR / "apps.default.yaml"


def _default_apps_doc() -> dict:
    if not _APPS_DEFAULT.is_file():
        return {}
    return yaml.safe_load(_APPS_DEFAULT.read_text(encoding="utf-8")) or {}


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
    """合并计费目录段（当前以 subscription_apps 为主）。"""
    if not isinstance(current, dict):
        return {}
    defaults = _default_apps_doc()
    out = dict(current)
    if defaults.get("subscription_apps") or out.get("subscription_apps"):
        out["subscription_apps"] = merge_subscription_apps(
            out.get("subscription_apps"),
            defaults.get("subscription_apps"),
        )
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

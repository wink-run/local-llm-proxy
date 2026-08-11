"""场景路由目录 — 表单 schema，编译为 config.scenes 下发。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

import database as db

CONFIG_KEY = "config.routing_catalog"
_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_SCENES_DEFAULT = _DEFAULTS_DIR / "scenes.default.yaml"
_REPO_ROOT = Path(__file__).resolve().parent.parent
TIERS = ("free", "paid", "p2p")
# 全局路由策略目录：名称+元数据(label/description)从 routing-strategies.yaml 读取下发；
# 逻辑由客户端 routing-strategies.js 里同名 JS 函数实现（与 app-handlers 同模式）。
_STRATEGIES_CLIENT = _REPO_ROOT / "client" / "electron" / "config" / "routing-strategies.yaml"
_STRATEGIES_SERVER = _DEFAULTS_DIR / "routing-strategies.yaml"


def load_strategies_meta() -> list[dict]:
    path = _STRATEGIES_CLIENT if _STRATEGIES_CLIENT.is_file() else _STRATEGIES_SERVER
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return []
    out: list[dict] = []
    for s in (raw.get("strategies") or []):
        name = str((s or {}).get("name") or "").strip()
        if not name:
            continue
        out.append({
            "name": name,
            "label_zh": s.get("label_zh") or name,
            "label_en": s.get("label_en") or name,
            "description_zh": s.get("description_zh") or "",
            "description_en": s.get("description_en") or "",
        })
    return out


def strategy_names() -> tuple[str, ...]:
    names = tuple(s["name"] for s in load_strategies_meta())
    return names or ("cost", "speed", "fallback", "round-robin", "weighted")


def normalize_strategy(val: Any) -> str | None:
    s = str(val or "").strip()
    return s if s in strategy_names() else None


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


def normalize_step(raw: dict) -> dict:
    """一步 = 一个 Selector：保留 model/scope/tier/strategy/provider/sharer（有才留），与客户端一致。
    scope=来源(personal 个人源 / community 社区)，与 tier=价格(free/paid) 正交。"""
    out: dict = {}
    for k in ("model", "scope", "tier", "strategy", "provider", "sharer"):
        v = str(raw.get(k) or "").strip()
        if v:
            out[k] = v
    w = raw.get("when")   # 每步可选条件（token/关键字/分类器等），命中才用；无=兜底
    if isinstance(w, dict) and w.get("type"):
        out["when"] = w
    return out


def normalize_route(raw: dict) -> dict:
    # 保留任何带 model/tier/strategy/provider/sharer 的步（strategy-only / tier-only 步无 model 也保留）
    steps = []
    for s in (raw.get("steps") or []):
        if not isinstance(s, dict):
            continue
        ns = normalize_step(s)
        if ns:
            steps.append(ns)
    out = {
        "sort_order": _sort_key(raw),
        "id": str(raw.get("id") or "").strip(),
        "scene_name": str(raw.get("scene_name") or raw.get("name") or "").strip(),
        "icon": str(raw.get("icon") or "🔀").strip(),
        "model_key": str(raw.get("model_key") or "").strip(),
        "steps": steps,
    }
    strategy = normalize_strategy(raw.get("strategy"))
    if strategy:
        out["strategy"] = strategy         # 兼容旧 route-level 策略路由
    flow = normalize_strategy(raw.get("flow"))
    if flow:
        out["flow"] = flow                 # 链级流转策略
    # 路由级统一过滤（顶层，和 flow 并列）：scope=来源(personal/community) / tier=价格(free/paid)
    rscope = str(raw.get("scope") or "").strip()
    if rscope in ("personal", "community"):
        out["scope"] = rscope
    rtier = str(raw.get("tier") or "").strip()
    if rtier in ("free", "paid", "p2p"):
        out["tier"] = rtier
    if isinstance(raw.get("rules"), list) and raw["rules"]:
        out["rules"] = raw["rules"]        # 条件规则(token/关键字)透传
    if isinstance(raw.get("classifier"), dict) and raw["classifier"]:
        out["classifier"] = raw["classifier"]
    if raw.get("caveman_level") in ("lite", "full", "ultra"):
        out["caveman_level"] = raw["caveman_level"]
    return out


def validate_route(r: dict) -> None:
    if not r.get("id"):
        raise ValueError("route id 必填")
    if not r.get("model_key"):
        raise ValueError("model_key 必填")
    if not r.get("scene_name"):
        raise ValueError("scene_name 必填")
    # 策略/流转，或路由级来源/价格过滤：均可无 steps（与管理端文案一致）
    if r.get("strategy") or r.get("flow") or r.get("scope") or r.get("tier"):
        return
    if not r.get("steps"):
        raise ValueError("至少需要一个路由步骤，或设置来源/价格/流转策略")


def compile_route(r: dict) -> dict:
    out = {
        "id": r["id"],
        "scene_name": r["scene_name"],
        "icon": r.get("icon") or "🔀",
        "model_key": r["model_key"],
    }
    if r.get("strategy"):
        out["strategy"] = r["strategy"]
    if r.get("steps"):
        out["steps"] = [normalize_step(s) for s in r["steps"]]   # 全字段保留
    # flow / scope / tier 与客户端 scene_routes 对齐，缺一则过滤路由下发后失效
    for k in ("flow", "scope", "tier", "rules", "classifier", "caveman_level"):
        if r.get(k):
            out[k] = r[k]
    return out


def compile_scenes_doc(doc: dict) -> dict:
    # 无"全局默认策略"概念：路由由 app 绑定生效，未绑请求走直连；不再下发顶层 default_strategy。
    routes = [compile_route(normalize_route(r)) for r in sorted(doc.get("routes") or [], key=_sort_key)]
    return {"version": doc.get("version") or 1, "scene_routes": routes}


def import_from_defaults() -> dict:
    if not _SCENES_DEFAULT.is_file():
        return {"version": 1, "routes": []}
    raw = yaml.safe_load(_SCENES_DEFAULT.read_text(encoding="utf-8")) or {}
    routes = [normalize_route(r) for r in (raw.get("scene_routes") or []) if isinstance(r, dict)]
    return {"version": 1, "routes": routes}


async def load_catalog_doc() -> dict:
    raw = await db.get_config(CONFIG_KEY, "")
    if raw.strip():
        doc = _parse_json_or_yaml(raw)
        if doc:
            return {"version": doc.get("version") or 1, "routes": doc.get("routes") or []}
    return {"version": 1, "routes": []}


async def save_catalog_doc(doc: dict) -> None:
    payload = {
        "version": doc.get("version") or 1,
        "routes": [normalize_route(r) for r in (doc.get("routes") or []) if r.get("id")],
    }
    await db.set_config(CONFIG_KEY, json.dumps(payload, ensure_ascii=False, indent=2))


async def publish_catalog(doc: dict | None = None) -> dict:
    if doc is None:
        doc = await load_catalog_doc()
    compiled = compile_scenes_doc(doc)
    yaml_text = yaml.dump(
        compiled, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    await db.set_config("config.scenes", yaml_text)
    return {
        "scenes_bytes": len(yaml_text.encode("utf-8")),
        "routes_count": len(compiled.get("scene_routes") or []),
    }


def export_to_defaults(doc: dict) -> dict:
    compiled = compile_scenes_doc(doc)
    if not _SCENES_DEFAULT.is_file():
        return {"ok": False, "error": "scenes.default.yaml not found"}
    text = _SCENES_DEFAULT.read_text(encoding="utf-8")
    prefix = text.split("scene_routes:")[0].rstrip() + "\n\n"
    body = yaml.dump(compiled, allow_unicode=True, sort_keys=False, default_flow_style=False).rstrip()
    merged = prefix + body.split("\n", 1)[1] if "scene_routes:" in body else prefix + body
    if not merged.endswith("\n"):
        merged += "\n"
    _SCENES_DEFAULT.write_text(merged, encoding="utf-8")
    return {"path": str(_SCENES_DEFAULT.relative_to(_REPO_ROOT)), "bytes": len(merged.encode("utf-8")), "ok": True}

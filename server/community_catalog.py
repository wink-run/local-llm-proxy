"""社区推荐目录 —— 通过 GET /api/community-catalog 下发给客户端。

四段:mcp / prompts / skills / assistants。
默认数据源:
  - mcp:       复用 client/electron/config/mcp-catalog.yaml 的 items(仿 routing_catalog 读 client 文件)
  - 其余三段:  static/defaults/community-resources.yaml
DB config.community_catalog 可整体覆盖默认。

用户推荐的 skill 写入 skills[]，带 metadata.user_recommended；
公开下发时跳过 metadata.enabled === false。
积分额度由 system_config 控制（可后台修改）:
  community_skill_install_cost / community_skill_recommend_reward
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import yaml

import database as db

CONFIG_KEY = "config.community_catalog"
INSTALL_COST_KEY = "community_skill_install_cost"
RECOMMEND_REWARD_KEY = "community_skill_recommend_reward"
DEFAULT_INSTALL_COST = 8.0
DEFAULT_RECOMMEND_REWARD = 5.0

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"
_REPO_ROOT = Path(__file__).resolve().parent.parent
MCP_CATALOG_CLIENT = _REPO_ROOT / "client" / "electron" / "config" / "mcp-catalog.yaml"
MCP_CATALOG_SERVER = _DEFAULTS_DIR / "mcp-catalog.yaml"
RESOURCES_DEFAULT = _DEFAULTS_DIR / "community-resources.yaml"

_SECTIONS = ("mcp", "prompts", "skills", "assistants")


def _read_yaml(path: Path) -> dict:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


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


def load_default_doc() -> dict:
    """从 client mcp-catalog.yaml + community-resources.yaml 组装默认四段。"""
    mcp_path = MCP_CATALOG_CLIENT if MCP_CATALOG_CLIENT.is_file() else MCP_CATALOG_SERVER
    mcp_doc = _read_yaml(mcp_path)
    res_doc = _read_yaml(RESOURCES_DEFAULT)
    return normalize_catalog_doc({
        "version": res_doc.get("version") or mcp_doc.get("version") or 1,
        "mcp": mcp_doc.get("items") or [],
        "prompts": res_doc.get("prompts") or [],
        "skills": res_doc.get("skills") or [],
        "assistants": res_doc.get("assistants") or [],
    })


def normalize_catalog_doc(doc: dict) -> dict:
    doc = doc if isinstance(doc, dict) else {}
    out = {"version": int(doc.get("version") or 1)}
    for key in _SECTIONS:
        val = doc.get(key)
        items = [x for x in val if isinstance(x, dict)] if isinstance(val, list) else []
        # 纠正误写的 type=agent（资源类型应为 assistant）
        if key == "assistants":
            fixed = []
            for item in items:
                if item.get("type") == "agent":
                    item = {**item, "type": "assistant"}
                fixed.append(item)
            items = fixed
        out[key] = items
    return out


def catalog_payload_from_doc(doc: dict, *, public: bool = False) -> dict:
    """public=True 时过滤掉管理员下架（enabled=false）的条目。"""
    doc = normalize_catalog_doc(doc)
    if not public:
        return doc
    out = {"version": doc["version"]}
    for key in _SECTIONS:
        items = []
        for item in doc[key]:
            meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            if meta.get("enabled") is False:
                continue
            items.append(item)
        out[key] = items
    return out


async def load_community_catalog_doc() -> dict:
    raw = await db.get_config(CONFIG_KEY, "")
    if raw.strip():
        doc = _parse_json_or_yaml(raw)
        if doc:
            return normalize_catalog_doc(doc)
    return load_default_doc()


async def save_catalog_doc(doc: dict) -> None:
    payload = normalize_catalog_doc(doc)
    await db.set_config(CONFIG_KEY, json.dumps(payload, ensure_ascii=False, indent=2))


async def import_from_defaults() -> dict:
    doc = load_default_doc()
    await save_catalog_doc(doc)
    return {"ok": True, "counts": {k: len(doc[k]) for k in _SECTIONS}}


async def community_catalog_payload() -> dict:
    """公开下发：隐藏已下架条目。"""
    return catalog_payload_from_doc(await load_community_catalog_doc(), public=True)


async def publish_community_catalog() -> dict:
    doc = await load_community_catalog_doc()
    await save_catalog_doc(doc)
    return {"ok": True, "counts": {k: len(doc[k]) for k in _SECTIONS}}


def _item_catalog_id(item: dict) -> str:
    return str(item.get("catalog_id") or item.get("catalogId") or item.get("id") or "").strip()


def _slug_name(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(name or "").strip()).strip("-").lower()
    return (s or "skill")[:64]


async def get_pricing() -> dict:
    """纳管扣减 / 推荐奖励积分（后台可改）。"""
    install = float(await db.get_config(INSTALL_COST_KEY, str(DEFAULT_INSTALL_COST)))
    reward = float(await db.get_config(RECOMMEND_REWARD_KEY, str(DEFAULT_RECOMMEND_REWARD)))
    return {
        "install_cost": max(0.0, install),
        "recommend_reward": max(0.0, reward),
        "install_cost_key": INSTALL_COST_KEY,
        "recommend_reward_key": RECOMMEND_REWARD_KEY,
    }


async def set_pricing(*, install_cost: float | None = None, recommend_reward: float | None = None) -> dict:
    if install_cost is not None:
        await db.set_config(INSTALL_COST_KEY, str(max(0.0, float(install_cost))))
    if recommend_reward is not None:
        await db.set_config(RECOMMEND_REWARD_KEY, str(max(0.0, float(recommend_reward))))
    return await get_pricing()


def find_item(doc: dict, catalog_id: str) -> tuple[str | None, dict | None]:
    cid = str(catalog_id or "").strip()
    if not cid:
        return None, None
    for section in _SECTIONS:
        for item in doc.get(section) or []:
            if _item_catalog_id(item) == cid:
                return section, item
    return None, None


async def upsert_user_skill_recommendation(
    *,
    user_id: int,
    name: str,
    content: str,
    display_name: str = "",
    description: str = "",
    metadata: dict | None = None,
    recommender_email: str = "",
) -> dict:
    """用户推荐 skill 到社区目录（立即对他人可见，除非管理员下架）。"""
    name = str(name or "").strip()
    content = str(content or "").strip()
    if not name:
        raise ValueError("skill name 不能为空")
    if not content:
        raise ValueError("skill 正文不能为空")

    catalog_id = f"user-skill-{int(user_id)}-{_slug_name(name)}"
    doc = await load_community_catalog_doc()
    meta_in = metadata if isinstance(metadata, dict) else {}
    now_ms = int(time.time() * 1000)
    meta = {
        **{k: v for k, v in meta_in.items() if k not in (
            "user_recommended", "recommender_user_id", "recommended_at", "enabled",
        )},
        "user_recommended": True,
        "recommender_user_id": int(user_id),
        "recommended_at": now_ms,
        "enabled": True,
    }
    if recommender_email:
        meta["recommender_email"] = str(recommender_email)

    item = {
        "catalog_id": catalog_id,
        "type": "skill",
        "name": name,
        "display_name": (display_name or name).strip() or name,
        "description": str(description or "").strip(),
        "content": content,
        "metadata": meta,
    }

    skills = list(doc.get("skills") or [])
    replaced = False
    for i, old in enumerate(skills):
        if _item_catalog_id(old) == catalog_id:
            # 保留管理员下架状态
            old_meta = old.get("metadata") if isinstance(old.get("metadata"), dict) else {}
            if old_meta.get("enabled") is False:
                meta["enabled"] = False
            skills[i] = item
            replaced = True
            break
    if not replaced:
        skills.append(item)
    doc["skills"] = skills
    await save_catalog_doc(doc)
    return {"ok": True, "item": item, "updated": replaced}


async def list_user_recommendations() -> list[dict]:
    """管理员：用户推荐的 skill 列表。"""
    doc = await load_community_catalog_doc()
    out = []
    for item in doc.get("skills") or []:
        meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        if not meta.get("user_recommended"):
            continue
        out.append({
            **item,
            "catalog_id": _item_catalog_id(item),
            "enabled": meta.get("enabled") is not False,
            "recommender_user_id": meta.get("recommender_user_id"),
            "recommender_email": meta.get("recommender_email") or "",
            "recommended_at": meta.get("recommended_at"),
        })
    out.sort(key=lambda x: int(x.get("recommended_at") or 0), reverse=True)
    return out


async def set_item_enabled(catalog_id: str, enabled: bool) -> dict:
    """管理员上架/下架社区条目。"""
    doc = await load_community_catalog_doc()
    section, item = find_item(doc, catalog_id)
    if not item:
        raise ValueError("目录项不存在")
    meta = dict(item.get("metadata") if isinstance(item.get("metadata"), dict) else {})
    meta["enabled"] = bool(enabled)
    item = {**item, "metadata": meta}
    items = list(doc.get(section) or [])
    for i, old in enumerate(items):
        if _item_catalog_id(old) == _item_catalog_id(item):
            items[i] = item
            break
    doc[section] = items
    await save_catalog_doc(doc)
    return {"ok": True, "catalog_id": _item_catalog_id(item), "enabled": bool(enabled)}


async def remove_catalog_item(catalog_id: str) -> dict:
    """管理员删除社区目录条目。"""
    cid = str(catalog_id or "").strip()
    doc = await load_community_catalog_doc()
    found = False
    for section in _SECTIONS:
        before = list(doc.get(section) or [])
        after = [x for x in before if _item_catalog_id(x) != cid]
        if len(after) != len(before):
            doc[section] = after
            found = True
    if not found:
        raise ValueError("目录项不存在")
    await save_catalog_doc(doc)
    return {"ok": True, "catalog_id": cid}


def is_paid_community_item(item: dict | None) -> bool:
    """用户推荐且带推荐人 → 纳管需扣积分。"""
    if not item or not isinstance(item, dict):
        return False
    meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    if meta.get("user_recommended") and meta.get("recommender_user_id"):
        return True
    return False


async def settle_community_install(*, installer_id: int, catalog_id: str) -> dict:
    """纳管结算：用户推荐项扣安装人积分、奖推荐人；内置/官方免费；同用户重复不重复扣。"""
    cid = str(catalog_id or "").strip()
    if not cid:
        raise ValueError("catalog_id 不能为空")

    doc = await load_community_catalog_doc()
    _, item = find_item(doc, cid)
    if not item:
        raise ValueError("目录项不存在")
    meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    if meta.get("enabled") is False:
        raise ValueError("该推荐已下架")

    pricing = await get_pricing()
    install_cost = float(pricing["install_cost"])
    reward = float(pricing["recommend_reward"])

    if not is_paid_community_item(item):
        return {
            "ok": True,
            "charged": False,
            "free": True,
            "install_cost": 0,
            "recommend_reward": 0,
            "catalog_id": cid,
            "item": item,
        }

    recommender_id = int(meta.get("recommender_user_id") or 0)
    # 自己纳管自己的推荐：不计费
    if recommender_id and recommender_id == int(installer_id):
        return {
            "ok": True,
            "charged": False,
            "free": True,
            "self": True,
            "install_cost": 0,
            "recommend_reward": 0,
            "catalog_id": cid,
            "item": item,
        }

    existing = await db.get_community_catalog_install(installer_id, cid)
    if existing:
        return {
            "ok": True,
            "charged": False,
            "already_paid": True,
            "install_cost": float(existing.get("credits_charged") or 0),
            "recommend_reward": float(existing.get("credits_awarded") or 0),
            "catalog_id": cid,
            "item": item,
        }

    charged = 0.0
    awarded = 0.0
    new_balance = None
    if install_cost > 0:
        ok, bal = await db.deduct_credits(
            installer_id, install_cost,
            model_name=f"community-skill:{cid}",
            tier="community",
        )
        if not ok:
            raise PermissionError(f"积分不足（需要 {install_cost:g}，当前 {bal:g}）")
        charged = install_cost
        new_balance = bal

    if reward > 0 and recommender_id and recommender_id != int(installer_id):
        await db.award_credits(
            recommender_id, reward,
            type_="contribute",
            model_name=f"community-skill:{cid}",
            note=f"社区 skill 被纳管奖励（安装人 #{installer_id}）",
        )
        awarded = reward

    await db.record_community_catalog_install(
        user_id=installer_id,
        catalog_id=cid,
        recommender_id=recommender_id or None,
        credits_charged=charged,
        credits_awarded=awarded,
    )
    return {
        "ok": True,
        "charged": charged > 0,
        "install_cost": charged,
        "recommend_reward": awarded,
        "balance": new_balance,
        "catalog_id": cid,
        "recommender_user_id": recommender_id or None,
        "item": item,
    }

"""社区推荐目录 —— 通过 GET /api/community-catalog 下发给客户端。

四段:mcp / prompts / skills / assistants。
默认数据源:
  - mcp:       复用 client/electron/config/mcp-catalog.yaml 的 items(仿 routing_catalog 读 client 文件)
  - 其余三段:  static/defaults/community-resources.yaml
DB config.community_catalog 可整体覆盖默认。
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import database as db

CONFIG_KEY = "config.community_catalog"
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
        out[key] = [x for x in val if isinstance(x, dict)] if isinstance(val, list) else []
    return out


def catalog_payload_from_doc(doc: dict) -> dict:
    return normalize_catalog_doc(doc)

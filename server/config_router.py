"""Config distribution endpoints.

Admin uploads tool/route config YAML → stored in system_config table.
Authenticated users GET the config YAML → client applies it locally.

Keys in system_config:
  config.apps   → tokenbank.tools.yaml content (tools/protocols/routing)
  config.scenes  → tokenbank.routes.yaml content (scene_routes)
"""

import os
import yaml as _yaml
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from typing import Optional

import database as db
from auth import get_current_user_id
from admin_router import auth_admin   # reuse existing admin bearer auth

router = APIRouter()


class _IndentDumper(_yaml.Dumper):
    """Force block sequences to indent under their parent key.

    PyYAML's default emits compact notation (list items at col 0) which
    js-yaml 4.x rejects with "bad indentation of a mapping entry".
    """
    def increase_indent(self, flow=False, indentless=False):
        return super().increase_indent(flow, False)


def _normalize_yaml(text: str) -> str:
    try:
        parsed = _yaml.safe_load(text)
        if parsed is None:
            return text
        return _yaml.dump(
            parsed, Dumper=_IndentDumper,
            allow_unicode=True, sort_keys=False, default_flow_style=False,
        ).rstrip()
    except Exception:
        return text

# ── Schemas ────────────────────────────────────────────────────────────────────

class ConfigUploadBody(BaseModel):
    content: str          # raw YAML text

# ── Admin: upload config files ─────────────────────────────────────────────────

@router.put("/config/apps", dependencies=[Depends(auth_admin)])
async def upload_tools_config(body: ConfigUploadBody):
    """Admin uploads the tools config YAML (tools / protocols / routing sections)."""
    if not body.content or not body.content.strip():
        raise HTTPException(400, "content must not be empty")
    await db.set_config("config.apps", body.content.strip())
    return {"ok": True, "key": "config.apps", "bytes": len(body.content)}


@router.put("/config/scenes", dependencies=[Depends(auth_admin)])
async def upload_routes_config(body: ConfigUploadBody):
    """Admin uploads the routes config YAML (scene_routes section)."""
    if not body.content or not body.content.strip():
        raise HTTPException(400, "content must not be empty")
    await db.set_config("config.scenes", body.content.strip())
    return {"ok": True, "key": "config.scenes", "bytes": len(body.content)}


@router.get("/config/info", dependencies=[Depends(auth_admin)])
async def config_info():
    """Admin: check which config files have been uploaded and their sizes."""
    tools  = await db.get_config("config.apps",  "")
    routes = await db.get_config("config.scenes", "")
    return {
        "tools":  {"uploaded": bool(tools),  "bytes": len(tools)},
        "routes": {"uploaded": bool(routes), "bytes": len(routes)},
    }


# 管理员读取已上传的源内容（用于后台编辑器「加载」按钮，鉴权用 admin key，
# 区别于客户端下载用的 /config/apps|scenes 需用户 JWT）
@router.get("/config/apps/source", dependencies=[Depends(auth_admin)])
async def get_apps_source():
    return {"content": await db.get_config("config.apps", "")}


@router.get("/config/scenes/source", dependencies=[Depends(auth_admin)])
async def get_scenes_source():
    return {"content": await db.get_config("config.scenes", "")}


@router.delete("/config/apps", dependencies=[Depends(auth_admin)])
async def delete_tools_config():
    await db.set_config("config.apps", "")
    return {"ok": True}


@router.delete("/config/scenes", dependencies=[Depends(auth_admin)])
async def delete_routes_config():
    await db.set_config("config.scenes", "")
    return {"ok": True}


# ── User: download config files ─────────────────────────────────────────────────
# Requires valid user JWT (same token used for P2P / scene-routes).
# Returns raw YAML text with Content-Type: text/plain so clients can
# parse it directly without extra unwrapping.

from fastapi.responses import PlainTextResponse

@router.get("/config/apps")
async def get_tools_config(uid: int = Depends(get_current_user_id)):
    """Authenticated user downloads the tools config YAML."""
    content = await db.get_config("config.apps", "")
    if not content:
        raise HTTPException(404, "Tools config not uploaded yet")
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")


@router.get("/config/scenes")
async def get_routes_config(uid: int = Depends(get_current_user_id)):
    """Authenticated user downloads the routes config YAML."""
    content = await db.get_config("config.scenes", "")
    if not content:
        raise HTTPException(404, "Routes config not uploaded yet")
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")

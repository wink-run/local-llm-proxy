"""Config distribution endpoints.

Admin uploads tool/route config YAML → stored in system_config table.
Authenticated users GET the config YAML → client applies it locally.

Keys in system_config:
  config.tools   → tokenbank.tools.yaml content (tools/protocols/routing)
  config.routes  → tokenbank.routes.yaml content (scene_routes)
"""

import os
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from typing import Optional

import database as db
from auth import get_current_user_id
from admin_router import auth_admin   # reuse existing admin bearer auth

router = APIRouter()

# ── Schemas ────────────────────────────────────────────────────────────────────

class ConfigUploadBody(BaseModel):
    content: str          # raw YAML text

# ── Admin: upload config files ─────────────────────────────────────────────────

@router.put("/config/tools", dependencies=[Depends(auth_admin)])
async def upload_tools_config(body: ConfigUploadBody):
    """Admin uploads the tools config YAML (tools / protocols / routing sections)."""
    if not body.content or not body.content.strip():
        raise HTTPException(400, "content must not be empty")
    await db.set_config("config.tools", body.content.strip())
    return {"ok": True, "key": "config.tools", "bytes": len(body.content)}


@router.put("/config/routes", dependencies=[Depends(auth_admin)])
async def upload_routes_config(body: ConfigUploadBody):
    """Admin uploads the routes config YAML (scene_routes section)."""
    if not body.content or not body.content.strip():
        raise HTTPException(400, "content must not be empty")
    await db.set_config("config.routes", body.content.strip())
    return {"ok": True, "key": "config.routes", "bytes": len(body.content)}


@router.get("/config/info", dependencies=[Depends(auth_admin)])
async def config_info():
    """Admin: check which config files have been uploaded and their sizes."""
    tools  = await db.get_config("config.tools",  "")
    routes = await db.get_config("config.routes", "")
    return {
        "tools":  {"uploaded": bool(tools),  "bytes": len(tools)},
        "routes": {"uploaded": bool(routes), "bytes": len(routes)},
    }


@router.delete("/config/tools", dependencies=[Depends(auth_admin)])
async def delete_tools_config():
    await db.set_config("config.tools", "")
    return {"ok": True}


@router.delete("/config/routes", dependencies=[Depends(auth_admin)])
async def delete_routes_config():
    await db.set_config("config.routes", "")
    return {"ok": True}


# ── User: download config files ─────────────────────────────────────────────────
# Requires valid user JWT (same token used for P2P / scene-routes).
# Returns raw YAML text with Content-Type: text/plain so clients can
# parse it directly without extra unwrapping.

from fastapi.responses import PlainTextResponse

@router.get("/config/tools")
async def get_tools_config(uid: int = Depends(get_current_user_id)):
    """Authenticated user downloads the tools config YAML."""
    content = await db.get_config("config.tools", "")
    if not content:
        raise HTTPException(404, "Tools config not uploaded yet")
    return PlainTextResponse(content, media_type="text/yaml; charset=utf-8")


@router.get("/config/routes")
async def get_routes_config(uid: int = Depends(get_current_user_id)):
    """Authenticated user downloads the routes config YAML."""
    content = await db.get_config("config.routes", "")
    if not content:
        raise HTTPException(404, "Routes config not uploaded yet")
    return PlainTextResponse(content, media_type="text/yaml; charset=utf-8")

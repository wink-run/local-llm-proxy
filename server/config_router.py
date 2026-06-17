"""Config distribution endpoints.

Admin uploads tool/route config YAML → stored in system_config table.
Authenticated users GET the config YAML → client applies it locally.

Keys in system_config:
  config.apps   → tokenbank.tools.yaml content (tools/protocols/routing/billing)
  config.scenes  → tokenbank.routes.yaml content (scene_routes)
"""

import os
import re
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from typing import Optional

import database as db
from auth import get_current_user_id
from admin_router import auth_admin   # reuse existing admin bearer auth
from config_merge import merge_apps_yaml_text

router = APIRouter()


def _normalize_yaml(text: str) -> str:
    """Ensure block sequences are indented under their parent mapping key.

    PyYAML emits compact notation (list items at col 0) which js-yaml 4.x
    rejects. Try PyYAML re-dump; fall back to a line-level text fix.
    """
    try:
        import yaml

        class _D(yaml.Dumper):
            def increase_indent(self, flow=False, indentless=False):
                return super().increase_indent(flow, False)

        parsed = yaml.safe_load(text)
        if parsed is None:
            return text
        return yaml.dump(
            parsed, Dumper=_D,
            allow_unicode=True, sort_keys=False, default_flow_style=False,
        ).rstrip()
    except ImportError:
        pass
    except Exception:
        return text

    # PyYAML not available — fix only the specific pattern js-yaml rejects:
    # a sequence item "^- " appearing at indent <= its parent mapping key indent.
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        stripped = line.rstrip()
        # Mapping key with no inline value (e.g. "scene_routes:")
        m = re.match(r'^(\s*)(\S[^:]*)\s*:\s*$', stripped)
        if m:
            key_indent = len(m.group(1))
            # Look ahead: next non-empty line
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines):
                next_line = lines[j]
                next_indent = len(next_line) - len(next_line.lstrip())
                if next_line.lstrip().startswith('- ') and next_indent <= key_indent:
                    # Collect and re-indent the whole sequence block
                    add = key_indent + 2 - next_indent
                    while j < len(lines):
                        l = lines[j]
                        if l.strip() == '':
                            out.append(l)
                            j += 1
                            continue
                        cur_indent = len(l) - len(l.lstrip())
                        if cur_indent < next_indent:
                            break  # back to parent level
                        out.append(' ' * add + l)
                        j += 1
                    i = j
                    continue
        i += 1
    return '\n'.join(out)

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
    # 与内置默认合并，确保客户端拉取到 subscription_to_api 等新字段
    content = merge_apps_yaml_text(content)
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")


@router.get("/config/scenes")
async def get_routes_config(uid: int = Depends(get_current_user_id)):
    """Authenticated user downloads the routes config YAML."""
    content = await db.get_config("config.scenes", "")
    if not content:
        raise HTTPException(404, "Routes config not uploaded yet")
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")

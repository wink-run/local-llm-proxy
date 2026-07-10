"""Config download endpoints.

Config is written to system_config by the「应用管理 / 路由管理 / 个人源」admin
tabs via their own publish endpoints (app_catalog / routing_catalog /
billing_sources). Here we only serve it back: authenticated clients GET the
config YAML and apply it locally.

Keys in system_config:
  config.apps    → tokenbank.yaml content (gateway / mitm / app_entities)
  config.providers → providers.registry.yaml (供给源 registry + billing_sources，客户端唯一源目录)
  config.scenes  → tokenbank.routes.yaml content (scene_routes)
"""

import os
import re
import yaml
from fastapi import APIRouter, Depends, HTTPException

import database as db
from auth import get_current_user_id
from config_merge import merge_apps_yaml_text, merge_providers_yaml_text, merge_sources_yaml_text

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

# 说明：config.apps / config.scenes 由「应用管理 / 路由管理」标签页各自的
# publish 端点写入（app_catalog / routing_catalog），此处只保留客户端下载。
# 旧的「配置下发」管理员上传/删除端点已随该标签一并移除。

# ── Public / user: download config files ────────────────────────────────────────
# GET /config/apps 为公开目录（无需登录）；sources / scenes 仍需用户 JWT。

from fastapi.responses import PlainTextResponse

@router.get("/config/apps")
async def get_tools_config():
    """公开：下载应用目录 YAML（gateway / mitm / app_entities），无需登录。"""
    content = await db.get_config("config.apps", "")
    content = merge_apps_yaml_text(content)
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")


@router.get("/config/providers")
async def get_providers_config(uid: int = Depends(get_current_user_id)):
    """Authenticated user downloads providers.registry.yaml（供给源 registry + billing_sources 模板列表）。"""
    content = await db.get_config("config.providers", "")
    content = merge_providers_yaml_text(content)
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")


@router.get("/config/sources")
async def get_sources_config(uid: int = Depends(get_current_user_id)):
    """[deprecated] 由 config.providers.billing_sources 编译旧四段；请用 GET /config/providers。"""
    import billing_sources as bs

    prov_raw = await db.get_config("config.providers", "")
    if prov_raw.strip():
        try:
            prov = yaml.safe_load(prov_raw) or {}
            bs_list = prov.get("billing_sources") or []
            if bs_list:
                content = bs.legacy_sources_yaml_from_billing_sources(bs_list)
                return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")
        except yaml.YAMLError:
            pass
    content = await db.get_config("config.sources", "")
    content = merge_sources_yaml_text(content)
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")


@router.get("/config/scenes")
async def get_routes_config(uid: int = Depends(get_current_user_id)):
    """Authenticated user downloads the routes config YAML."""
    content = await db.get_config("config.scenes", "")
    if not content:
        raise HTTPException(404, "Routes config not uploaded yet")
    return PlainTextResponse(_normalize_yaml(content), media_type="text/yaml; charset=utf-8")

"""Scene routes CRUD + key binding endpoints."""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

import database as db
from auth import get_current_user_id

router = APIRouter()

_CAVEMAN_LEVELS = {None, 'lite', 'full', 'ultra'}


class SceneRouteBody(BaseModel):
    scene_name: str
    icon: str = "🔀"
    steps: list
    caveman_level: Optional[str] = None
    rules: Optional[list] = None          # 条件规则(token/关键字)——存全，不丢
    classifier: Optional[dict] = None     # 语义分类器配置
    flow: Optional[str] = None            # 链级流转策略

    @field_validator('caveman_level')
    @classmethod
    def validate_caveman(cls, v):
        if v not in _CAVEMAN_LEVELS:
            raise ValueError(f"caveman_level must be one of {sorted(str(x) for x in _CAVEMAN_LEVELS if x)!r} or null")
        return v


class BindKeyBody(BaseModel):
    scene_route_id: Optional[int] = None
    app_name: str = ""


def _parse_route_json(r: dict) -> dict:
    """DB 行里 steps/rules/classifier 是 JSON 文本 → 解析回对象。"""
    for k in ("steps", "rules", "classifier"):
        if isinstance(r.get(k), str):
            try:
                r[k] = json.loads(r[k])
            except (ValueError, TypeError):
                pass
    return r


@router.get("/scene-routes")
async def list_routes(uid: int = Depends(get_current_user_id)):
    routes = [_parse_route_json(r) for r in await db.list_scene_routes(uid)]
    return {"routes": routes}


@router.post("/scene-routes")
async def create_route(body: SceneRouteBody, uid: int = Depends(get_current_user_id)):
    route = await db.create_scene_route(uid, body.scene_name, body.icon, body.steps,
                                        caveman_level=body.caveman_level,
                                        rules=body.rules, classifier=body.classifier, flow=body.flow)
    return _parse_route_json(route)


@router.put("/scene-routes/{route_id}")
async def update_route(route_id: int, body: SceneRouteBody, uid: int = Depends(get_current_user_id)):
    ok = await db.update_scene_route(route_id, uid, body.scene_name, body.icon, body.steps,
                                     caveman_level=body.caveman_level,
                                     rules=body.rules, classifier=body.classifier, flow=body.flow)
    if not ok:
        raise HTTPException(404, "Route not found")
    return {"ok": True}


@router.delete("/scene-routes/{route_id}")
async def delete_route(route_id: int, uid: int = Depends(get_current_user_id)):
    ok = await db.delete_scene_route(route_id, uid)
    if not ok:
        raise HTTPException(404, "Route not found")
    return {"ok": True}


@router.get("/keys-with-scene")
async def keys_with_scene(uid: int = Depends(get_current_user_id)):
    keys = await db.list_keys_with_scene(uid)
    for k in keys:
        if k.get("steps") and isinstance(k["steps"], str):
            k["steps"] = json.loads(k["steps"])
    return {"keys": keys}


@router.put("/keys/{key_id}/bind-scene")
async def bind_scene(key_id: int, body: BindKeyBody, uid: int = Depends(get_current_user_id)):
    ok = await db.bind_key_to_scene_route(key_id, uid, body.scene_route_id, body.app_name)
    if not ok:
        raise HTTPException(404, "Key not found or not owned by you")
    return {"ok": True}

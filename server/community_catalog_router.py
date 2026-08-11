"""Admin API：社区推荐目录发布 / 积分额度 / 用户推荐管理。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import community_catalog as cc
from admin_router import auth_admin

router = APIRouter()


@router.post("/community-catalog/import-defaults", dependencies=[Depends(auth_admin)])
async def import_community_defaults():
    return await cc.import_from_defaults()


@router.post("/community-catalog/publish", dependencies=[Depends(auth_admin)])
async def publish_community_catalog():
    return await cc.publish_community_catalog()


@router.get("/community-catalog", dependencies=[Depends(auth_admin)])
async def get_community_catalog():
    """完整目录（含已下架）。"""
    doc = await cc.load_community_catalog_doc()
    return {"ok": True, "catalog": doc, "counts": {k: len(doc[k]) for k in ("mcp", "prompts", "skills", "assistants")}}


@router.get("/community-catalog/pricing", dependencies=[Depends(auth_admin)])
async def get_community_pricing():
    return await cc.get_pricing()


class PricingRequest(BaseModel):
    install_cost: float | None = None
    recommend_reward: float | None = None


@router.put("/community-catalog/pricing", dependencies=[Depends(auth_admin)])
async def put_community_pricing(req: PricingRequest):
    """修改纳管扣减 / 推荐奖励积分。"""
    if req.install_cost is None and req.recommend_reward is None:
        raise HTTPException(400, "请至少提供 install_cost 或 recommend_reward")
    return await cc.set_pricing(
        install_cost=req.install_cost,
        recommend_reward=req.recommend_reward,
    )


@router.get("/community-catalog/recommendations", dependencies=[Depends(auth_admin)])
async def list_recommendations():
    """用户推荐的 skill 列表（可上架/下架/删除）。"""
    items = await cc.list_user_recommendations()
    pricing = await cc.get_pricing()
    return {"ok": True, "items": items, "pricing": pricing}


class EnableRequest(BaseModel):
    enabled: bool


@router.patch("/community-catalog/items/{catalog_id}", dependencies=[Depends(auth_admin)])
async def patch_catalog_item(catalog_id: str, req: EnableRequest):
    try:
        return await cc.set_item_enabled(catalog_id, req.enabled)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


@router.delete("/community-catalog/items/{catalog_id}", dependencies=[Depends(auth_admin)])
async def delete_catalog_item(catalog_id: str):
    try:
        return await cc.remove_catalog_item(catalog_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e

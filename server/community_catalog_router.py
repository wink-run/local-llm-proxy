"""Admin API：社区推荐目录发布 / 从默认导入。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

import community_catalog as cc
from admin_router import auth_admin

router = APIRouter()


@router.post("/community-catalog/import-defaults", dependencies=[Depends(auth_admin)])
async def import_community_defaults():
    return await cc.import_from_defaults()


@router.post("/community-catalog/publish", dependencies=[Depends(auth_admin)])
async def publish_community_catalog():
    return await cc.publish_community_catalog()

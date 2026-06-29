"""Admin API：个人源目录表单 CRUD + 发布。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import billing_sources as bs
from admin_router import auth_admin

router = APIRouter()


class SourceBody(BaseModel):
    source: dict


class SourcesDocBody(BaseModel):
    sources: list[dict]


@router.get("/billing/sources", dependencies=[Depends(auth_admin)])
async def list_billing_sources():
    doc = await bs.load_sources_doc()
    return {
        "version": doc.get("version") or 1,
        "sources": bs.list_sources_normalized(doc),
        "categories": list(bs.CATEGORIES),
        "tiers": list(bs.TIERS),
        "auth_methods": list(bs.AUTH_METHODS),
        "api_formats": list(bs.API_FORMATS),
        "modalities": list(bs.MODALITIES),
    }


@router.post("/billing/sources/import-legacy", dependencies=[Depends(auth_admin)])
async def import_legacy_sources():
    """首次从默认配置导入并持久化到 DB；返回完整列表供前端直接使用。"""
    sources = bs.import_from_legacy()
    doc = {"version": 1, "sources": sources}
    await bs.save_sources_doc(doc)
    # 写后读回，确保持久化成功
    saved = await bs.load_sources_doc()
    normalized = bs.list_sources_normalized(saved)
    if not normalized:
        raise HTTPException(500, "导入失败：未能写入数据库")
    return {"ok": True, "count": len(normalized), "sources": normalized}


@router.post("/billing/sources/publish", dependencies=[Depends(auth_admin)])
async def publish_billing_sources():
    doc = await bs.load_sources_doc()
    stats = await bs.publish_sources(doc)
    return {"ok": True, **stats}


@router.get("/billing/sources/{source_id}", dependencies=[Depends(auth_admin)])
async def get_billing_source(source_id: str):
    doc = await bs.load_sources_doc()
    for s in bs.list_sources_normalized(doc):
        if s["id"] == source_id:
            return s
    raise HTTPException(404, "not found")


@router.post("/billing/sources", dependencies=[Depends(auth_admin)])
async def create_billing_source(body: SourceBody):
    s = bs.normalize_source(body.source)
    bs.validate_source(s)
    doc = await bs.load_sources_doc()
    if any(x.get("id") == s["id"] for x in doc.get("sources") or []):
        raise HTTPException(409, "id 已存在")
    doc.setdefault("sources", []).append(s)
    await bs.save_sources_doc(doc)
    return {"ok": True, "source": s}


@router.put("/billing/sources/{source_id}", dependencies=[Depends(auth_admin)])
async def update_billing_source(source_id: str, body: SourceBody):
    s = bs.normalize_source({**body.source, "id": source_id})
    bs.validate_source(s)
    doc = await bs.load_sources_doc()
    items = doc.get("sources") or []
    idx = next((i for i, x in enumerate(items) if x.get("id") == source_id), -1)
    if idx < 0:
        raise HTTPException(404, "not found")
    items[idx] = s
    doc["sources"] = items
    await bs.save_sources_doc(doc)
    return {"ok": True, "source": s}


@router.delete("/billing/sources/{source_id}", dependencies=[Depends(auth_admin)])
async def delete_billing_source(source_id: str):
    doc = await bs.load_sources_doc()
    before = len(doc.get("sources") or [])
    doc["sources"] = [x for x in (doc.get("sources") or []) if x.get("id") != source_id]
    if len(doc["sources"]) == before:
        raise HTTPException(404, "not found")
    await bs.save_sources_doc(doc)
    return {"ok": True}


@router.put("/billing/sources-bulk", dependencies=[Depends(auth_admin)])
async def replace_billing_sources(body: SourcesDocBody):
    doc = {"version": 1, "sources": []}
    for raw in body.sources:
        s = bs.normalize_source(raw)
        bs.validate_source(s)
        doc["sources"].append(s)
    await bs.save_sources_doc(doc)
    return {"ok": True, "count": len(doc["sources"])}



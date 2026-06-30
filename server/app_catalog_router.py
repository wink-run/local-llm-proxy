"""Admin API：应用实体目录 CRUD + 发布。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import app_catalog as ac
import app_handlers as ah
from admin_router import auth_admin

router = APIRouter()


class EntityBody(BaseModel):
    entity: dict


@router.get("/apps/catalog", dependencies=[Depends(auth_admin)])
async def list_app_catalog():
    doc = await ac.load_catalog_doc()
    entities = []
    for e in (doc.get("entities") or []):
        norm = ac.normalize_entity(e)
        summary = ac.entity_summary_fields(norm)
        entities.append({**norm, **summary})
    return {
        "version": doc.get("version") or 1,
        "entities": entities,
        "handlers": ah.list_handlers_meta(),
        "capability_catalog": ah.load_handlers_doc().get("capability_catalog") or {},
        "var_schema": ah.load_handlers_doc().get("var_schema") or {},
    }


@router.post("/apps/catalog/import-defaults", dependencies=[Depends(auth_admin)])
async def import_app_defaults():
    doc = ac.import_from_defaults()
    await ac.save_catalog_doc(doc)
    return {"ok": True, "count": len(doc.get("entities") or []), "entities": doc.get("entities") or []}


@router.post("/apps/catalog/publish", dependencies=[Depends(auth_admin)])
async def publish_app_catalog():
    doc = await ac.load_catalog_doc()
    stats = await ac.publish_catalog(doc)
    return {"ok": True, **stats}


@router.post("/apps/catalog/export-defaults", dependencies=[Depends(auth_admin)])
async def export_app_defaults():
    doc = await ac.load_catalog_doc()
    result = ac.export_to_defaults(doc)
    if not result.get("ok"):
        raise HTTPException(500, result.get("error") or "export failed")
    return {"ok": True, "files": [result]}


@router.post("/apps/catalog/entities", dependencies=[Depends(auth_admin)])
async def create_entity(body: EntityBody):
    e = ac.normalize_entity(body.entity)
    ac.validate_entity(e)
    doc = await ac.load_catalog_doc()
    if any(x.get("id") == e["id"] for x in doc.get("entities") or []):
        raise HTTPException(409, "id 已存在")
    doc.setdefault("entities", []).append(e)
    await ac.save_catalog_doc(doc)
    return {"ok": True, "entity": e}


@router.put("/apps/catalog/entities/{entity_id}", dependencies=[Depends(auth_admin)])
async def update_entity(entity_id: str, body: EntityBody):
    e = ac.normalize_entity({**body.entity, "id": entity_id})
    ac.validate_entity(e)
    doc = await ac.load_catalog_doc()
    items = doc.get("entities") or []
    idx = next((i for i, x in enumerate(items) if x.get("id") == entity_id), -1)
    if idx < 0:
        raise HTTPException(404, "not found")
    items[idx] = e
    doc["entities"] = items
    await ac.save_catalog_doc(doc)
    return {"ok": True, "entity": e}


@router.delete("/apps/catalog/entities/{entity_id}", dependencies=[Depends(auth_admin)])
async def delete_entity(entity_id: str):
    doc = await ac.load_catalog_doc()
    before = len(doc.get("entities") or [])
    doc["entities"] = [x for x in (doc.get("entities") or []) if x.get("id") != entity_id]
    if len(doc["entities"]) == before:
        raise HTTPException(404, "not found")
    await ac.save_catalog_doc(doc)
    return {"ok": True}

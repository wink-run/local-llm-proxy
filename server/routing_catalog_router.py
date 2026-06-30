"""Admin API：场景路由目录表单 CRUD + 发布。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import routing_catalog as rc
from admin_router import auth_admin

router = APIRouter()


class RouteBody(BaseModel):
    route: dict


@router.get("/routing/catalog", dependencies=[Depends(auth_admin)])
async def list_routing_catalog():
    doc = await rc.load_catalog_doc()
    return {
        "version": doc.get("version") or 1,
        "routes": [rc.normalize_route(r) for r in (doc.get("routes") or [])],
        "tiers": list(rc.TIERS),
    }


@router.post("/routing/catalog/import-defaults", dependencies=[Depends(auth_admin)])
async def import_routing_defaults():
    doc = rc.import_from_defaults()
    await rc.save_catalog_doc(doc)
    return {"ok": True, "count": len(doc.get("routes") or [])}


@router.post("/routing/catalog/publish", dependencies=[Depends(auth_admin)])
async def publish_routing_catalog():
    doc = await rc.load_catalog_doc()
    stats = await rc.publish_catalog(doc)
    return {"ok": True, **stats}


@router.post("/routing/catalog/export-defaults", dependencies=[Depends(auth_admin)])
async def export_routing_defaults():
    doc = await rc.load_catalog_doc()
    result = rc.export_to_defaults(doc)
    if not result.get("ok"):
        raise HTTPException(500, result.get("error") or "export failed")
    return {"ok": True, "files": [result]}


@router.post("/routing/catalog/routes", dependencies=[Depends(auth_admin)])
async def create_route(body: RouteBody):
    r = rc.normalize_route(body.route)
    rc.validate_route(r)
    doc = await rc.load_catalog_doc()
    if any(x.get("id") == r["id"] for x in doc.get("routes") or []):
        raise HTTPException(409, "id 已存在")
    doc.setdefault("routes", []).append(r)
    await rc.save_catalog_doc(doc)
    return {"ok": True, "route": r}


@router.put("/routing/catalog/routes/{route_id}", dependencies=[Depends(auth_admin)])
async def update_route(route_id: str, body: RouteBody):
    r = rc.normalize_route({**body.route, "id": route_id})
    rc.validate_route(r)
    doc = await rc.load_catalog_doc()
    items = doc.get("routes") or []
    idx = next((i for i, x in enumerate(items) if x.get("id") == route_id), -1)
    if idx < 0:
        raise HTTPException(404, "not found")
    items[idx] = r
    doc["routes"] = items
    await rc.save_catalog_doc(doc)
    return {"ok": True, "route": r}


@router.delete("/routing/catalog/routes/{route_id}", dependencies=[Depends(auth_admin)])
async def delete_route(route_id: str):
    doc = await rc.load_catalog_doc()
    before = len(doc.get("routes") or [])
    doc["routes"] = [x for x in (doc.get("routes") or []) if x.get("id") != route_id]
    if len(doc["routes"]) == before:
        raise HTTPException(404, "not found")
    await rc.save_catalog_doc(doc)
    return {"ok": True}

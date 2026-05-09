import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

import database as db
from dispatch import handle_chat
from worker_pool import pool

ADMIN_KEY = os.getenv("ADMIN_KEY", "change-me-admin")
_bearer = HTTPBearer()

router = APIRouter()


def auth_admin(creds: HTTPAuthorizationCredentials = Depends(_bearer)):
    if creds.credentials != ADMIN_KEY:
        raise HTTPException(401, "Invalid admin key")


@router.get("/ui")
async def admin_ui():
    return FileResponse("static/admin.html")


@router.get("/workers", dependencies=[Depends(auth_admin)])
async def get_workers():
    return {"workers": pool.list_workers()}


@router.get("/keys", dependencies=[Depends(auth_admin)])
async def get_keys():
    return {"keys": await db.list_keys()}


class CreateKeyRequest(BaseModel):
    note: str = ""


@router.post("/keys", dependencies=[Depends(auth_admin)])
async def create_key(req: CreateKeyRequest):
    return await db.create_key(req.note)


class UpdateKeyRequest(BaseModel):
    is_active: bool


@router.patch("/keys/{key_id}", dependencies=[Depends(auth_admin)])
async def update_key(key_id: int, req: UpdateKeyRequest):
    await db.set_key_active(key_id, req.is_active)
    return {"ok": True}


@router.delete("/keys/{key_id}", dependencies=[Depends(auth_admin)])
async def remove_key(key_id: int):
    await db.delete_key(key_id)
    return {"ok": True}


from fastapi import Request


@router.post("/debug/chat", dependencies=[Depends(auth_admin)])
async def debug_chat(request: Request):
    return await handle_chat(await request.json())

"""管理员接口：Worker 列表、API Key、模型配置、用户管理、购买审批、系统配置"""

import os

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import database as db
from dispatch import handle_chat
from worker_pool import pool

ADMIN_KEY = os.getenv("ADMIN_KEY", "change-me-admin")


async def _sync_virtual_pool() -> None:
    """从数据库重新加载所有启用的虚拟 Agent 到 pool。"""
    agents = await db.list_virtual_agents(enabled_only=True)
    pool.sync_virtual(agents)
_bearer = HTTPBearer()
router = APIRouter()


def auth_admin(creds: HTTPAuthorizationCredentials = Depends(_bearer)):
    if creds.credentials != ADMIN_KEY:
        raise HTTPException(401, "Invalid admin key")


# ── UI ────────────────────────────────────────────────────────────────────────

@router.get("/ui")
async def admin_ui():
    return FileResponse("static/admin.html")


# ── Worker 列表 ───────────────────────────────────────────────────────────────

@router.get("/workers", dependencies=[Depends(auth_admin)])
async def get_workers():
    return {"workers": pool.list_workers()}


# ── API Keys（管理员全局视角）─────────────────────────────────────────────────

@router.get("/keys", dependencies=[Depends(auth_admin)])
async def get_keys():
    return {"keys": await db.list_keys()}


class CreateKeyRequest(BaseModel):
    note: str = ""


@router.post("/keys", dependencies=[Depends(auth_admin)])
async def create_key(req: CreateKeyRequest):
    return await db.create_key(req.note, user_id=None)


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


# ── 调试对话 ──────────────────────────────────────────────────────────────────

@router.post("/debug/chat", dependencies=[Depends(auth_admin)])
async def debug_chat(request: Request):
    return await handle_chat(await request.json())


# ── 模型配置 ──────────────────────────────────────────────────────────────────

@router.get("/models", dependencies=[Depends(auth_admin)])
async def list_models():
    return {"models": await db.list_model_configs()}


class ModelConfigRequest(BaseModel):
    name: str
    display_name: str = ""
    tier: str = "open"          # premium / open
    contribute_rate: float = 8
    consume_rate: float = 5
    enabled: bool = True


@router.post("/models", dependencies=[Depends(auth_admin)])
async def upsert_model(req: ModelConfigRequest):
    if req.tier not in ("premium", "open"):
        raise HTTPException(400, "tier 必须是 premium 或 open")
    return await db.upsert_model_config(
        req.name, req.display_name, req.tier,
        req.contribute_rate, req.consume_rate, req.enabled,
    )


@router.delete("/models/{name}", dependencies=[Depends(auth_admin)])
async def delete_model(name: str):
    await db.delete_model_config(name)
    return {"ok": True}


# ── 用户管理 ──────────────────────────────────────────────────────────────────

@router.get("/users", dependencies=[Depends(auth_admin)])
async def list_users():
    return {"users": await db.list_users()}


class UpdateUserRequest(BaseModel):
    can_create_apikey: bool | None = None
    credit_delta: float | None = None
    credit_note: str = ""


@router.patch("/users/{user_id}", dependencies=[Depends(auth_admin)])
async def update_user(user_id: int, req: UpdateUserRequest):
    if req.can_create_apikey is not None:
        await db.set_user_apikey_permission(user_id, req.can_create_apikey)
    if req.credit_delta is not None:
        new_bal = await db.adjust_user_credits(user_id, req.credit_delta, req.credit_note)
        return {"ok": True, "new_balance": new_bal}
    return {"ok": True}


# ── 购买审批 ──────────────────────────────────────────────────────────────────

@router.get("/purchase-orders", dependencies=[Depends(auth_admin)])
async def list_orders(status: str = ""):
    return {"orders": await db.list_purchase_orders(status or None)}


class ApproveRequest(BaseModel):
    admin_note: str = ""
    grant_apikey: bool = False      # 是否同时开通 API Key 创建权限


@router.post("/purchase-orders/{order_id}/approve", dependencies=[Depends(auth_admin)])
async def approve_order(order_id: int, req: ApproveRequest):
    import aiosqlite
    from database import DB_PATH
    # 先取出 user_id
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute("SELECT user_id FROM purchase_orders WHERE id=?", (order_id,)) as cur:
            row = await cur.fetchone()
            if not row:
                raise HTTPException(404, "Order not found")
            user_id = row["user_id"]
    await db.approve_purchase_order(order_id, req.admin_note)
    if req.grant_apikey:
        await db.set_user_apikey_permission(user_id, True)
    return {"ok": True}


class RejectRequest(BaseModel):
    admin_note: str = ""


@router.post("/purchase-orders/{order_id}/reject", dependencies=[Depends(auth_admin)])
async def reject_order(order_id: int, req: RejectRequest):
    await db.reject_purchase_order(order_id, req.admin_note)
    return {"ok": True}


# ── 系统配置 ──────────────────────────────────────────────────────────────────

@router.get("/config", dependencies=[Depends(auth_admin)])
async def get_config():
    return await db.get_all_configs()


class ConfigRequest(BaseModel):
    key: str
    value: str


@router.put("/config", dependencies=[Depends(auth_admin)])
async def set_config(req: ConfigRequest):
    await db.set_config(req.key, req.value)
    return {"ok": True}


# ── 虚拟 Agent ────────────────────────────────────────────────────────────────

@router.get("/virtual-agents", dependencies=[Depends(auth_admin)])
async def list_virtual_agents():
    agents = await db.list_virtual_agents()
    for a in agents:
        a["api_key"] = a["api_key"][:6] + "****" if len(a.get("api_key", "")) > 6 else "****"
    return {"agents": agents}


class VirtualAgentRequest(BaseModel):
    name: str
    base_url: str
    api_key: str
    api_style: str = "openai"
    models: list[str] = []
    enabled: bool = True


@router.post("/virtual-agents", dependencies=[Depends(auth_admin)])
async def create_virtual_agent(req: VirtualAgentRequest):
    if req.api_style not in ("openai", "anthropic"):
        raise HTTPException(400, "api_style 必须是 openai 或 anthropic")
    if not req.name.strip():
        raise HTTPException(400, "name 不能为空")
    if not req.base_url.strip():
        raise HTTPException(400, "base_url 不能为空")
    if not req.api_key.strip():
        raise HTTPException(400, "api_key 不能为空")
    agent = await db.create_virtual_agent(
        req.name.strip(), req.base_url.strip(), req.api_key.strip(),
        req.api_style, req.models, req.enabled,
    )
    await _sync_virtual_pool()
    return {"ok": True, "agent": agent}


class UpdateVirtualAgentRequest(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    api_style: str = "openai"
    models: list[str] = []
    enabled: bool = True


@router.patch("/virtual-agents/{agent_id}", dependencies=[Depends(auth_admin)])
async def update_virtual_agent(agent_id: int, req: UpdateVirtualAgentRequest):
    if req.api_style not in ("openai", "anthropic"):
        raise HTTPException(400, "api_style 必须是 openai 或 anthropic")
    existing = await db.get_virtual_agent(agent_id)
    if not existing:
        raise HTTPException(404, "Virtual agent not found")
    await db.update_virtual_agent(
        agent_id, req.name.strip(), req.base_url.strip(), req.api_key.strip(),
        req.api_style, req.models, req.enabled,
    )
    await _sync_virtual_pool()
    return {"ok": True}


@router.delete("/virtual-agents/{agent_id}", dependencies=[Depends(auth_admin)])
async def delete_virtual_agent(agent_id: int):
    existing = await db.get_virtual_agent(agent_id)
    if not existing:
        raise HTTPException(404, "Virtual agent not found")
    await db.delete_virtual_agent(agent_id)
    await _sync_virtual_pool()
    return {"ok": True}

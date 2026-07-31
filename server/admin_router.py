"""管理员接口：Worker 列表、API Key、模型配置、用户管理、购买审批、系统配置"""

import os
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import claude_oauth
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
    # cache-bust：admin.html 不缓存（每次都重新取），并给外挂 JS 注入版本号=最新 JS mtime，
    # 改了 JS 版本号自动变，浏览器自动拉新，无需手动硬刷新。
    html = open("static/admin.html", encoding="utf-8").read()
    try:
        ver = str(int(max(
            os.path.getmtime(f"static/{f}")
            for f in ("admin-routing-catalog.js", "admin-app-catalog.js", "admin-billing-sources.js")
        )))
    except OSError:
        ver = str(int(time.time()))
    html = html.replace("{{JS_VER}}", ver)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, max-age=0"})


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


@router.post("/debug/image", dependencies=[Depends(auth_admin)])
async def debug_image(request: Request):
    from dispatch_image import handle_image
    return await handle_image(await request.json())


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
    model_type: str = "chat"    # chat / vision / image / embedding


@router.post("/models", dependencies=[Depends(auth_admin)])
async def upsert_model(req: ModelConfigRequest):
    if req.tier not in ("premium", "open"):
        raise HTTPException(400, "tier 必须是 premium 或 open")
    if req.model_type not in ("chat", "vision", "image", "embedding"):
        raise HTTPException(400, "model_type 必须是 chat / vision / image / embedding")
    return await db.upsert_model_config(
        req.name, req.display_name, req.tier,
        req.contribute_rate, req.consume_rate, req.enabled,
        model_type=req.model_type,
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
    nickname: str | None = None


@router.patch("/users/{user_id}", dependencies=[Depends(auth_admin)])
async def update_user(user_id: int, req: UpdateUserRequest):
    if req.can_create_apikey is not None:
        await db.set_user_apikey_permission(user_id, req.can_create_apikey)
    if req.nickname is not None:
        await db.set_user_nickname(user_id, req.nickname.strip())
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
    from pg_compat import connect
    async with connect() as conn:
        async with conn.execute(
            "SELECT user_id FROM purchase_orders WHERE id=?", (order_id,)
        ) as cur:
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

_VALID_API_STYLES = ("openai", "anthropic", "claude_oauth", "gemini")


def _redact_credentials(creds: dict) -> dict:
    """列表展示用：只暴露 token 是否存在与过期时间，不回传明文。"""
    if not creds:
        return {}
    out = {}
    if creds.get("refresh_token"):
        out["has_refresh_token"] = True
    if creds.get("access_token"):
        out["has_access_token"] = True
    if creds.get("expires_at"):
        out["expires_at"] = creds["expires_at"]
    if creds.get("scope"):
        out["scope"] = creds["scope"]
    if creds.get("email"):
        out["email"] = creds["email"]
    return out


@router.get("/virtual-agents", dependencies=[Depends(auth_admin)])
async def list_virtual_agents():
    # 仅列全局供给源；用户个人供给源（owner 非空）归用户端管理，不在后台展示
    agents = await db.list_virtual_agents(owner_is_null=True)
    for a in agents:
        a["api_key"] = a["api_key"][:6] + "****" if len(a.get("api_key", "")) > 6 else "****"
        a["credentials"] = _redact_credentials(a.get("credentials") or {})
    return {"agents": agents}


class VirtualAgentRequest(BaseModel):
    name: str
    base_url: str = ""
    api_key: str = ""
    api_style: str = "openai"
    models: list = []        # list[str | {name, type}]
    enabled: bool = True
    refresh_token: str = ""  # claude_oauth 账号用：订阅 OAuth 的 refresh_token


@router.post("/virtual-agents", dependencies=[Depends(auth_admin)])
async def create_virtual_agent(req: VirtualAgentRequest):
    if req.api_style not in _VALID_API_STYLES:
        raise HTTPException(400, "api_style 必须是 openai、anthropic 或 claude_oauth")
    if not req.name.strip():
        raise HTTPException(400, "name 不能为空")
    credentials = None
    if req.api_style == "claude_oauth":
        # OAuth 账号：凭 refresh_token 自动换 token，base_url 留空回落官方端点
        if not req.refresh_token.strip():
            raise HTTPException(400, "claude_oauth 账号必须提供 refresh_token")
        credentials = {"refresh_token": req.refresh_token.strip()}
    else:
        if not req.base_url.strip():
            raise HTTPException(400, "base_url 不能为空")
        if not req.api_key.strip():
            raise HTTPException(400, "api_key 不能为空")
    agent = await db.create_virtual_agent(
        req.name.strip(), req.base_url.strip(), req.api_key.strip(),
        req.api_style, req.models, req.enabled, credentials,
    )
    await _sync_virtual_pool()
    return {"ok": True, "agent": agent}


class UpdateVirtualAgentRequest(BaseModel):
    name: str
    base_url: str = ""
    api_key: str = ""
    api_style: str = "openai"
    models: list = []        # list[str | {name, type}]
    enabled: bool = True
    refresh_token: str = ""  # 非空时替换 claude_oauth 凭证（重新授权）


@router.patch("/virtual-agents/{agent_id}", dependencies=[Depends(auth_admin)])
async def update_virtual_agent(agent_id: int, req: UpdateVirtualAgentRequest):
    if req.api_style not in _VALID_API_STYLES:
        raise HTTPException(400, "api_style 必须是 openai、anthropic 或 claude_oauth")
    existing = await db.get_virtual_agent(agent_id)
    if not existing:
        raise HTTPException(404, "Virtual agent not found")
    # 提供了新 refresh_token 才重置凭证（清掉旧 access_token，强制下次刷新）
    credentials = None
    if req.refresh_token.strip():
        credentials = {"refresh_token": req.refresh_token.strip()}
    await db.update_virtual_agent(
        agent_id, req.name.strip(), req.base_url.strip(), req.api_key.strip(),
        req.api_style, req.models, req.enabled, credentials,
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


# ── Claude 订阅一键登录（PKCE 授权码流）────────────────────────────────────────
# 内存会话存储：session_id -> {verifier, scope, is_setup_token, created}
# 单进程 FastAPI 用内存即可；30 分钟过期。
_OAUTH_LOGIN_SESSIONS: dict[str, dict] = {}
_OAUTH_SESSION_TTL = 30 * 60


def _gc_oauth_sessions() -> None:
    now = time.time()
    for sid in [k for k, v in _OAUTH_LOGIN_SESSIONS.items()
                if now - v["created"] > _OAUTH_SESSION_TTL]:
        _OAUTH_LOGIN_SESSIONS.pop(sid, None)


class OAuthStartRequest(BaseModel):
    setup_token: bool = False   # True 走 user:inference（约 1 年有效）


@router.post("/oauth/claude/start", dependencies=[Depends(auth_admin)])
async def oauth_claude_start(req: OAuthStartRequest):
    """第 1 步：生成授权 URL。前端引导用户在浏览器打开并登录授权。"""
    _gc_oauth_sessions()
    verifier = claude_oauth.generate_code_verifier()
    challenge = claude_oauth.generate_code_challenge(verifier)
    state = claude_oauth.generate_state()
    scope = claude_oauth.SCOPE_INFERENCE if req.setup_token else claude_oauth.SCOPE_OAUTH
    auth_url = claude_oauth.build_authorization_url(state, challenge, scope)
    session_id = secrets.token_urlsafe(16)
    _OAUTH_LOGIN_SESSIONS[session_id] = {
        "verifier": verifier,
        "scope": scope,
        "is_setup_token": req.setup_token,
        "created": time.time(),
    }
    return {
        "ok": True,
        "session_id": session_id,
        "auth_url": auth_url,
        "instructions": "在浏览器打开 auth_url 登录授权，复制回调页地址栏中的 code 参数（形如 code#state），调用 /oauth/claude/exchange 完成。",
    }


class OAuthExchangeRequest(BaseModel):
    session_id: str
    code: str
    # 可选：直接建虚拟 Agent（一步到位）。给了 name 即创建。
    name: str = ""
    models: list = []
    enabled: bool = True


@router.post("/oauth/claude/exchange", dependencies=[Depends(auth_admin)])
async def oauth_claude_exchange(req: OAuthExchangeRequest):
    """第 2 步：用授权码换 token；可选直接创建 claude_oauth 虚拟 Agent。"""
    _gc_oauth_sessions()
    sess = _OAUTH_LOGIN_SESSIONS.get(req.session_id)
    if not sess:
        raise HTTPException(400, "session 不存在或已过期，请重新发起 /oauth/claude/start")
    if not req.code.strip():
        raise HTTPException(400, "code 不能为空")
    try:
        creds = await claude_oauth.exchange_code(
            req.code.strip(), sess["verifier"], sess["is_setup_token"],
        )
    except Exception as e:
        raise HTTPException(400, f"授权码交换失败：{e}")
    _OAUTH_LOGIN_SESSIONS.pop(req.session_id, None)
    if not creds.get("refresh_token"):
        raise HTTPException(400, "上游未返回 refresh_token，无法长期使用，请重试授权")

    result = {
        "ok": True,
        "email": creds.get("email", ""),
        "scope": creds.get("scope", ""),
        "expires_at": creds.get("expires_at"),
        # 返回 refresh_token 供前端落库或人工保存（admin-only 接口）
        "refresh_token": creds["refresh_token"],
    }
    # 一步到位：给了 name 就直接建账号
    if req.name.strip():
        agent = await db.create_virtual_agent(
            req.name.strip(), "", "", "claude_oauth", req.models, req.enabled, creds,
        )
        await _sync_virtual_pool()
        result["agent"] = {k: agent[k] for k in ("id", "name", "api_style", "models")}
    return result

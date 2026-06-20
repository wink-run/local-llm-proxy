"""用户个人供给源（Provider）：API Key / Claude OAuth 订阅，归属当前用户。

挂在 /user 前缀下。个人供给源即 owner_user_id 非空的虚拟 Agent，复用 claude_oauth
登录/刷新、worker_pool 装载、dispatch failover 全套逻辑，仅本人可见可用。
"""
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import claude_oauth
import database as db
from auth import get_current_user_id
from worker_pool import pool

router = APIRouter()

_VALID_API_STYLES = ("openai", "anthropic", "claude_oauth", "gemini")


async def _sync_pool() -> None:
    """从数据库重载全部启用的虚拟 Agent（全局+个人）到池。"""
    agents = await db.list_virtual_agents(enabled_only=True)
    pool.sync_virtual(agents)


def _normalize_models(raw: list) -> tuple[list, dict]:
    """把 [str | {name,type}] 归一为 (落库用列表, {name: type})。"""
    models, types = [], {}
    for m in raw or []:
        if isinstance(m, str):
            name, mtype = m.strip(), "chat"
        elif isinstance(m, dict):
            name, mtype = (m.get("name") or "").strip(), (m.get("type") or "chat")
        else:
            continue
        if name:
            models.append({"name": name, "type": mtype})
            types[name] = mtype
    return models, types


async def _register_models(raw: list) -> None:
    """把个人源的模型名补进 model_configs（已存在则跳过），让路由/列表可见。"""
    _, types = _normalize_models(raw)
    if types:
        await db.ensure_default_open_models(list(types.keys()), types)


def _redact(creds: dict) -> dict:
    """脱敏：只暴露是否登录、过期时间、邮箱，不回传明文 token。"""
    if not creds:
        return {}
    out = {}
    if creds.get("refresh_token"):
        out["has_refresh_token"] = True
    if creds.get("access_token"):
        out["has_access_token"] = True
    if creds.get("expires_at"):
        out["expires_at"] = creds["expires_at"]
    if creds.get("email"):
        out["email"] = creds["email"]
    if creds.get("scope"):
        out["scope"] = creds["scope"]
    return out


def _public_view(agent: dict) -> dict:
    """对外返回：脱敏凭证 + api_key 掩码。"""
    a = dict(agent)
    key = a.get("api_key") or ""
    a["api_key"] = (key[:6] + "****") if len(key) > 6 else ("****" if key else "")
    a["credentials"] = _redact(a.get("credentials") or {})
    return a


# ── 供给源 CRUD ────────────────────────────────────────────────────────────────
@router.get("/providers")
async def list_providers(uid: int = Depends(get_current_user_id)):
    agents = await db.list_virtual_agents_by_owner(uid)
    return {"providers": [_public_view(a) for a in agents]}


class ProviderCreate(BaseModel):
    name: str
    auth_type: str = "api_key"       # 'api_key' | 'claude_oauth'
    api_style: str = "openai"        # api_key 模式下：openai | anthropic
    base_url: str = ""
    api_key: str = ""
    refresh_token: str = ""          # claude_oauth 模式
    models: list = []
    enabled: bool = True


@router.post("/providers")
async def create_provider(req: ProviderCreate, uid: int = Depends(get_current_user_id)):
    if not req.name.strip():
        raise HTTPException(400, "name 不能为空")

    credentials = None
    if req.auth_type == "claude_oauth":
        api_style = "claude_oauth"
        if not req.refresh_token.strip():
            raise HTTPException(400, "claude_oauth 供给源必须提供 refresh_token（先完成登录）")
        credentials = {"refresh_token": req.refresh_token.strip()}
        base_url, api_key = req.base_url.strip(), ""
    else:
        if req.api_style not in ("openai", "anthropic", "gemini"):
            raise HTTPException(400, "api_style 必须是 openai、anthropic 或 gemini")
        api_style = req.api_style
        if not req.base_url.strip():
            raise HTTPException(400, "base_url 不能为空")
        if not req.api_key.strip():
            raise HTTPException(400, "api_key 不能为空")
        base_url, api_key = req.base_url.strip(), req.api_key.strip()

    models, _ = _normalize_models(req.models)
    agent = await db.create_virtual_agent(
        req.name.strip(), base_url, api_key, api_style, models,
        req.enabled, credentials, owner_user_id=uid,
    )
    await _register_models(req.models)
    await _sync_pool()
    return {"ok": True, "provider": _public_view(agent)}


class ProviderUpdate(BaseModel):
    name: str
    api_style: str = "openai"
    base_url: str = ""
    api_key: str = ""                # 留空=不改密钥
    refresh_token: str = ""          # 非空=重置 claude_oauth 凭证
    models: list = []
    enabled: bool = True


@router.patch("/providers/{provider_id}")
async def update_provider(provider_id: int, req: ProviderUpdate,
                          uid: int = Depends(get_current_user_id)):
    existing = await db.get_virtual_agent_owned(provider_id, uid)
    if not existing:
        raise HTTPException(404, "供给源不存在或无权限")
    if req.api_style not in _VALID_API_STYLES:
        raise HTTPException(400, "api_style 非法")

    credentials = None
    if req.refresh_token.strip():
        credentials = {"refresh_token": req.refresh_token.strip()}

    models, _ = _normalize_models(req.models)
    await db.update_virtual_agent(
        provider_id, req.name.strip(), req.base_url.strip(), req.api_key.strip(),
        req.api_style, models, req.enabled, credentials,
    )
    await _register_models(req.models)
    await _sync_pool()
    return {"ok": True}


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: int, uid: int = Depends(get_current_user_id)):
    existing = await db.get_virtual_agent_owned(provider_id, uid)
    if not existing:
        raise HTTPException(404, "供给源不存在或无权限")
    await db.delete_virtual_agent(provider_id)
    await _sync_pool()
    return {"ok": True}


# ── Claude 订阅一键登录（用户作用域）──────────────────────────────────────────
# session_id -> {verifier, is_setup_token, created, uid}
_OAUTH_SESSIONS: dict[str, dict] = {}
_OAUTH_TTL = 30 * 60


def _gc_sessions() -> None:
    now = time.time()
    for sid in [k for k, v in _OAUTH_SESSIONS.items() if now - v["created"] > _OAUTH_TTL]:
        _OAUTH_SESSIONS.pop(sid, None)


class OAuthStart(BaseModel):
    setup_token: bool = False


@router.post("/oauth/claude/start")
async def oauth_start(req: OAuthStart, uid: int = Depends(get_current_user_id)):
    _gc_sessions()
    verifier = claude_oauth.generate_code_verifier()
    challenge = claude_oauth.generate_code_challenge(verifier)
    state = claude_oauth.generate_state()
    scope = claude_oauth.SCOPE_INFERENCE if req.setup_token else claude_oauth.SCOPE_OAUTH
    auth_url = claude_oauth.build_authorization_url(state, challenge, scope)
    session_id = secrets.token_urlsafe(16)
    _OAUTH_SESSIONS[session_id] = {
        "verifier": verifier, "is_setup_token": req.setup_token,
        "created": time.time(), "uid": uid,
    }
    return {"ok": True, "session_id": session_id, "auth_url": auth_url}


class OAuthExchange(BaseModel):
    session_id: str
    code: str


@router.post("/oauth/claude/exchange")
async def oauth_exchange(req: OAuthExchange, uid: int = Depends(get_current_user_id)):
    _gc_sessions()
    sess = _OAUTH_SESSIONS.get(req.session_id)
    if not sess or sess.get("uid") != uid:
        raise HTTPException(400, "session 不存在或已过期，请重新发起登录")
    if not req.code.strip():
        raise HTTPException(400, "code 不能为空")
    try:
        creds = await claude_oauth.exchange_code(
            req.code.strip(), sess["verifier"], sess["is_setup_token"],
        )
    except Exception as e:
        raise HTTPException(400, f"授权码交换失败：{e}")
    _OAUTH_SESSIONS.pop(req.session_id, None)
    if not creds.get("refresh_token"):
        raise HTTPException(400, "上游未返回 refresh_token，请重试授权")
    return {
        "ok": True,
        "email": creds.get("email", ""),
        "scope": creds.get("scope", ""),
        "expires_at": creds.get("expires_at"),
        "refresh_token": creds["refresh_token"],
    }

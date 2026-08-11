"""用户接口：注册、登录、个人看板、API Key 自助管理、购买申请"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, field_validator

import database as db
from auth import create_token, get_current_user_id, hash_password, verify_password
from worker_pool import pool as _pool

router = APIRouter()


# ── 注册 / 登录 ───────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: str
    nickname: str = ""
    password: str
    referral_code: str = ""
    circle_code: str = ""   # Optional: auto-join circle after registration

    @field_validator("password")
    @classmethod
    def pw_len(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("密码至少 6 位")
        return v


@router.post("/register")
async def register(req: RegisterRequest):
    existing = await db.get_user_by_email(req.email)
    if existing:
        raise HTTPException(400, "该邮箱已注册")

    referred_by = None
    referrer = None
    if req.referral_code:
        referrer = await db.get_user_by_referral_code(req.referral_code)
        if referrer:
            referred_by = referrer["id"]

    pw_hash = hash_password(req.password)
    user = await db.create_user(req.email, req.nickname or req.email.split("@")[0], pw_hash, referred_by)

    # 新人礼包
    newcomer_reward = float(await db.get_config("newcomer_reward", "50"))
    if newcomer_reward > 0:
        await db.award_credits(user["id"], newcomer_reward, type_="referral", note="新人注册礼包")

    # 推荐人奖励
    if referrer:
        referral_reward = float(await db.get_config("referral_reward", "100"))
        if referral_reward > 0:
            await db.award_credits(referrer["id"], referral_reward, type_="referral",
                                   note=f"推荐新用户 {req.email}")

    # Auto-join circle if circle_code provided
    circle_joined = False
    circle_full = False
    if req.circle_code:
        circle = await db.get_circle_by_code(req.circle_code)
        if circle:
            member_count = await db.circle_member_count(circle["id"])
            if member_count < circle["max_members"]:
                await db.add_circle_member(circle["id"], user["id"])
                circle_joined = True
                # Award circle owner for bringing in a new user (on top of referral)
                invite_reward = float(await db.get_config("circle_invite_reward", "50"))
                if invite_reward > 0 and circle["owner_id"] != user["id"]:
                    await db.award_credits(
                        circle["owner_id"], invite_reward, type_="referral",
                        note=f"邀请新用户入圈 {circle['name']}"
                    )
            else:
                circle_full = True

    token = create_token(user["id"])
    return {
        "token": token, "user_id": user["id"], "email": req.email,
        "circle_joined": circle_joined, "circle_full": circle_full,
    }


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/login")
async def login(req: LoginRequest):
    user = await db.get_user_by_email(req.email)
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(401, "邮箱或密码错误")
    token = create_token(user["id"])
    return {"token": token, "user_id": user["id"], "email": user["email"]}


# ── 忘记密码 ──────────────────────────────────────────────────────────────────

class ForgotPasswordRequest(BaseModel):
    email: str


@router.post("/forgot-password")
async def forgot_password(req: ForgotPasswordRequest):
    """申请重置：无论邮箱是否存在都返回相同文案，防枚举。"""
    import logging

    from mailutil import send_email, smtp_configured

    logger = logging.getLogger(__name__)
    email = (req.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "请输入有效邮箱")

    contact = await db.get_config("contact_info", "")
    # 统一响应，不泄露邮箱是否注册
    generic = {
        "ok": True,
        "message": "若该邮箱已注册，验证码将发送至邮箱（约 15 分钟有效）",
        "email_sent": False,
        "smtp_configured": smtp_configured(),
        "contact_info": contact,
    }

    user = await db.get_user_by_email(email)
    if not user:
        return generic

    # 限流：同一邮箱 60 秒内最多 1 次
    if await db.recent_password_reset_count(email, within_seconds=60) > 0:
        raise HTTPException(429, "请求过于频繁，请稍后再试")

    code = await db.create_password_reset_code(email, ttl_minutes=15)
    subject = "Token Bank 密码重置验证码"
    body = (
        f"您的密码重置验证码是：{code}\n\n"
        f"有效期 15 分钟。如非本人操作，请忽略本邮件。\n\n"
        f"官方网址：https://tokenbank.wink.run\n"
    )
    sent = send_email(email, subject, body)
    if not sent:
        # 未配置 SMTP 时写入日志，便于自托管管理员协助找回
        logger.info("[forgot-password] email=%s code=%s (smtp not sent)", email, code)

    generic["email_sent"] = sent
    return generic


class ResetPasswordRequest(BaseModel):
    email: str
    code: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def pw_len(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("密码至少 6 位")
        return v


@router.post("/reset-password")
async def reset_password(req: ResetPasswordRequest):
    """用邮箱 + 验证码设置新密码。"""
    email = (req.email or "").strip().lower()
    code = (req.code or "").strip()
    if not email or not code:
        raise HTTPException(400, "请填写邮箱与验证码")

    user = await db.get_user_by_email(email)
    if not user:
        raise HTTPException(400, "验证码无效或已过期")

    ok = await db.consume_password_reset_code(email, code)
    if not ok:
        raise HTTPException(400, "验证码无效或已过期")

    await db.set_user_password(user["id"], hash_password(req.new_password))
    return {"ok": True, "message": "密码已重置，请使用新密码登录"}


# ── 个人资料 ──────────────────────────────────────────────────────────────────

@router.get("/profile")
async def profile(uid: int = Depends(get_current_user_id)):
    user = await db.get_user_by_id(uid)
    if not user:
        raise HTTPException(404, "User not found")
    return {
        "id": user["id"],
        "email": user["email"],
        "nickname": user["nickname"],
        "credits_balance": user["credits_balance"],
        "credits_earned": user["credits_earned"],
        "credits_spent": user["credits_spent"],
        "referral_code": user["referral_code"],
        "worker_key": user["worker_key"],
        "can_create_apikey": bool(user["can_create_apikey"]),
        "show_on_wall": bool(user["show_on_wall"]),
        "wall_display": user["wall_display"],
        "avatar_url": user.get("avatar_url") or "",
        "persona": (user.get("persona") or "").strip(),
        "created_at": user["created_at"],
    }


class UpdateProfileRequest(BaseModel):
    nickname: str | None = None
    show_on_wall: bool | None = None
    wall_display: str | None = None
    persona: str | None = None  # 一句话画像；传空串可清除


@router.patch("/profile")
async def update_profile(req: UpdateProfileRequest, uid: int = Depends(get_current_user_id)):
    updates, params = [], []
    if req.nickname is not None:
        updates.append("nickname=?"); params.append(req.nickname)
    if req.show_on_wall is not None:
        updates.append("show_on_wall=?"); params.append(int(req.show_on_wall))
    if req.wall_display is not None:
        if req.wall_display not in ("nickname", "masked", "hidden"):
            raise HTTPException(400, "wall_display 必须是 nickname/masked/hidden")
        updates.append("wall_display=?"); params.append(req.wall_display)
    if req.persona is not None:
        text = (req.persona or "").strip()
        if len(text) > 300:
            raise HTTPException(400, "画像过长（最多 300 字）")
        updates.append("persona=?"); params.append(text)
    if updates:
        params.append(uid)
        from pg_compat import connect
        async with connect() as conn:
            await conn.execute(
                f"UPDATE users SET {','.join(updates)} WHERE id=?",
                tuple(params),
            )
    return {"ok": True}


# ── 用户自助 API Key ───────────────────────────────────────────────────────────

async def _require_apikey_permission(uid: int) -> None:
    user = await db.get_user_by_id(uid)
    if not user or not user["can_create_apikey"]:
        raise HTTPException(403, "尚未开通 API Key 创建权限，请先购买积分")


@router.get("/keys")
async def list_my_keys(uid: int = Depends(get_current_user_id)):
    await _require_apikey_permission(uid)
    return {"keys": await db.list_keys(user_id=uid)}


class CreateKeyRequest(BaseModel):
    note: str = ""


@router.post("/keys")
async def create_my_key(req: CreateKeyRequest, uid: int = Depends(get_current_user_id)):
    await _require_apikey_permission(uid)
    return await db.create_key(req.note, user_id=uid)


class UpdateKeyRequest(BaseModel):
    is_active: bool


@router.patch("/keys/{key_id}")
async def toggle_my_key(key_id: int, req: UpdateKeyRequest, uid: int = Depends(get_current_user_id)):
    await _require_apikey_permission(uid)
    await db.set_key_active(key_id, req.is_active, user_id=uid)
    return {"ok": True}


@router.delete("/keys/{key_id}")
async def delete_my_key(key_id: int, uid: int = Depends(get_current_user_id)):
    await _require_apikey_permission(uid)
    await db.delete_key(key_id, user_id=uid)
    return {"ok": True}


# ── 积分流水 / 结算明细 ───────────────────────────────────────────────────────

@router.get("/transactions")
async def my_transactions(uid: int = Depends(get_current_user_id)):
    return {"transactions": await db.get_transactions(uid)}


@router.get("/settlements")
async def my_settlements(uid: int = Depends(get_current_user_id)):
    return {"settlements": await db.get_settlements(uid)}


@router.get("/contribute-summary")
async def contribute_summary(uid: int = Depends(get_current_user_id)):
    """贡献页：累计 token、赚取积分（折算人民币）、P2P 使用节省金额。"""
    summary = await db.get_contribute_summary(uid)
    # 当前未结算周期内的实时贡献 token
    period_tokens = sum(
        s.get("output_tokens", 0)
        for w in _pool.all_workers()
        if w.user_id == uid
        for s in w.period_stats.values()
    )
    summary["period_tokens"] = period_tokens
    return summary


# ── 购买积分 ──────────────────────────────────────────────────────────────────

class PurchaseRequest(BaseModel):
    amount_credits: float
    note: str = ""


@router.post("/purchase-order")
async def create_purchase_order(req: PurchaseRequest, uid: int = Depends(get_current_user_id)):
    if req.amount_credits < 0:
        raise HTTPException(400, "积分数量不能为负数")
    contact = await db.get_config("contact_info", "")
    order = await db.create_purchase_order(uid, req.amount_credits, req.note)
    return {"order": order, "contact_info": contact}


@router.get("/purchase-orders")
async def my_purchase_orders(uid: int = Depends(get_current_user_id)):
    # 与网页版一致：列表接口同时返回管理员配置的付款联系方式，便于用户未下单前也能看到指引
    contact = await db.get_config("contact_info", "")
    return {"orders": await db.get_user_purchase_orders(uid), "contact_info": contact}


# ── 每日签到 ──────────────────────────────────────────────────────────────────

@router.post("/checkin")
async def checkin(uid: int = Depends(get_current_user_id)):
    result = await db.do_checkin(uid)
    if result["already"]:
        raise HTTPException(400, f"今日已签到，获得 {result['credits']} 积分")
    return result


@router.get("/checkin/status")
async def checkin_status(uid: int = Depends(get_current_user_id)):
    return await db.get_checkin_status(uid)


# ── 转盘抽奖 ──────────────────────────────────────────────────────────────────

@router.post("/spin")
async def spin(uid: int = Depends(get_current_user_id)):
    result = await db.do_spin(uid)
    if result["already"]:
        raise HTTPException(400, f"今日抽奖次数已用完（{result['spins_used']}/{result['daily_limit']} 次）")
    return result


@router.get("/spin/status")
async def spin_status(uid: int = Depends(get_current_user_id)):
    return await db.get_spin_status(uid)


@router.get("/dashboard-stats")
async def dashboard_stats(days: int = 30, uid: int = Depends(get_current_user_id)):
    stats = await db.get_dashboard_stats(uid, days)
    return {"stats": stats, "days": days}


@router.get("/inventory-stats")
async def inventory_stats(days: int = 1, uid: int = Depends(get_current_user_id)):
    """个人页看板：汇总各端上报的盘点数据（按设备维度合并）。"""
    if days not in (1, 7, 30):
        days = 1
    return await db.get_user_inventory_stats(uid, days)


@router.get("/model-stats")
async def model_stats(days: int = 30, uid: int = Depends(get_current_user_id)):
    models = await db.get_model_stats(uid, days)
    hourly = await db.get_hourly_stats(uid)
    return {"models": models, "hourly": hourly}


# ── 个人页账户（订阅 / 按量 provider / 刊例价）────────────────────
# 注意：官方客户端供给源配置仅存本机；云端 inventory.accounts_summary 为各设备单向上报摘要。

class UserAccountsUpdate(BaseModel):
    user_subscriptions: list | None = None
    user_payg_providers: list | None = None
    provider_pricing_overrides: dict | None = None
    subscription_plans: dict | None = None


@router.get("/accounts")
async def get_user_accounts(uid: int = Depends(get_current_user_id)):
    """读取当前用户的订阅与按量付费配置（含服务端目录）。"""
    from billing_catalog import build_user_accounts_snapshot

    billing = await db.get_user_billing(uid)
    return await build_user_accounts_snapshot(billing)


@router.put("/accounts")
async def put_user_accounts(req: UserAccountsUpdate, uid: int = Depends(get_current_user_id)):
    """保存订阅 / provider / 刊例价覆盖（与客户端 local-config 字段一致）。"""
    from billing_catalog import build_user_accounts_snapshot

    patch = req.model_dump(exclude_unset=True)
    billing = await db.set_user_billing(uid, patch)
    return await build_user_accounts_snapshot(billing)


@router.get("/stats")
async def user_stats(uid: int = Depends(get_current_user_id)):
    user_workers = [w for w in _pool.all_workers() if w.user_id == uid]
    total_req = sum(
        sum(s["requests"] for s in w.period_stats.values())
        for w in user_workers
    )
    total_online_mins = max(sum(w.period_online_mins() for w in user_workers), 1)
    contribute_req_per_min = round(total_req / total_online_mins, 2) if user_workers else 0.0
    return {
        "contribute_req_per_min": contribute_req_per_min,
        "active_workers": len(user_workers),
        "active_requests": sum(w.active_requests for w in user_workers),
    }


# ── 社区 skill 推荐 / 纳管结算 ─────────────────────────────────────────────────

class CommunityRecommendRequest(BaseModel):
    name: str
    content: str
    display_name: str = ""
    description: str = ""
    metadata: dict = {}


@router.get("/community-catalog/pricing")
async def community_catalog_pricing(uid: int = Depends(get_current_user_id)):
    """当前纳管扣减 / 推荐奖励（只读，供客户端提示）。"""
    import community_catalog as cc
    return await cc.get_pricing()


@router.post("/community-catalog/recommend")
async def recommend_community_skill(
    req: CommunityRecommendRequest,
    uid: int = Depends(get_current_user_id),
):
    """把本机 skill 推荐到社区目录，其他用户可见并可纳管。"""
    import community_catalog as cc
    user = await db.get_user_by_id(uid)
    email = (user or {}).get("email") or ""
    try:
        result = await cc.upsert_user_skill_recommendation(
            user_id=uid,
            name=req.name,
            content=req.content,
            display_name=req.display_name,
            description=req.description,
            metadata=req.metadata or {},
            recommender_email=email,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return result


class CommunityInstallRequest(BaseModel):
    catalog_id: str


@router.post("/community-catalog/install")
async def install_community_skill(
    req: CommunityInstallRequest,
    uid: int = Depends(get_current_user_id),
):
    """社区 skill 纳管结算：用户推荐项扣积分并奖励推荐人；官方项免费。"""
    import community_catalog as cc
    try:
        return await cc.settle_community_install(
            installer_id=uid,
            catalog_id=req.catalog_id,
        )
    except PermissionError as e:
        raise HTTPException(402, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


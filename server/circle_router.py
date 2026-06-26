"""圈子接口：创建、管理、邀请入圈"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import database as db
from auth import get_current_user_id

router = APIRouter()

MAX_OWNED  = 5
MAX_JOINED = 20   # not counting owned circles


# ── 创建圈子 ──────────────────────────────────────────────────────────────────

class CreateCircleRequest(BaseModel):
    name: str
    description: str = ""


@router.post("/circles")
async def create_circle(req: CreateCircleRequest, uid: int = Depends(get_current_user_id)):
    if not req.name.strip():
        raise HTTPException(400, "圈子名称不能为空")
    owned = await db.count_circles_owned(uid)
    if owned >= MAX_OWNED:
        raise HTTPException(400, f"最多创建 {MAX_OWNED} 个圈子")
    circle = await db.create_circle(uid, req.name.strip(), req.description.strip())
    circle["member_count"] = 1
    return {"circle": circle}


# ── 我的圈子列表 ───────────────────────────────────────────────────────────────

@router.get("/circles")
async def list_my_circles(uid: int = Depends(get_current_user_id)):
    circles = await db.list_circles_owned(uid)
    for c in circles:
        c["member_count"] = await db.circle_member_count(c["id"])
    return {"circles": circles}


@router.get("/circles/joined")
async def list_joined_circles(uid: int = Depends(get_current_user_id)):
    circles = await db.list_circles_joined(uid)
    for c in circles:
        c["member_count"] = await db.circle_member_count(c["id"])
        c["is_owner"] = c["owner_id"] == uid
    return {"circles": circles}


# ── 解散圈子 ──────────────────────────────────────────────────────────────────

@router.delete("/circles/{circle_id}")
async def dissolve_circle(circle_id: int, uid: int = Depends(get_current_user_id)):
    circle = await db.get_circle_by_id(circle_id)
    if not circle:
        raise HTTPException(404, "圈子不存在")
    if circle["owner_id"] != uid:
        raise HTTPException(403, "仅圈主可解散圈子")
    await db.delete_circle(circle_id)
    return {"ok": True}


# ── 退出圈子 ──────────────────────────────────────────────────────────────────

@router.post("/circles/{circle_id}/leave")
async def leave_circle(circle_id: int, uid: int = Depends(get_current_user_id)):
    circle = await db.get_circle_by_id(circle_id)
    if not circle:
        raise HTTPException(404, "圈子不存在")
    if circle["owner_id"] == uid:
        raise HTTPException(400, "圈主不能退出圈子，请解散圈子")
    if not await db.is_circle_member(circle_id, uid):
        raise HTTPException(400, "你不在该圈子中")
    await db.remove_circle_member(circle_id, uid)
    return {"ok": True}


# ── 踢出成员 ──────────────────────────────────────────────────────────────────

@router.delete("/circles/{circle_id}/members/{member_uid}")
async def kick_member(circle_id: int, member_uid: int, uid: int = Depends(get_current_user_id)):
    circle = await db.get_circle_by_id(circle_id)
    if not circle:
        raise HTTPException(404, "圈子不存在")
    if circle["owner_id"] != uid:
        raise HTTPException(403, "仅圈主可移除成员")
    if member_uid == uid:
        raise HTTPException(400, "不能踢出自己")
    if not await db.is_circle_member(circle_id, member_uid):
        raise HTTPException(404, "该用户不在圈子中")
    await db.remove_circle_member(circle_id, member_uid)
    return {"ok": True}


# ── 成员列表 ──────────────────────────────────────────────────────────────────

@router.get("/circles/{circle_id}/members")
async def list_circle_members(circle_id: int, uid: int = Depends(get_current_user_id)):
    circle = await db.get_circle_by_id(circle_id)
    if not circle:
        raise HTTPException(404, "圈子不存在")
    if not await db.is_circle_member(circle_id, uid):
        raise HTTPException(403, "仅圈子成员可查看")
    members = await db.list_circle_members(circle_id)
    return {"members": members}


# ── 入圈预览 ──────────────────────────────────────────────────────────────────

@router.get("/circles/join/{code}")
async def preview_circle(code: str, uid: int = Depends(get_current_user_id)):
    circle = await db.get_circle_by_code(code)
    if not circle:
        raise HTTPException(404, "邀请链接无效")
    member_count = await db.circle_member_count(circle["id"])
    already = await db.is_circle_member(circle["id"], uid)
    full = member_count >= circle["max_members"]
    return {
        "circle": {
            "id": circle["id"],
            "name": circle["name"],
            "description": circle["description"],
            "member_count": member_count,
            "max_members": circle["max_members"],
        },
        "already_member": already,
        "full": full,
    }


# ── 入圈（已登录用户） ────────────────────────────────────────────────────────

@router.post("/circles/join/{code}")
async def join_circle(code: str, uid: int = Depends(get_current_user_id)):
    circle = await db.get_circle_by_code(code)
    if not circle:
        raise HTTPException(404, "邀请链接无效")

    if await db.is_circle_member(circle["id"], uid):
        return {"ok": True, "already_member": True, "full": False}

    member_count = await db.circle_member_count(circle["id"])
    if member_count >= circle["max_members"]:
        return {"ok": False, "already_member": False, "full": True, "message": "圈子已满，无法加入"}

    # Check join limit (non-owned circles)
    joined_only = await db.count_circles_joined_only(uid)
    # Only block when joining a circle they don't own
    if circle["owner_id"] != uid and joined_only >= MAX_JOINED:
        raise HTTPException(400, f"最多加入 {MAX_JOINED} 个圈子")

    await db.add_circle_member(circle["id"], uid)

    # Award the circle owner as default inviter
    invite_reward = float(await db.get_config("circle_invite_reward", "50"))
    if invite_reward > 0:
        owner_id = circle["owner_id"]
        if owner_id != uid:
            await db.award_credits(
                owner_id, invite_reward, type_="referral",
                note=f"邀请用户入圈 {circle['name']}"
            )

    return {"ok": True, "already_member": False, "full": False}

"""圈子接口：创建、管理、邀请入圈"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import database as db
from auth import get_current_user_id
from worker_pool import pool as _pool

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


# ── 入圈预览 / 入圈（须在 /circles/{circle_id} 之前注册） ─────────────────────

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

    joined_only = await db.count_circles_joined_only(uid)
    if circle["owner_id"] != uid and joined_only >= MAX_JOINED:
        raise HTTPException(400, f"最多加入 {MAX_JOINED} 个圈子")

    await db.add_circle_member(circle["id"], uid)

    invite_reward = float(await db.get_config("circle_invite_reward", "50"))
    if invite_reward > 0:
        owner_id = circle["owner_id"]
        if owner_id != uid:
            await db.award_credits(
                owner_id, invite_reward, type_="referral",
                note=f"邀请用户入圈 {circle['name']}"
            )

    return {"ok": True, "already_member": False, "full": False}


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


# ── 圈子详情（共享模型 + 帖子） ───────────────────────────────────────────────

async def _require_member(circle_id: int, uid: int) -> dict:
    circle = await db.get_circle_by_id(circle_id)
    if not circle:
        raise HTTPException(404, "圈子不存在")
    if not await db.is_circle_member(circle_id, uid):
        raise HTTPException(403, "仅圈子成员可访问")
    return circle


@router.get("/circles/{circle_id}")
async def get_circle_detail(circle_id: int, uid: int = Depends(get_current_user_id)):
    circle = await _require_member(circle_id, uid)
    member_count = await db.circle_member_count(circle_id)
    posts = await db.list_circle_posts(circle_id, uid)
    models = _pool.models_for_circle(circle_id)
    return {
        "circle": {
            "id": circle["id"],
            "name": circle["name"],
            "description": circle["description"],
            "code": circle["code"],
            "owner_id": circle["owner_id"],
            "max_members": circle["max_members"],
            "member_count": member_count,
            "is_owner": circle["owner_id"] == uid,
            "created_at": circle.get("created_at"),
        },
        "models": models,
        "posts": posts,
    }


class PostBody(BaseModel):
    content: str


@router.post("/circles/{circle_id}/posts")
async def create_post(circle_id: int, req: PostBody, uid: int = Depends(get_current_user_id)):
    await _require_member(circle_id, uid)
    text = (req.content or "").strip()
    if not text:
        raise HTTPException(400, "消息内容不能为空")
    if len(text) > 2000:
        raise HTTPException(400, "消息内容过长")
    try:
        post = await db.create_circle_announcement(circle_id, uid, text)
    except ValueError:
        raise HTTPException(400, "消息内容不能为空")
    post["replies"] = []
    return {"post": post}


@router.put("/circles/{circle_id}/posts/{post_id}")
async def update_post(
    circle_id: int, post_id: int, req: PostBody, uid: int = Depends(get_current_user_id)
):
    await _require_member(circle_id, uid)
    post = await db.get_circle_announcement(post_id)
    if not post or post["circle_id"] != circle_id:
        raise HTTPException(404, "消息不存在")
    if post["author_id"] != uid:
        raise HTTPException(403, "仅作者可编辑")
    text = (req.content or "").strip()
    if not text:
        raise HTTPException(400, "消息内容不能为空")
    if len(text) > 2000:
        raise HTTPException(400, "消息内容过长")
    updated = await db.update_circle_announcement(post_id, uid, text)
    if not updated:
        raise HTTPException(404, "消息不存在")
    full = await db.list_circle_posts(circle_id, uid)
    row = next((p for p in full if p["id"] == post_id), None)
    return {"post": row}


@router.delete("/circles/{circle_id}/posts/{post_id}")
async def delete_post(
    circle_id: int, post_id: int, uid: int = Depends(get_current_user_id)
):
    await _require_member(circle_id, uid)
    post = await db.get_circle_announcement(post_id)
    if not post or post["circle_id"] != circle_id:
        raise HTTPException(404, "消息不存在")
    if post["author_id"] != uid:
        raise HTTPException(403, "仅作者可删除")
    ok = await db.delete_circle_announcement(post_id, uid)
    if not ok:
        raise HTTPException(404, "消息不存在")
    return {"ok": True}


@router.post("/circles/{circle_id}/posts/{post_id}/replies")
async def create_post_reply(
    circle_id: int, post_id: int, req: PostBody, uid: int = Depends(get_current_user_id)
):
    await _require_member(circle_id, uid)
    post = await db.get_circle_announcement(post_id)
    if not post or post["circle_id"] != circle_id:
        raise HTTPException(404, "消息不存在")
    text = (req.content or "").strip()
    if not text:
        raise HTTPException(400, "回复内容不能为空")
    if len(text) > 1000:
        raise HTTPException(400, "回复内容过长")
    try:
        reply = await db.create_circle_post_reply(post_id, uid, text)
    except ValueError:
        raise HTTPException(400, "回复内容不能为空")
    return {"reply": reply}


@router.put("/circles/{circle_id}/posts/{post_id}/replies/{reply_id}")
async def update_post_reply(
    circle_id: int, post_id: int, reply_id: int, req: PostBody, uid: int = Depends(get_current_user_id)
):
    await _require_member(circle_id, uid)
    post = await db.get_circle_announcement(post_id)
    if not post or post["circle_id"] != circle_id:
        raise HTTPException(404, "消息不存在")
    reply = await db.get_circle_post_reply(reply_id)
    if not reply or reply["post_id"] != post_id:
        raise HTTPException(404, "回复不存在")
    if reply["author_id"] != uid:
        raise HTTPException(403, "仅作者可编辑")
    text = (req.content or "").strip()
    if not text:
        raise HTTPException(400, "回复内容不能为空")
    if len(text) > 1000:
        raise HTTPException(400, "回复内容过长")
    updated = await db.update_circle_post_reply(reply_id, uid, text)
    if not updated:
        raise HTTPException(404, "回复不存在")
    return {"reply": updated}


@router.delete("/circles/{circle_id}/posts/{post_id}/replies/{reply_id}")
async def delete_post_reply(
    circle_id: int, post_id: int, reply_id: int, uid: int = Depends(get_current_user_id)
):
    await _require_member(circle_id, uid)
    post = await db.get_circle_announcement(post_id)
    if not post or post["circle_id"] != circle_id:
        raise HTTPException(404, "消息不存在")
    reply = await db.get_circle_post_reply(reply_id)
    if not reply or reply["post_id"] != post_id:
        raise HTTPException(404, "回复不存在")
    if reply["author_id"] != uid:
        raise HTTPException(403, "仅作者可删除")
    ok = await db.delete_circle_post_reply(reply_id, uid)
    if not ok:
        raise HTTPException(404, "回复不存在")
    return {"ok": True}

"""用户头像：从 server/avatar 目录随机分配。"""

from __future__ import annotations

import random
from functools import lru_cache
from pathlib import Path

# 头像文件目录
AVATAR_DIR = Path(__file__).resolve().parent / "avatar"
# 对外 URL 前缀（与 server.py 路由一致）
AVATAR_URL_PREFIX = "/avatar"


@lru_cache(maxsize=1)
def list_avatar_filenames() -> tuple[str, ...]:
    """列出可用头像文件名（缓存，避免每次注册都扫盘）。"""
    if not AVATAR_DIR.is_dir():
        return ()
    names = sorted(
        p.name for p in AVATAR_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    )
    return tuple(names)


def pick_random_avatar_url() -> str:
    """随机选取一个头像，返回相对 URL（如 /avatar/avatar_01.png）。"""
    names = list_avatar_filenames()
    if not names:
        return ""
    return f"{AVATAR_URL_PREFIX}/{random.choice(names)}"


def resolve_avatar_path(filename: str) -> Path | None:
    """校验文件名并返回本地路径，非法则返回 None。"""
    safe = Path(filename).name
    if not safe or safe != filename:
        return None
    path = (AVATAR_DIR / safe).resolve()
    if not path.is_file() or path.parent != AVATAR_DIR.resolve():
        return None
    return path

"""首次启动时将 static/defaults 写入 system_config，保证客户端同步有内容可拉。"""

from pathlib import Path

import database as db

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"

_SEED_KEYS = (
    ("config.apps", "apps.default.yaml"),
    ("config.scenes", "scenes.default.yaml"),
)


async def seed_default_configs() -> None:
    """DB 中 config.apps / config.scenes 为空时，从内置 YAML 种子初始化。"""
    for key, filename in _SEED_KEYS:
        if await db.get_config(key, ""):
            continue
        path = _DEFAULTS_DIR / filename
        if not path.is_file():
            continue
        content = path.read_text(encoding="utf-8").strip()
        if content:
            await db.set_config(key, content)

"""首次启动时将 static/defaults 写入 system_config，保证客户端同步有内容可拉。"""

from pathlib import Path

import database as db
from config_merge import merge_apps_yaml_text

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

    # 已有 config.apps 时，与最新 apps.default.yaml 合并（补 subscription_to_api 等新字段）
    await migrate_apps_config_with_defaults()


async def migrate_apps_config_with_defaults() -> None:
    """将 DB 中的 config.apps 与内置默认合并后写回（有变更才更新）。"""
    content = await db.get_config("config.apps", "")
    if not content.strip():
        return
    merged = merge_apps_yaml_text(content)
    if merged and merged != content.strip():
        await db.set_config("config.apps", merged)

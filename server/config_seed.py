"""首次启动时将 static/defaults 写入 system_config，保证客户端同步有内容可拉。"""

from pathlib import Path

import yaml

import database as db
from config_merge import merge_apps_yaml_text, _BILLING_KEYS

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"

_SEED_KEYS = (
    ("config.apps", "apps.default.yaml"),
    ("config.scenes", "scenes.default.yaml"),
    ("config.sources", "sources.default.yaml"),
)


async def seed_default_configs() -> None:
    """DB 中 config.apps / config.scenes / config.sources 为空时，从内置 YAML 种子初始化。"""
    # 先把旧库 config.apps 里的计费段迁到独立 config.sources（必须在 seed config.sources 之前，
    # 否则用户自定义的计费段会被默认 sources.default.yaml 覆盖）。
    await migrate_billing_to_sources()

    for key, filename in _SEED_KEYS:
        if await db.get_config(key, ""):
            continue
        path = _DEFAULTS_DIR / filename
        if not path.is_file():
            continue
        content = path.read_text(encoding="utf-8").strip()
        if content:
            await db.set_config(key, content)

    # 已有 config.apps 时，与最新 apps.default.yaml 合并并剥离已迁出的计费段
    await migrate_apps_config_with_defaults()


async def migrate_billing_to_sources() -> None:
    """一次性迁移：把旧 config.apps 里的计费段（subscription_apps / api_subscription_apps /
    subscription_plans / payg_providers）抽出写入独立 config.sources。幂等：config.sources 已有则跳过。"""
    if await db.get_config("config.sources", ""):
        return
    apps_text = await db.get_config("config.apps", "")
    if not apps_text.strip():
        return
    try:
        apps_doc = yaml.safe_load(apps_text) or {}
    except yaml.YAMLError:
        return
    if not isinstance(apps_doc, dict):
        return
    billing = {k: apps_doc[k] for k in _BILLING_KEYS if k in apps_doc}
    if not billing:
        return
    sources_doc = {"version": 1, **billing}
    sources_yaml = yaml.dump(
        sources_doc, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    await db.set_config("config.sources", sources_yaml)


async def migrate_apps_config_with_defaults() -> None:
    """将 DB 中的 config.apps 与内置默认合并后写回（有变更才更新）。"""
    content = await db.get_config("config.apps", "")
    if not content.strip():
        return
    merged = merge_apps_yaml_text(content)
    if merged and merged != content.strip():
        await db.set_config("config.apps", merged)

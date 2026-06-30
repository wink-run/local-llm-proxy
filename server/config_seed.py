"""首次启动时将 static/defaults 写入 system_config，保证客户端同步有内容可拉。"""

from pathlib import Path

import yaml

import database as db
from config_merge import merge_apps_yaml_text, _BILLING_KEYS

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"

_SEED_KEYS = (
    ("config.apps", "apps.default.yaml"),
    ("config.scenes", "scenes.default.yaml"),
    ("config.providers", "providers.registry.yaml"),
)


async def seed_default_configs() -> None:
    """DB 中 config.apps / config.scenes / config.providers 为空时，从内置 YAML 种子初始化。"""
    # 旧库迁移：config.apps / config.sources 计费段 → config.providers（须在 seed 之前）
    await migrate_legacy_billing_to_providers()

    for key, filename in _SEED_KEYS:
        if await db.get_config(key, ""):
            continue
        if key == "config.apps":
            import app_catalog as ac
            compiled = ac.compile_apps_doc(ac.import_from_defaults())
            content = yaml.dump(
                compiled, allow_unicode=True, sort_keys=False, default_flow_style=False,
            ).rstrip()
        else:
            path = _DEFAULTS_DIR / filename
            if not path.is_file():
                continue
            content = path.read_text(encoding="utf-8").strip()
        if content:
            await db.set_config(key, content)

    await migrate_apps_config_with_defaults()
    await reconcile_providers_with_defaults()


async def reconcile_providers_with_defaults() -> None:
    """已有 config.providers 时，对账内置默认：默认里非空、但当前库里 models/pricing 为空的 payg 源补上。"""
    cur = await db.get_config("config.providers", "")
    if not cur.strip():
        return
    path = _DEFAULTS_DIR / "providers.registry.yaml"
    if not path.is_file():
        return
    try:
        doc = yaml.safe_load(cur) or {}
        deflt = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return
    if not isinstance(doc, dict) or not isinstance(deflt, dict):
        return
    def_by = {p.get("id"): p for p in (deflt.get("providers") or []) if isinstance(p, dict)}
    changed = False
    providers = doc.get("providers") or []
    for p in providers:
        if not isinstance(p, dict) or not p.get("payg"):
            continue
        d = def_by.get(p.get("id"))
        if not d:
            continue
        if not p.get("models") and d.get("models"):
            p["models"] = d["models"]
            changed = True
        if not p.get("pricing") and d.get("pricing"):
            p["pricing"] = d["pricing"]
            changed = True
    if changed:
        from provider_registry import serialize_registry_doc
        await db.set_config("config.providers", serialize_registry_doc(doc))


async def migrate_legacy_billing_to_providers() -> None:
    """一次性迁移：旧 config.sources / config.apps 计费段 → config.providers。幂等。"""
    if await db.get_config("config.providers", ""):
        return
    import billing_sources as bs

    sources_text = await db.get_config("config.sources", "")
    if sources_text.strip():
        try:
            doc = yaml.safe_load(sources_text) or {}
            sources = bs.import_from_billing_sections_doc(doc)
            if sources:
                await bs.publish_sources({"version": 1, "sources": sources})
                return
        except yaml.YAMLError:
            pass

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
    sources = bs.import_from_billing_sections_doc({"version": 1, **billing})
    if sources:
        await bs.publish_sources({"version": 1, "sources": sources})


async def migrate_apps_config_with_defaults() -> None:
    """将 DB 中的 config.apps 与内置默认合并后写回（有变更才更新）。"""
    content = await db.get_config("config.apps", "")
    if not content.strip():
        return
    merged = merge_apps_yaml_text(content)
    if merged and merged != content.strip():
        await db.set_config("config.apps", merged)
        content = merged
    await _ensure_app_entities_in_apps_config(content)


async def _ensure_app_entities_in_apps_config(content: str = "") -> None:
    """旧库仅有 tools 扁平段、或 merge 剥离后缺 app_entities → 从目录默认实体补全。"""
    if not content:
        content = await db.get_config("config.apps", "")
    if not content.strip():
        return
    try:
        doc = yaml.safe_load(content) or {}
    except yaml.YAMLError:
        return
    if not isinstance(doc, dict):
        return
    if doc.get("app_entities"):
        return
    import app_catalog as ac
    catalog = await ac.load_catalog_doc()
    entities = catalog.get("entities") or []
    if not entities:
        entities = ac.import_from_defaults().get("entities") or []
    if not entities:
        return
    compiled = ac.compile_apps_doc({"version": doc.get("version") or 1, "entities": entities})
    yaml_text = yaml.dump(
        compiled, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    await db.set_config("config.apps", yaml_text)

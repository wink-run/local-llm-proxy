"""一次性从 cc-switch（桌面端配置切换器）导入 provider presets。

设计文档：DESIGN_v2.md §2.4 + §7 决策 #3

数据来源：
  ~/.cc-switch/cc-switch.db   (SQLite, 用户安装 cc-switch 后存在)

导入策略：
  - 读 cc-switch 中已配置的 providers（用户已选定且有 key 的）
  - 转成本仓 paid_providers.yaml 兼容格式
  - 标记 imported_from: cc-switch 便于追溯
  - 不实时同步：只是一次性 snapshot，避免对方运营节奏改我们的 UI
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

CCSWITCH_DB = Path.home() / ".cc-switch" / "cc-switch.db"


def is_available() -> bool:
    return CCSWITCH_DB.exists()


def _safe_json(value: Any) -> dict:
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}


def read_providers() -> list[dict]:
    """返回 cc-switch 数据库中的 providers，归一为本仓 schema。

    cc-switch v3.x schema（基于源码 src-tauri/src/database/）：
      providers(id, name, settings_config TEXT, category, websiteUrl, ...)
      settings_config 是 JSON，含 env / model 等
    若 schema 变化，本函数尽量宽容（缺字段时跳过）。
    """
    if not CCSWITCH_DB.exists():
        return []

    conn = sqlite3.connect(str(CCSWITCH_DB))
    conn.row_factory = sqlite3.Row
    out: list[dict] = []

    try:
        # 探测 providers 表是否存在
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
            "('providers', 'provider_presets', 'claude_providers')"
        )
        tables = [r[0] for r in cur.fetchall()]
        if not tables:
            return []

        for tbl in tables:
            try:
                rows = conn.execute(f"SELECT * FROM {tbl}").fetchall()
            except sqlite3.DatabaseError:
                continue
            for r in rows:
                d = dict(r)
                settings = _safe_json(d.get("settings_config") or d.get("config"))
                env = (settings.get("env") or {}) if isinstance(settings, dict) else {}
                base_url = (
                    env.get("ANTHROPIC_BASE_URL")
                    or env.get("OPENAI_BASE_URL")
                    or env.get("OPENAI_API_BASE")
                    or settings.get("base_url")
                )
                if not base_url:
                    continue  # cc-switch 没有 URL 的条目我们用不了
                # cc-switch 通常不持久化 key（用户每次填）；如果有，导入但不存 keystore
                out.append({
                    "id": f"ccswitch-{d.get('id') or d.get('name', '')}",
                    "display": d.get("name") or d.get("title") or "imported",
                    "tier": "paid",
                    "base_url": base_url,
                    "auth": {"type": "bearer"},
                    "signup_url": d.get("websiteUrl") or d.get("website_url") or "",
                    "affiliate": bool(d.get("isPartner") or d.get("is_partner")),
                    "imported_from": "cc-switch",
                    "imported_at": "now",
                    "notes": f"Imported from cc-switch table {tbl}; key was NOT imported",
                })
    finally:
        conn.close()
    return out

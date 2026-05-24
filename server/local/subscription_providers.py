"""P1 订阅层（subscription → API 本地代理转换）—— scaffold。

设计文档：DESIGN_v2.md §6.3 Step 2，对应里程碑 M10

当前状态：**仅 schema / 占位**。
真正的浏览器自动化 + Cookie 转 API 需要：
  - 各平台（Claude.ai / chatgpt.com / Gemini Web）的会话刷新机制
  - Headless 浏览器（Playwright）持久化登录态
  - 速率限制 / 防风控
  - 与板块③ 贡献网络的 source_kind=subscription 数据通路

这些工作量较大且涉及 ToS 风险，先 ship scaffold，让 UI 能展示「即将推出」状态。

后续接入时：
  1. 把 subscription_providers 表填充 cookie / session 信息
  2. 启一个 Playwright 子进程做会话保活
  3. /v1/chat/completions 路由识别 subscription provider 时，转给本模块的 dispatch_subscription_request
  4. 把使用配额写回贡献池（供 contribute 结算）
"""

from __future__ import annotations

import aiosqlite

from local_db import LOCAL_DB_PATH


async def init_subscription_db() -> None:
    """幂等创建 subscription_providers 表。"""
    async with aiosqlite.connect(LOCAL_DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS subscription_providers (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                platform     TEXT NOT NULL,         -- 'claude_pro' / 'chatgpt_plus' / 'gemini_advanced'
                display_name TEXT NOT NULL,
                cookie_ref   TEXT DEFAULT '',       -- keystore 中 cookie 的 key
                session_ref  TEXT DEFAULT '',       -- 长期 session token 的 key
                model_map    TEXT DEFAULT '{}',     -- JSON：API 模型名 → 平台内部模型
                rpm_limit    REAL DEFAULT 0,
                enabled      INTEGER DEFAULT 0,
                last_ok_at   TEXT DEFAULT '',
                last_error   TEXT DEFAULT '',
                created_at   TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


SUPPORTED_PLATFORMS = [
    {
        "id": "claude_pro",
        "display": "Claude Pro (claude.ai)",
        "login_url": "https://claude.ai/login",
        "model_map_default": {
            "claude-3-7-sonnet": "claude-3-7-sonnet-20250219",
            "claude-3-5-haiku": "claude-3-5-haiku-20241022",
        },
        "status": "wip",  # work-in-progress
    },
    {
        "id": "chatgpt_plus",
        "display": "ChatGPT Plus (chatgpt.com)",
        "login_url": "https://chatgpt.com/auth/login",
        "model_map_default": {
            "gpt-4o": "gpt-4o",
            "gpt-4o-mini": "gpt-4o-mini",
        },
        "status": "wip",
    },
    {
        "id": "gemini_advanced",
        "display": "Gemini Advanced (gemini.google.com)",
        "login_url": "https://accounts.google.com/signin",
        "model_map_default": {
            "gemini-1.5-pro": "gemini-1.5-pro-002",
        },
        "status": "wip",
    },
]


def list_supported_platforms() -> list[dict]:
    return SUPPORTED_PLATFORMS


async def dispatch_subscription_request(platform: str, payload: dict) -> dict:
    """TODO: 把 OpenAI-compatible 请求转换成平台原生格式，并通过持久登录态调用。"""
    raise NotImplementedError(
        f"Subscription dispatch for '{platform}' is not yet implemented. "
        "This is a scaffold for P1 / M10."
    )

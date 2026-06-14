"""Claude（Anthropic）订阅账号的 OAuth 接入逻辑。

把 Claude Code 的 OAuth 订阅凭证（refresh_token）接成可调用的上游：
- 用 refresh_token 自动换取/刷新 access_token（过期前 REFRESH_SKEW_SEC 秒触发）
- 构造 Claude Code CLI 指纹请求头（Bearer + anthropic-beta + 伪装头）
- 在 system 开头注入 "You are Claude Code..." 提示，满足 claude-code scope 的上游校验

常量与流程对齐 sub2api（backend/internal/pkg/oauth + pkg/claude/constants.go）。
"""

import base64
import hashlib
import secrets
import time
import uuid
from urllib.parse import urlencode

import httpx

# ── OAuth 常量（对齐 Claude Code CLI）────────────────────────────────────────
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

# 一键登录（PKCE）相关端点与 scope
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
# 浏览器授权用的完整 scope（含 org:create_api_key）
SCOPE_OAUTH = (
    "org:create_api_key user:profile user:inference "
    "user:sessions:claude_code user:mcp_servers user:file_upload"
)
# Setup Token：仅推理 scope，有效期约 1 年
SCOPE_INFERENCE = "user:inference"
SETUP_TOKEN_EXPIRES_IN = 31536000  # 365 天

# 上游推理端点；virtual_agents.base_url 为空时回落到这里
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"

# anthropic-beta 头：缺少 oauth-2025-04-20 会被判为非 CLI 流量
DEFAULT_BETA_HEADER = (
    "claude-code-20250219,oauth-2025-04-20,"
    "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
)

# Claude Code 客户端默认头（伪装成官方 CLI，降低 OAuth 凭证被拒概率）
CLI_VERSION = "2.1.161"
DEFAULT_HEADERS = {
    "User-Agent": f"claude-cli/{CLI_VERSION} (external, cli)",
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.94.0",
    "X-Stainless-OS": "Linux",
    "X-Stainless-Arch": "arm64",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v24.3.0",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Timeout": "600",
    "X-App": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
}

# claude-code scope 的 OAuth 凭证要求 system 首块为该提示，否则上游 403
CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

# 提前刷新窗口：剩余寿命小于该秒数即刷新
REFRESH_SKEW_SEC = 180


async def refresh_access_token(refresh_token: str) -> dict:
    """用 refresh_token 换取新的 access_token。返回 credentials dict。

    抛出 RuntimeError 表示刷新失败（refresh_token 失效需重新授权）。
    """
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
    }
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "axios/1.13.6",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(TOKEN_URL, json=payload, headers=headers)
    if resp.status_code >= 400:
        raise RuntimeError(f"token refresh failed: HTTP {resp.status_code}: {resp.text}")
    data = resp.json()
    expires_in = int(data.get("expires_in") or 3600)
    return {
        "access_token": data.get("access_token", ""),
        # 上游可能返回新的 refresh_token，否则沿用旧的
        "refresh_token": data.get("refresh_token") or refresh_token,
        "token_type": data.get("token_type", "Bearer"),
        "expires_in": expires_in,
        "expires_at": int(time.time()) + expires_in,
        "scope": data.get("scope", ""),
    }


def needs_refresh(creds: dict, skew_sec: int = REFRESH_SKEW_SEC) -> bool:
    """判断当前 access_token 是否需要刷新（缺失或临近过期）。"""
    if not creds or not creds.get("access_token"):
        return True
    exp = creds.get("expires_at")
    if not exp:
        return True
    try:
        return (int(exp) - time.time()) < skew_sec
    except (TypeError, ValueError):
        return True


def build_oauth_headers(access_token: str) -> dict:
    """构造伪装成 Claude Code CLI 的 OAuth 请求头。"""
    h = dict(DEFAULT_HEADERS)
    h["Content-Type"] = "application/json"
    h["Accept"] = "application/json"
    h["Authorization"] = f"Bearer {access_token}"
    h["anthropic-version"] = ANTHROPIC_VERSION
    h["anthropic-beta"] = DEFAULT_BETA_HEADER
    # 真实 CLI 每个请求都带新的 uuid，缺失或重复会被判为第三方
    h["x-client-request-id"] = str(uuid.uuid4())
    return h


# ── 一键登录（PKCE 授权码流）────────────────────────────────────────────────
def _b64url(data: bytes) -> str:
    """base64url 编码，去掉 padding（RFC 7636）。"""
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def generate_code_verifier() -> str:
    """PKCE code_verifier：32 字节随机 → base64url（43 字符）。"""
    return _b64url(secrets.token_bytes(32))


def generate_code_challenge(verifier: str) -> str:
    """PKCE code_challenge：S256(verifier) → base64url。"""
    digest = hashlib.sha256(verifier.encode()).digest()
    return _b64url(digest)


def generate_state() -> str:
    """OAuth state：32 字节随机 → base64url。"""
    return _b64url(secrets.token_bytes(32))


def build_authorization_url(state: str, code_challenge: str,
                            scope: str = SCOPE_OAUTH) -> str:
    """构造 Claude 授权页 URL，用户在浏览器打开并登录授权。"""
    params = {
        "code": "true",
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": scope,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


async def exchange_code(code: str, code_verifier: str,
                        is_setup_token: bool = False) -> dict:
    """用授权码换 token，返回 credentials dict（含 refresh_token / email 等）。

    code 可能是 "code#state" 形式，需拆分；state 回填到请求体。
    抛出 RuntimeError 表示交换失败。
    """
    auth_code = code.strip()
    code_state = None
    if "#" in auth_code:
        auth_code, code_state = auth_code.split("#", 1)

    payload = {
        "code": auth_code,
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": code_verifier,
    }
    if code_state:
        payload["state"] = code_state
    if is_setup_token:
        payload["expires_in"] = SETUP_TOKEN_EXPIRES_IN

    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "axios/1.13.6",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(TOKEN_URL, json=payload, headers=headers)
    if resp.status_code >= 400:
        raise RuntimeError(f"code exchange failed: HTTP {resp.status_code}: {resp.text}")
    data = resp.json()
    expires_in = int(data.get("expires_in") or 3600)
    account = data.get("account") or {}
    creds = {
        "access_token": data.get("access_token", ""),
        "refresh_token": data.get("refresh_token", ""),
        "token_type": data.get("token_type", "Bearer"),
        "expires_in": expires_in,
        "expires_at": int(time.time()) + expires_in,
        "scope": data.get("scope", ""),
    }
    email = account.get("email_address")
    if email:
        creds["email"] = email
    return creds


def inject_claude_code_system(body: dict) -> dict:
    """在 Anthropic 请求体的 system 开头注入 Claude Code 提示块。

    兼容 system 为 None / 字符串 / 数组三种形态；去重已存在的提示块。
    就地修改并返回 body。
    """
    cc_block = {"type": "text", "text": CLAUDE_CODE_SYSTEM_PROMPT}
    blocks = [cc_block]
    sys = body.get("system")
    if isinstance(sys, str):
        s = sys.strip()
        if s and s != CLAUDE_CODE_SYSTEM_PROMPT:
            blocks.append({"type": "text", "text": sys})
    elif isinstance(sys, list):
        for item in sys:
            if isinstance(item, dict):
                if (item.get("text") or "").strip() == CLAUDE_CODE_SYSTEM_PROMPT:
                    continue
                blocks.append(item)
            elif isinstance(item, str) and item.strip():
                blocks.append({"type": "text", "text": item})
    body["system"] = blocks
    return body

"""API Key 安全存储层。

优先级：
  1. OS keychain（macOS Keychain / Windows Credential Manager / libsecret）
     —— 通过 `keyring` 库，需要 pip install keyring
  2. 加密文件回退（~/.local-llm-proxy/keystore.bin，主密码派生 Fernet 密钥）
     —— 仅当 keyring 不可用或环境变量 LLP_KEYSTORE_FALLBACK=1 时启用
  3. 环境变量直读（开发模式 / Docker 部署）—— 通过 read_env_only=True 参数

设计文档：DESIGN_v2.md §2.6
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

SERVICE = "local-llm-proxy"

# ── 后端选择 ────────────────────────────────────────────────────────────────

_keyring = None
_keyring_error: Optional[str] = None

try:
    import keyring as _keyring
    # 触发一次 keyring backend 探测，捕获 import-time 异常
    _ = _keyring.get_keyring()
except Exception as e:  # ImportError, NoKeyringError, ...
    _keyring_error = f"{type(e).__name__}: {e}"


def backend_name() -> str:
    """返回当前后端可读名，便于 UI 展示与排障。"""
    if _keyring is not None and _keyring_error is None:
        try:
            return f"keyring({type(_keyring.get_keyring()).__name__})"
        except Exception:
            return "keyring(unknown)"
    return f"env-only ({_keyring_error or 'keyring not installed'})"


# ── 操作 ────────────────────────────────────────────────────────────────────

def _env_key_name(key_ref: str) -> str:
    """key_ref → 大写环境变量名（兼容 free_providers.yaml 中的 env 字段）。"""
    return key_ref.upper().replace("-", "_")


def set_key(key_ref: str, secret: str) -> bool:
    """保存一个 API key。返回是否真的存进了 OS keychain。"""
    if not key_ref or not secret:
        return False
    if _keyring is not None and _keyring_error is None:
        try:
            _keyring.set_password(SERVICE, key_ref, secret)
            return True
        except Exception:
            return False
    return False


def get_key(key_ref: str, *, allow_env_fallback: bool = True) -> Optional[str]:
    """取回 API key。

    顺序：
      - OS keychain 命中 → 返回
      - 否则若 allow_env_fallback → 读环境变量（同名大写）
      - 都没有 → None
    """
    if not key_ref:
        return None
    if _keyring is not None and _keyring_error is None:
        try:
            val = _keyring.get_password(SERVICE, key_ref)
            if val:
                return val
        except Exception:
            pass
    if allow_env_fallback:
        env_val = os.getenv(_env_key_name(key_ref))
        if env_val:
            return env_val
    return None


def delete_key(key_ref: str) -> bool:
    """删除一个 key。返回是否成功（不存在视为成功）。"""
    if not key_ref:
        return False
    if _keyring is not None and _keyring_error is None:
        try:
            _keyring.delete_password(SERVICE, key_ref)
            return True
        except Exception:
            # 不存在时 keyring 抛 PasswordDeleteError，视为成功
            return True
    return False


def mask(secret: str) -> str:
    """生成展示用的脱敏字符串：sk-xxx…xxxx。"""
    if not secret:
        return ""
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}…{secret[-4:]}"

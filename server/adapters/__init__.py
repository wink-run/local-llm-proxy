"""Provider 协议适配器集合。

设计借鉴 one-api/relay/adaptor（Go 实现），port 关键 3 个 adapter 到 Python：
- openai_passthrough：默认，不做转换
- anthropic：OpenAI Chat ↔ Anthropic Messages
- gemini：OpenAI Chat ↔ Gemini Native generateContent

注册中心：通过 get_adapter(protocol) 拿 adapter 实例。
"""

from __future__ import annotations

from .base import ProviderAdapter, AdapterResult
from . import openai_passthrough
from . import anthropic
from . import gemini

_REGISTRY: dict[str, ProviderAdapter] = {
    "openai":        openai_passthrough.OpenAIPassthroughAdapter(),
    "anthropic":     anthropic.AnthropicAdapter(),
    "gemini_native": gemini.GeminiNativeAdapter(),
}


def get_adapter(protocol: str | None) -> ProviderAdapter:
    """根据 protocol 字段返回 adapter；缺失 / 未知时退回 openai passthrough。"""
    return _REGISTRY.get((protocol or "openai").lower(), _REGISTRY["openai"])


def known_protocols() -> list[str]:
    return list(_REGISTRY.keys())


__all__ = ["ProviderAdapter", "AdapterResult", "get_adapter", "known_protocols"]

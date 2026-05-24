"""默认 adapter：纯透传，不做任何格式转换。

适用于所有 OpenAI 兼容 provider（Groq、Cerebras、Gemini AI Studio /v1beta/openai、
GitHub Models、SiliconFlow、智谱、DeepSeek、Moonshot、xAI、OpenRouter 等绝大多数）。
"""

from __future__ import annotations

from typing import AsyncIterator, Optional

from .base import ProviderAdapter, AdapterResult


class OpenAIPassthroughAdapter(ProviderAdapter):
    @property
    def name(self) -> str:
        return "openai"

    @property
    def description(self) -> str:
        return "OpenAI Chat Completions 兼容，直接透传"

    def build_request(
        self,
        base_url: str,
        api_key: Optional[str],
        openai_body: dict,
        request_headers: dict,
    ) -> AdapterResult:
        url = (base_url or "").rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        # 透传部分有用的客户端 header（不含 Authorization 防泄漏）
        for k in ("anthropic-version", "openai-organization"):
            if k in request_headers:
                headers[k] = request_headers[k]
        return AdapterResult(url=url, headers=headers, body=openai_body)

    def convert_response(self, upstream_json: dict, *, model: str) -> dict:
        return upstream_json  # 已经是 OpenAI 格式

    async def convert_stream(
        self,
        upstream_bytes_iter: AsyncIterator[bytes],
        *,
        model: str,
    ) -> AsyncIterator[bytes]:
        async for chunk in upstream_bytes_iter:
            if chunk:
                yield chunk

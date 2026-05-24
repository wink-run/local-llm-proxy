"""Adapter 抽象基类。

对应 one-api/relay/adaptor/interface.go 的 Adaptor interface（精简到 Python 必需）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional


@dataclass
class AdapterResult:
    """convert_request 的输出。"""
    url: str                               # 完整上游 URL
    headers: dict                          # 完整请求头（含鉴权）
    body: dict | None                      # JSON body；None = 用 query string（gemini）


class ProviderAdapter(ABC):
    """统一适配器接口。

    生命周期（每次请求）：
      1. build_request(base_url, api_key, openai_body, request_headers) → AdapterResult
      2. （httpx 发请求）
      3a. 非流式：convert_response(upstream_json) → openai_compatible_json
      3b. 流式：convert_stream(upstream_bytes_iter) → openai_compatible_sse_iter
    """

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    def description(self) -> str:
        return ""

    @abstractmethod
    def build_request(
        self,
        base_url: str,
        api_key: Optional[str],
        openai_body: dict,
        request_headers: dict,
    ) -> AdapterResult:
        """组装上游请求。openai_body 是 OpenAI Chat Completions 格式。"""

    @abstractmethod
    def convert_response(self, upstream_json: dict, *, model: str) -> dict:
        """上游非流式响应 → OpenAI Chat Completions 格式 JSON。"""

    @abstractmethod
    async def convert_stream(
        self,
        upstream_bytes_iter: AsyncIterator[bytes],
        *,
        model: str,
    ) -> AsyncIterator[bytes]:
        """上游 SSE 流 → OpenAI SSE 流。"""

    # ── 帮助方法：派生类共用 ───────────────────────────────────────

    @staticmethod
    def extract_system_prompt(messages: list[dict]) -> tuple[Optional[str], list[dict]]:
        """从 OpenAI messages 中抽出第一条 system，剩下的消息单独返回。"""
        system_text: Optional[str] = None
        rest: list[dict] = []
        for m in messages or []:
            if m.get("role") == "system" and system_text is None:
                c = m.get("content")
                if isinstance(c, str):
                    system_text = c
                elif isinstance(c, list):
                    system_text = "".join(p.get("text", "") for p in c if p.get("type") in (None, "text"))
                continue
            rest.append(m)
        return system_text, rest

    @staticmethod
    def join_string_content(content) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                p.get("text", "") for p in content if p.get("type") in (None, "text")
            )
        return ""

"""Gemini Native adapter —— OpenAI Chat ↔ Gemini generateContent 互转。

参考 one-api/relay/adaptor/gemini/main.go。Python port。

URL：
  非流式：{base}/v1beta/models/{model}:generateContent?key=API_KEY
  流式：  {base}/v1beta/models/{model}:streamGenerateContent?alt=sse&key=API_KEY

注意：Gemini API key 走 query string，不是 header。
"""

from __future__ import annotations

import json
import time
import uuid
from typing import AsyncIterator, Optional
from urllib.parse import quote

from .base import ProviderAdapter, AdapterResult


# 安全设置：全部最低（让 gemini 别那么多 refusal）
_SAFETY_SETTINGS = [
    {"category": cat, "threshold": "BLOCK_NONE"}
    for cat in (
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_CIVIC_INTEGRITY",
    )
]

_MIME_TYPE_MAP = {
    "json_object": "application/json",
    "text":        "text/plain",
}

_FINISH_REASON_MAP = {
    "STOP":             "stop",
    "MAX_TOKENS":       "length",
    "SAFETY":           "content_filter",
    "RECITATION":       "content_filter",
    "OTHER":            "stop",
    "FINISH_REASON_UNSPECIFIED": None,
}


# ── 请求转换 ───────────────────────────────────────────────────────


def convert_request_openai_to_gemini(openai_body: dict) -> dict:
    out: dict = {
        "contents": [],
        "safetySettings": _SAFETY_SETTINGS,
        "generationConfig": _build_generation_config(openai_body),
    }

    # system instruction（Gemini 1.5+ 支持顶层 systemInstruction）
    system_text, rest_msgs = ProviderAdapter.extract_system_prompt(openai_body.get("messages") or [])
    if system_text:
        out["systemInstruction"] = {"parts": [{"text": system_text}]}

    # tools → functionDeclarations
    if openai_body.get("tools"):
        decls = []
        for t in openai_body["tools"]:
            fn = t.get("function") or {}
            decls.append({
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
            })
        if decls:
            out["tools"] = [{"functionDeclarations": decls}]

    # messages → contents
    for m in rest_msgs:
        role = m.get("role", "user")
        # Gemini 只接受 user / model 两个 role
        gemini_role = "model" if role == "assistant" else "user"
        parts = _convert_parts(m)
        if parts:
            out["contents"].append({"role": gemini_role, "parts": parts})

    return out


def _build_generation_config(openai_body: dict) -> dict:
    gc: dict = {}
    if "temperature" in openai_body:    gc["temperature"]     = openai_body["temperature"]
    if "top_p" in openai_body:          gc["topP"]            = openai_body["top_p"]
    if "top_k" in openai_body:          gc["topK"]            = openai_body["top_k"]
    if "max_tokens" in openai_body:     gc["maxOutputTokens"] = openai_body["max_tokens"]
    if "stop" in openai_body:
        v = openai_body["stop"]
        gc["stopSequences"] = v if isinstance(v, list) else [v]
    rf = openai_body.get("response_format")
    if rf:
        mt = _MIME_TYPE_MAP.get(rf.get("type"))
        if mt:
            gc["responseMimeType"] = mt
        if rf.get("json_schema") and isinstance(rf["json_schema"], dict):
            schema = rf["json_schema"].get("schema")
            if schema:
                gc["responseSchema"] = schema
                gc["responseMimeType"] = _MIME_TYPE_MAP["json_object"]
    return gc


def _convert_parts(message: dict) -> list[dict]:
    parts: list[dict] = []
    content = message.get("content")
    if isinstance(content, str):
        if content:
            parts.append({"text": content})
    elif isinstance(content, list):
        for p in content:
            t = p.get("type")
            if t in (None, "text"):
                if p.get("text"):
                    parts.append({"text": p["text"]})
            elif t == "image_url":
                url = (p.get("image_url") or {}).get("url", "")
                # 简化：URL 透传给 Gemini fileData；one-api 是 inline base64
                if url.startswith("data:"):
                    # data:mime;base64,xxxx
                    try:
                        header, b64 = url.split(",", 1)
                        mime = header.split(":", 1)[1].split(";", 1)[0]
                        parts.append({"inlineData": {"mimeType": mime, "data": b64}})
                    except (ValueError, IndexError):
                        pass
                # else: 跳过（不 fetch URL）

    # assistant 的 tool_calls → functionCall parts
    for tc in (message.get("tool_calls") or []):
        fn = tc.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except (TypeError, json.JSONDecodeError):
            args = {}
        parts.append({"functionCall": {"name": fn.get("name", ""), "args": args}})

    # role=tool → functionResponse
    if message.get("role") == "tool":
        try:
            payload = json.loads(content) if isinstance(content, str) else (content or {})
        except (TypeError, json.JSONDecodeError):
            payload = {"result": str(content)}
        parts = [{
            "functionResponse": {
                "name":     message.get("name") or "tool",
                "response": payload if isinstance(payload, dict) else {"result": payload},
            }
        }]

    return parts


# ── 响应转换（非流式） ──────────────────────────────────────────────


def convert_response_gemini_to_openai(gemini_resp: dict, *, model: str) -> dict:
    """generateContent JSON → OpenAI Chat Completions JSON。"""
    candidates = gemini_resp.get("candidates") or []
    if not candidates:
        # 可能是 promptFeedback.blockReason
        msg = (gemini_resp.get("promptFeedback") or {}).get("blockReason") or "no candidates"
        return _empty_response(model, error=msg)

    cand = candidates[0]
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for p in (cand.get("content") or {}).get("parts") or []:
        if "text" in p:
            text_parts.append(p["text"])
        elif "functionCall" in p:
            fc = p["functionCall"]
            tool_calls.append({
                "id":   f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {
                    "name":      fc.get("name", ""),
                    "arguments": json.dumps(fc.get("args") or {}, ensure_ascii=False),
                },
            })

    message: dict = {"role": "assistant", "content": "".join(text_parts) or None}
    if tool_calls:
        message["tool_calls"] = tool_calls

    usage = gemini_resp.get("usageMetadata") or {}
    in_t = usage.get("promptTokenCount") or 0
    out_t = usage.get("candidatesTokenCount") or 0
    total = usage.get("totalTokenCount") or (in_t + out_t)

    finish = _FINISH_REASON_MAP.get(cand.get("finishReason"), "stop")
    return {
        "id":      f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object":  "chat.completion",
        "created": int(time.time()),
        "model":   model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {
            "prompt_tokens":     in_t,
            "completion_tokens": out_t,
            "total_tokens":      total,
        },
    }


def _empty_response(model: str, *, error: str = "") -> dict:
    return {
        "id":      f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object":  "chat.completion",
        "created": int(time.time()),
        "model":   model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": ""},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "_llp_warning": error,
    }


# ── 流式转换 ────────────────────────────────────────────────────────


def _openai_stream_chunk(model: str, *, content: str | None = None,
                          role: str | None = None, tool_calls: list | None = None,
                          finish_reason: str | None = None) -> bytes:
    delta: dict = {}
    if role is not None:    delta["role"] = role
    if content is not None: delta["content"] = content
    if tool_calls:          delta["tool_calls"] = tool_calls
    chunk = {
        "id":      f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object":  "chat.completion.chunk",
        "created": int(time.time()),
        "model":   model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")


async def convert_stream_gemini_to_openai(
    upstream_bytes_iter: AsyncIterator[bytes],
    *, model: str,
) -> AsyncIterator[bytes]:
    """Gemini SSE（每行一个 data: {...candidate} JSON）→ OpenAI SSE。"""
    buf = b""
    role_sent = False

    async for raw in upstream_bytes_iter:
        if not raw:
            continue
        buf += raw
        # Gemini SSE: 一行 'data: {...}' 后 '\n\n'
        while b"\n\n" in buf:
            block, buf = buf.split(b"\n\n", 1)
            for line in block.split(b"\n"):
                line = line.strip()
                if not line.startswith(b"data:"):
                    continue
                data_str = line[5:].strip()
                if not data_str or data_str == b"[DONE]":
                    continue
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if not role_sent:
                    yield _openai_stream_chunk(model, role="assistant", content="")
                    role_sent = True

                candidates = data.get("candidates") or []
                if not candidates:
                    continue
                cand = candidates[0]
                for p in (cand.get("content") or {}).get("parts") or []:
                    if "text" in p:
                        yield _openai_stream_chunk(model, content=p["text"])
                    elif "functionCall" in p:
                        fc = p["functionCall"]
                        yield _openai_stream_chunk(model, tool_calls=[{
                            "index": 0,
                            "id":    f"call_{uuid.uuid4().hex[:8]}",
                            "type":  "function",
                            "function": {
                                "name":      fc.get("name", ""),
                                "arguments": json.dumps(fc.get("args") or {}, ensure_ascii=False),
                            },
                        }])
                fr = cand.get("finishReason")
                if fr and fr != "FINISH_REASON_UNSPECIFIED":
                    yield _openai_stream_chunk(model, finish_reason=_FINISH_REASON_MAP.get(fr, "stop"))

    yield b"data: [DONE]\n\n"


# ── Adapter 类 ──────────────────────────────────────────────────────


class GeminiNativeAdapter(ProviderAdapter):
    @property
    def name(self) -> str:
        return "gemini_native"

    @property
    def description(self) -> str:
        return "Gemini Native generateContent；自动 OpenAI ⇆ Gemini 互转"

    def build_request(
        self,
        base_url: str,
        api_key: Optional[str],
        openai_body: dict,
        request_headers: dict,
    ) -> AdapterResult:
        model = openai_body.get("model", "")
        stream = bool(openai_body.get("stream", False))
        action = "streamGenerateContent" if stream else "generateContent"
        base = (base_url or "").rstrip("/")
        # Gemini API key 在 query string
        key_param = f"?key={quote(api_key)}" if api_key else ""
        if stream and key_param:
            key_param += "&alt=sse"
        elif stream:
            key_param = "?alt=sse"
        url = f"{base}/v1beta/models/{model}:{action}{key_param}"
        headers = {"Content-Type": "application/json"}
        gemini_body = convert_request_openai_to_gemini(openai_body)
        return AdapterResult(url=url, headers=headers, body=gemini_body)

    def convert_response(self, upstream_json: dict, *, model: str) -> dict:
        return convert_response_gemini_to_openai(upstream_json, model=model)

    async def convert_stream(
        self,
        upstream_bytes_iter: AsyncIterator[bytes],
        *, model: str,
    ) -> AsyncIterator[bytes]:
        async for chunk in convert_stream_gemini_to_openai(upstream_bytes_iter, model=model):
            yield chunk

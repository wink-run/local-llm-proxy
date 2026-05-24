"""Anthropic adapter —— OpenAI Chat ↔ Anthropic Messages 互转。

参考实现：one-api/relay/adaptor/anthropic/main.go（Go 版）
本文件是 Python port，逻辑等价但更紧凑（去掉 gin / image url 处理等无关代码）。

支持：
- system 抽取
- tools / tool_choice 转换
- tool_use / tool_result 在消息流中处理
- 流式 6 类 SSE event → OpenAI delta
- finish_reason 映射

不支持（与本仓 P0 范围一致）：
- image_url 转 base64（local 网关不做图像缓存）；可后续加
- 工具调用的 PartialJson 累积（本 port 简化为按 chunk 透传）
"""

from __future__ import annotations

import json
import time
import uuid
from typing import AsyncIterator, Optional

from .base import ProviderAdapter, AdapterResult


# ── 静态映射 ────────────────────────────────────────────────────────


def _stop_reason_anthropic_to_openai(reason: str | None) -> str:
    return {
        "end_turn":      "stop",
        "stop_sequence": "stop",
        "max_tokens":    "length",
        "tool_use":      "tool_calls",
    }.get(reason or "", reason or "stop")


# ── 请求转换 ───────────────────────────────────────────────────────


def convert_request_openai_to_anthropic(openai_body: dict) -> dict:
    """OpenAI Chat Completions → Anthropic Messages API。

    one-api ConvertRequest 的 Python 版。
    """
    out: dict = {
        "model":  openai_body.get("model", ""),
        "stream": bool(openai_body.get("stream", False)),
    }
    if "max_tokens" in openai_body:
        out["max_tokens"] = openai_body["max_tokens"]
    else:
        out["max_tokens"] = 4096   # one-api 默认
    for k in ("temperature", "top_p", "top_k", "stop"):
        if k in openai_body:
            # OpenAI 'stop' → Anthropic 'stop_sequences'
            if k == "stop":
                v = openai_body[k]
                out["stop_sequences"] = v if isinstance(v, list) else [v]
            else:
                out[k] = openai_body[k]

    # 抽 system
    system_text, rest_msgs = ProviderAdapter.extract_system_prompt(openai_body.get("messages") or [])
    if system_text:
        out["system"] = system_text

    # 转 messages
    anthropic_msgs: list[dict] = []
    for m in rest_msgs:
        role = m.get("role", "user")
        content = m.get("content")
        tool_calls = m.get("tool_calls") or []
        tool_call_id = m.get("tool_call_id")

        # role=tool → 转为 user 消息，content 是 tool_result block
        if role == "tool":
            anthropic_msgs.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": _content_to_text(content),
                }],
            })
            continue

        blocks: list[dict] = []
        # 文本 / 图像 blocks
        if isinstance(content, str):
            if content:
                blocks.append({"type": "text", "text": content})
        elif isinstance(content, list):
            for part in content:
                t = part.get("type")
                if t in (None, "text"):
                    blocks.append({"type": "text", "text": part.get("text", "")})
                elif t == "image_url":
                    # 简化：透传 URL 字符串；one-api 这里 fetch + base64，我们不做
                    url = (part.get("image_url") or {}).get("url", "")
                    blocks.append({
                        "type": "image",
                        "source": {"type": "url", "url": url},
                    })

        # assistant 的 tool_calls → tool_use blocks
        for tc in tool_calls:
            fn = tc.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except (TypeError, json.JSONDecodeError):
                args = {}
            blocks.append({
                "type":  "tool_use",
                "id":    tc.get("id"),
                "name":  fn.get("name"),
                "input": args,
            })

        if blocks:
            anthropic_msgs.append({"role": role, "content": blocks})

    out["messages"] = anthropic_msgs

    # tools / tool_choice
    if openai_body.get("tools"):
        out["tools"] = _convert_tools(openai_body["tools"])
        tc = openai_body.get("tool_choice")
        if tc is not None:
            out["tool_choice"] = _convert_tool_choice(tc)

    return out


def _convert_tools(openai_tools: list[dict]) -> list[dict]:
    out = []
    for t in openai_tools:
        fn = t.get("function") or {}
        params = fn.get("parameters") or {"type": "object", "properties": {}}
        out.append({
            "name": fn.get("name", ""),
            "description": fn.get("description", ""),
            "input_schema": params,
        })
    return out


def _convert_tool_choice(tc) -> dict:
    if isinstance(tc, str):
        if tc == "auto":  return {"type": "auto"}
        if tc == "any":   return {"type": "any"}
        if tc == "none":  return {"type": "auto"}   # Anthropic 没 none，退回 auto
        return {"type": "auto"}
    if isinstance(tc, dict):
        fn = tc.get("function") or {}
        if fn.get("name"):
            return {"type": "tool", "name": fn["name"]}
    return {"type": "auto"}


def _content_to_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if p.get("type") in (None, "text"))
    return str(content) if content is not None else ""


# ── 非流式响应转换 ──────────────────────────────────────────────────


def convert_response_anthropic_to_openai(anthropic_resp: dict, *, model: str) -> dict:
    """Anthropic Messages 响应 → OpenAI Chat Completions 响应。"""
    text_parts = []
    tool_calls = []
    for block in anthropic_resp.get("content") or []:
        bt = block.get("type")
        if bt == "text":
            text_parts.append(block.get("text", ""))
        elif bt == "tool_use":
            tool_calls.append({
                "id":   block.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {
                    "name":      block.get("name", ""),
                    "arguments": json.dumps(block.get("input") or {}, ensure_ascii=False),
                },
            })

    message: dict = {"role": "assistant", "content": "".join(text_parts) or None}
    if tool_calls:
        message["tool_calls"] = tool_calls

    usage = anthropic_resp.get("usage") or {}
    in_t = usage.get("input_tokens") or 0
    out_t = usage.get("output_tokens") or 0

    return {
        "id":      anthropic_resp.get("id") or f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object":  "chat.completion",
        "created": int(time.time()),
        "model":   anthropic_resp.get("model") or model,
        "choices": [{
            "index":         0,
            "message":       message,
            "finish_reason": _stop_reason_anthropic_to_openai(anthropic_resp.get("stop_reason")),
        }],
        "usage": {
            "prompt_tokens":     in_t,
            "completion_tokens": out_t,
            "total_tokens":      in_t + out_t,
        },
    }


# ── 流式转换 ────────────────────────────────────────────────────────


def _openai_chunk(model: str, *, role: str | None = None, content: str | None = None,
                   tool_calls: list | None = None, finish_reason: str | None = None) -> bytes:
    delta: dict = {}
    if role is not None:    delta["role"] = role
    if content is not None: delta["content"] = content
    if tool_calls:          delta["tool_calls"] = tool_calls
    chunk = {
        "id":      f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object":  "chat.completion.chunk",
        "created": int(time.time()),
        "model":   model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
    }
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")


async def convert_stream_anthropic_to_openai(
    upstream_bytes_iter: AsyncIterator[bytes],
    *, model: str,
) -> AsyncIterator[bytes]:
    """逐 event 解析 Anthropic SSE，转成 OpenAI SSE chunk。

    支持的 event：
      - message_start          → role:'assistant' 首 chunk
      - content_block_start    → 可能开 tool_use（记录 id+name）
      - content_block_delta    → text_delta / input_json_delta
      - message_delta          → stop_reason → finish_reason
      - message_stop / ping    → 无 chunk
      - error                  → 单独发一条 error chunk
    """
    buf = b""
    role_sent = False
    # 当前 active 的 tool block（处理 input_json_delta 累积）
    active_tool: dict | None = None  # {"index", "id", "name", "args_buf"}

    async for raw in upstream_bytes_iter:
        if not raw:
            continue
        buf += raw
        while b"\n\n" in buf:
            event_block, buf = buf.split(b"\n\n", 1)
            ev_type, ev_data = _parse_sse_block(event_block)
            if not ev_type or not ev_data:
                continue
            try:
                data = json.loads(ev_data)
            except json.JSONDecodeError:
                continue

            if ev_type == "message_start":
                if not role_sent:
                    yield _openai_chunk(model, role="assistant", content="")
                    role_sent = True

            elif ev_type == "content_block_start":
                block = data.get("content_block") or {}
                if block.get("type") == "tool_use":
                    active_tool = {
                        "index": data.get("index", 0),
                        "id":    block.get("id", ""),
                        "name":  block.get("name", ""),
                        "args_buf": "",
                    }
                    yield _openai_chunk(model, tool_calls=[{
                        "index": active_tool["index"],
                        "id":    active_tool["id"],
                        "type":  "function",
                        "function": {"name": active_tool["name"], "arguments": ""},
                    }])

            elif ev_type == "content_block_delta":
                delta = data.get("delta") or {}
                dt = delta.get("type")
                if dt == "text_delta":
                    text = delta.get("text", "")
                    if text:
                        yield _openai_chunk(model, content=text)
                elif dt == "input_json_delta" and active_tool is not None:
                    piece = delta.get("partial_json", "")
                    active_tool["args_buf"] += piece
                    yield _openai_chunk(model, tool_calls=[{
                        "index": active_tool["index"],
                        "function": {"arguments": piece},
                    }])

            elif ev_type == "content_block_stop":
                active_tool = None

            elif ev_type == "message_delta":
                stop = (data.get("delta") or {}).get("stop_reason")
                if stop:
                    yield _openai_chunk(model, finish_reason=_stop_reason_anthropic_to_openai(stop))

            elif ev_type == "message_stop":
                pass

            elif ev_type == "error":
                err = (data.get("error") or {}).get("message") or "anthropic stream error"
                err_chunk = {"error": {"message": err, "type": "upstream_error"}}
                yield f"data: {json.dumps(err_chunk)}\n\n".encode("utf-8")

    yield b"data: [DONE]\n\n"


def _parse_sse_block(block: bytes) -> tuple[str | None, str | None]:
    ev_type = None
    ev_data = None
    for line in block.split(b"\n"):
        line = line.strip()
        if line.startswith(b"event:"):
            ev_type = line[6:].strip().decode("utf-8", errors="replace")
        elif line.startswith(b"data:"):
            ev_data = line[5:].strip().decode("utf-8", errors="replace")
    return ev_type, ev_data


# ── Adapter 类 ──────────────────────────────────────────────────────


class AnthropicAdapter(ProviderAdapter):
    @property
    def name(self) -> str:
        return "anthropic"

    @property
    def description(self) -> str:
        return "Anthropic Messages API；自动 OpenAI Chat ⇆ Anthropic 互转"

    def build_request(
        self,
        base_url: str,
        api_key: Optional[str],
        openai_body: dict,
        request_headers: dict,
    ) -> AdapterResult:
        url = (base_url or "").rstrip("/") + "/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "anthropic-version": request_headers.get("anthropic-version", "2023-06-01"),
        }
        if api_key:
            headers["x-api-key"] = api_key
        anth_body = convert_request_openai_to_anthropic(openai_body)
        return AdapterResult(url=url, headers=headers, body=anth_body)

    def convert_response(self, upstream_json: dict, *, model: str) -> dict:
        return convert_response_anthropic_to_openai(upstream_json, model=model)

    async def convert_stream(
        self,
        upstream_bytes_iter: AsyncIterator[bytes],
        *,
        model: str,
    ) -> AsyncIterator[bytes]:
        async for chunk in convert_stream_anthropic_to_openai(upstream_bytes_iter, model=model):
            yield chunk

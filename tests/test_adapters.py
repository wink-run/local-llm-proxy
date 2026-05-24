"""ADP-1/2/3 —— adapter 单元测试。"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server" / "local"))

import adapters  # noqa: E402
from adapters import anthropic as ant_mod  # noqa: E402
from adapters import gemini as gem_mod  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


async def _consume(async_iter):
    out = []
    async for chunk in async_iter:
        out.append(chunk)
    return out


# ── Registry ────────────────────────────────────────────────────────


def test_registry_has_three_protocols():
    assert set(adapters.known_protocols()) == {"openai", "anthropic", "gemini_native"}


def test_get_adapter_falls_back_to_openai():
    assert adapters.get_adapter(None).name == "openai"
    assert adapters.get_adapter("unknown-xyz").name == "openai"


# ── OpenAI passthrough ─────────────────────────────────────────────


def test_openai_passthrough_build_request():
    a = adapters.get_adapter("openai")
    r = a.build_request("https://api.openai.com/v1", "sk-x",
                        {"model": "gpt-5.5", "messages": [{"role": "user", "content": "hi"}]},
                        {})
    assert r.url == "https://api.openai.com/v1/chat/completions"
    assert r.headers["Authorization"] == "Bearer sk-x"
    assert r.body["model"] == "gpt-5.5"


def test_openai_passthrough_no_conversion():
    a = adapters.get_adapter("openai")
    src = {"id": "x", "choices": [{"message": {"content": "hi"}}]}
    assert a.convert_response(src, model="x") is src


# ── Anthropic request conversion ────────────────────────────────────


def test_anthropic_extracts_system_message():
    body = {
        "model": "claude-opus-4-7",
        "messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "hi"},
        ],
    }
    out = ant_mod.convert_request_openai_to_anthropic(body)
    assert out["system"] == "be brief"
    assert len(out["messages"]) == 1
    assert out["messages"][0]["role"] == "user"
    assert out["messages"][0]["content"][0]["text"] == "hi"
    assert out["max_tokens"] == 4096  # default


def test_anthropic_default_max_tokens():
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}]}
    out = ant_mod.convert_request_openai_to_anthropic(body)
    assert out["max_tokens"] == 4096


def test_anthropic_preserves_temperature_and_top_p():
    body = {"model": "x", "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.2, "top_p": 0.95, "max_tokens": 1024}
    out = ant_mod.convert_request_openai_to_anthropic(body)
    assert out["temperature"] == 0.2
    assert out["top_p"] == 0.95
    assert out["max_tokens"] == 1024


def test_anthropic_converts_tools():
    body = {
        "model": "x",
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather", "description": "weather",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
            },
        }],
    }
    out = ant_mod.convert_request_openai_to_anthropic(body)
    assert len(out["tools"]) == 1
    assert out["tools"][0]["name"] == "get_weather"
    assert out["tools"][0]["input_schema"]["required"] == ["city"]


def test_anthropic_tool_call_in_assistant_message():
    body = {
        "model": "x",
        "messages": [
            {"role": "user", "content": "weather?"},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": "get_weather", "arguments": '{"city":"sf"}'},
            }]},
            {"role": "tool", "tool_call_id": "call_1", "content": "sunny"},
        ],
    }
    out = ant_mod.convert_request_openai_to_anthropic(body)
    # 3 条消息原本
    assert len(out["messages"]) == 3
    # 中间 assistant 含 tool_use
    asst = out["messages"][1]
    assert asst["role"] == "assistant"
    tu = [b for b in asst["content"] if b["type"] == "tool_use"][0]
    assert tu["name"] == "get_weather"
    assert tu["input"] == {"city": "sf"}
    # 最后 tool → user with tool_result
    last = out["messages"][2]
    assert last["role"] == "user"
    assert last["content"][0]["type"] == "tool_result"
    assert last["content"][0]["tool_use_id"] == "call_1"
    assert last["content"][0]["content"] == "sunny"


# ── Anthropic response conversion ──────────────────────────────────


def test_anthropic_response_to_openai():
    resp = {
        "id": "msg_01",
        "model": "claude-opus-4-7",
        "content": [{"type": "text", "text": "hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 5, "output_tokens": 12},
    }
    out = ant_mod.convert_response_anthropic_to_openai(resp, model="claude-opus-4-7")
    assert out["choices"][0]["message"]["content"] == "hello"
    assert out["choices"][0]["finish_reason"] == "stop"
    assert out["usage"]["prompt_tokens"] == 5
    assert out["usage"]["completion_tokens"] == 12
    assert out["usage"]["total_tokens"] == 17


def test_anthropic_response_with_tool_use():
    resp = {
        "id": "msg_02",
        "model": "claude",
        "content": [
            {"type": "text", "text": "I'll check"},
            {"type": "tool_use", "id": "tu_1", "name": "search", "input": {"q": "foo"}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 8, "output_tokens": 5},
    }
    out = ant_mod.convert_response_anthropic_to_openai(resp, model="claude")
    msg = out["choices"][0]["message"]
    assert msg["content"] == "I'll check"
    assert len(msg["tool_calls"]) == 1
    assert msg["tool_calls"][0]["function"]["name"] == "search"
    assert json.loads(msg["tool_calls"][0]["function"]["arguments"]) == {"q": "foo"}
    assert out["choices"][0]["finish_reason"] == "tool_calls"


# ── Anthropic SSE conversion ───────────────────────────────────────


def _anthropic_sse(events: list[tuple[str, dict]]) -> bytes:
    """构造 Anthropic SSE 字节流。"""
    out = b""
    for ev, data in events:
        out += f"event: {ev}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
    return out


def test_anthropic_stream_text():
    """模拟最小流：message_start + content_block_delta(text) + message_delta(stop)."""
    raw = _anthropic_sse([
        ("message_start", {"type": "message_start", "message": {"id": "m1", "type": "message", "role": "assistant", "content": []}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello "}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "world"}}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
        ("message_stop", {"type": "message_stop"}),
    ])

    async def src():
        # 一次 yield 完，让 split 处理
        yield raw

    chunks = _run(_consume(ant_mod.convert_stream_anthropic_to_openai(src(), model="claude")))
    # 解析所有 chunks
    text_pieces = []
    finish = None
    role_seen = False
    for c in chunks:
        s = c.decode("utf-8", errors="ignore")
        if s.strip() == "data: [DONE]": continue
        if not s.startswith("data: "): continue
        try:
            payload = json.loads(s[6:])
        except json.JSONDecodeError:
            continue
        delta = (payload.get("choices") or [{}])[0].get("delta") or {}
        if delta.get("role") == "assistant":
            role_seen = True
        if delta.get("content"):
            text_pieces.append(delta["content"])
        fr = (payload.get("choices") or [{}])[0].get("finish_reason")
        if fr:
            finish = fr
    assert role_seen
    assert "".join(text_pieces) == "hello world"
    assert finish == "stop"
    assert chunks[-1] == b"data: [DONE]\n\n"


# ── Gemini request conversion ──────────────────────────────────────


def test_gemini_request_messages_to_contents():
    body = {
        "model": "gemini-2.5-flash",
        "messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ],
        "temperature": 0.3, "max_tokens": 100,
    }
    out = gem_mod.convert_request_openai_to_gemini(body)
    assert out["systemInstruction"]["parts"][0]["text"] == "be brief"
    assert len(out["contents"]) == 2
    # user → user, assistant → model
    assert out["contents"][0]["role"] == "user"
    assert out["contents"][1]["role"] == "model"
    assert out["generationConfig"]["temperature"] == 0.3
    assert out["generationConfig"]["maxOutputTokens"] == 100
    assert len(out["safetySettings"]) == 5


def test_gemini_request_tools_converted():
    body = {
        "model": "x",
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [{"type": "function", "function": {
            "name": "get_w", "description": "w",
            "parameters": {"type": "object", "properties": {}},
        }}],
    }
    out = gem_mod.convert_request_openai_to_gemini(body)
    assert "tools" in out
    decls = out["tools"][0]["functionDeclarations"]
    assert decls[0]["name"] == "get_w"


def test_gemini_url_includes_key_in_query():
    a = adapters.get_adapter("gemini_native")
    body = {"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]}
    r = a.build_request("https://generativelanguage.googleapis.com", "AIzaXXX", body, {})
    assert "key=AIzaXXX" in r.url
    assert ":generateContent" in r.url

    body["stream"] = True
    r2 = a.build_request("https://generativelanguage.googleapis.com", "AIzaXXX", body, {})
    assert ":streamGenerateContent" in r2.url
    assert "alt=sse" in r2.url


# ── Gemini response conversion ─────────────────────────────────────


def test_gemini_response_to_openai():
    resp = {
        "candidates": [{
            "content": {"parts": [{"text": "hello"}]},
            "finishReason": "STOP",
        }],
        "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 6, "totalTokenCount": 10},
    }
    out = gem_mod.convert_response_gemini_to_openai(resp, model="gemini-2.5-flash")
    assert out["choices"][0]["message"]["content"] == "hello"
    assert out["choices"][0]["finish_reason"] == "stop"
    assert out["usage"]["total_tokens"] == 10


def test_gemini_response_function_call():
    resp = {
        "candidates": [{
            "content": {"parts": [
                {"text": "ok let me check"},
                {"functionCall": {"name": "search", "args": {"q": "x"}}},
            ]},
            "finishReason": "STOP",
        }],
        "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 8, "totalTokenCount": 13},
    }
    out = gem_mod.convert_response_gemini_to_openai(resp, model="x")
    msg = out["choices"][0]["message"]
    assert msg["content"] == "ok let me check"
    assert len(msg["tool_calls"]) == 1
    assert msg["tool_calls"][0]["function"]["name"] == "search"


def test_gemini_response_no_candidates():
    resp = {"promptFeedback": {"blockReason": "SAFETY"}}
    out = gem_mod.convert_response_gemini_to_openai(resp, model="x")
    assert "_llp_warning" in out
    assert "SAFETY" in out["_llp_warning"]


# ── Gemini stream ──────────────────────────────────────────────────


def test_gemini_stream_text():
    raw = (
        b'data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}\n\n'
        b'data: {"candidates":[{"content":{"parts":[{"text":"world"}]},"finishReason":"STOP"}]}\n\n'
    )

    async def src():
        yield raw

    chunks = _run(_consume(gem_mod.convert_stream_gemini_to_openai(src(), model="x")))
    text_pieces = []
    finish = None
    for c in chunks:
        s = c.decode("utf-8")
        if s.strip() == "data: [DONE]": continue
        if not s.startswith("data: "): continue
        try:
            payload = json.loads(s[6:])
        except json.JSONDecodeError:
            continue
        delta = (payload.get("choices") or [{}])[0].get("delta") or {}
        if delta.get("content"):
            text_pieces.append(delta["content"])
        fr = (payload.get("choices") or [{}])[0].get("finish_reason")
        if fr:
            finish = fr
    assert "".join(text_pieces) == "hello world"
    assert finish == "stop"
    assert chunks[-1] == b"data: [DONE]\n\n"

"""P2P / 网关共用的 usage 归一化与 input token 粗估。"""
from __future__ import annotations

import json
from typing import Any


def extract_text(body: dict | None) -> str:
    """从 chat/messages 请求体拼接输入文本（与 local-gateway.js extractText 对齐）。"""
    if not body or not isinstance(body, dict):
        return ""
    parts: list[str] = []

    def push(content: Any) -> None:
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])

    for msg in body.get("messages") or []:
        if isinstance(msg, dict):
            push(msg.get("content"))
    for item in body.get("input") or []:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            push(item.get("content"))
    if isinstance(body.get("prompt"), str):
        parts.append(body["prompt"])
    if isinstance(body.get("input"), str):
        parts.append(body["input"])
    return "\n".join(parts)


def estimate_input_tokens(body: dict | None) -> int:
    """约 4 字符/token，零成本粗估（路由分流与缺 usage 兜底共用）。"""
    text = extract_text(body)
    if not text:
        return 0
    return max(1, (len(text) + 3) // 4)


def normalize_usage(usage: dict | None, body: dict | None = None) -> dict:
    """
    统一 OpenAI / Anthropic 字段名；流式仅有 output 时用请求体粗估 input。
    返回 {prompt_tokens, completion_tokens, total_tokens} 形态，便于扣费与 SSE 补帧。
    """
    u = dict(usage or {})
    in_t = int(u.get("prompt_tokens") or u.get("input_tokens") or 0)
    out_t = int(u.get("completion_tokens") or u.get("output_tokens") or 0)
    if in_t <= 0 and out_t > 0 and body:
        in_t = estimate_input_tokens(body)
    total = in_t + out_t
    if total <= 0 and u.get("total_tokens"):
        total = int(u["total_tokens"])
    return {
        "prompt_tokens": in_t,
        "completion_tokens": out_t,
        "total_tokens": total,
        # 保留 Anthropic 别名，供旧逻辑读取
        "input_tokens": in_t,
        "output_tokens": out_t,
    }


def usage_sse_chunk(usage: dict, model: str, chunk_id: str | None = None) -> str:
    """OpenAI 流式末帧 usage chunk（local-gateway sniff 可读）。"""
    import time
    import uuid

    cid = chunk_id or f"chatcmpl-p2p-{uuid.uuid4().hex[:12]}"
    payload = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [],
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens") or 0,
            "completion_tokens": usage.get("completion_tokens") or 0,
            "total_tokens": usage.get("total_tokens") or 0,
        },
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

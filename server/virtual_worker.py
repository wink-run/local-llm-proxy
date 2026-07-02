"""虚拟 Worker：无需 WebSocket，直接 HTTP 转发 LLM 请求。"""

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import httpx


# ── 格式转换工具 ──────────────────────────────────────────────────────────────
# 客户端发 OpenAI Chat 格式，这里转成上游协议（Anthropic / Gemini）再发，响应转回 OpenAI。
# 必须双向转换 tools / tool_calls / tool_result，否则经 Anthropic/Gemini 源的工具调用会丢工具。
# 与客户端 client/electron/local-gateway.js 的转换逻辑对齐。

GEMINI_DUMMY_SIG = "skip_thought_signature_validator"
_IMG_DATA_RE = re.compile(r"^data:([^;]+);base64,(.*)$", re.S)


def _gen_id(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:12]


def _content_to_text(content) -> str:
    """OpenAI message content（str | parts[]）→ 纯文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            p.get("text", "") for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return ""


# ── OpenAI → Anthropic（请求） ───────────────────────────────────────────────

def _oai_tools_to_anthropic(tools):
    if not isinstance(tools, list):
        return None
    out = []
    for t in tools:
        fn = t.get("function") if isinstance(t, dict) and t.get("function") else t
        if not isinstance(fn, dict) or not fn.get("name"):
            continue
        out.append({
            "name": fn["name"],
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    return out or None


def _oai_tool_choice_to_anthropic(tc):
    if tc is None:
        return None
    if isinstance(tc, str):
        return {"auto": {"type": "auto"}, "required": {"type": "any"},
                "none": {"type": "none"}}.get(tc)
    if isinstance(tc, dict) and tc.get("type") == "function" and (tc.get("function") or {}).get("name"):
        return {"type": "tool", "name": tc["function"]["name"]}
    return None


def _oai_messages_to_anthropic(messages):
    """OpenAI messages（含 tool_calls / role:tool / 多模态）→ Anthropic messages。"""
    out = []

    def push_user_blocks(blocks):
        if not blocks:
            return
        if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": "user", "content": blocks})

    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        if role == "tool":
            # 工具结果必须落在 user turn，连续结果合并进同一条 user message
            push_user_blocks([{
                "type": "tool_result",
                "tool_use_id": m.get("tool_call_id"),
                "content": m["content"] if isinstance(m.get("content"), str) else _content_to_text(m.get("content")),
            }])
            continue
        if role == "assistant":
            blocks = []
            text = m["content"] if isinstance(m.get("content"), str) else ""
            if text:
                blocks.append({"type": "text", "text": text})
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                blocks.append({"type": "tool_use", "id": tc.get("id") or _gen_id("toolu_"),
                               "name": fn.get("name"), "input": args})
            out.append({"role": "assistant", "content": blocks if blocks else (text or "")})
            continue
        # user
        content = m.get("content")
        if isinstance(content, str):
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append({"type": "text", "text": content})
            else:
                out.append({"role": "user", "content": content})
        elif isinstance(content, list):
            blocks = []
            for p in content:
                if not isinstance(p, dict):
                    continue
                if p.get("type") == "text":
                    blocks.append({"type": "text", "text": p.get("text", "")})
                elif p.get("type") == "image_url":
                    url = (p.get("image_url") or {}).get("url", "")
                    mm = _IMG_DATA_RE.match(url)
                    if mm:
                        blocks.append({"type": "image", "source": {
                            "type": "base64", "media_type": mm.group(1), "data": mm.group(2)}})
            push_user_blocks(blocks)
    return out


def _to_anthropic_body(payload: dict) -> dict:
    """将 OpenAI 格式请求体转换为 Anthropic Messages 格式（含 tool calling）。"""
    messages = payload.get("messages", [])
    system_msgs = [m for m in messages if m.get("role") == "system"]
    body: dict = {
        "model": payload.get("model", ""),
        "max_tokens": payload.get("max_tokens", 8096),
        "messages": _oai_messages_to_anthropic(messages),
        "stream": payload.get("stream", False),
    }
    if system_msgs:
        content = system_msgs[0].get("content", "")
        body["system"] = content if isinstance(content, str) else _content_to_text(content)
    if payload.get("temperature") is not None:
        body["temperature"] = payload["temperature"]
    if payload.get("top_p") is not None:
        body["top_p"] = payload["top_p"]
    tools = _oai_tools_to_anthropic(payload.get("tools"))
    if tools:
        body["tools"] = tools
    tc = _oai_tool_choice_to_anthropic(payload.get("tool_choice"))
    if tc:
        body["tool_choice"] = tc
    return body


# ── OpenAI SSE chunk 构造 ────────────────────────────────────────────────────

def _openai_sse_chunk(text: str, model: str) -> str:
    """将 delta text 包装为 OpenAI SSE chunk 行（含末尾 \\n\\n）。"""
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


def _openai_tool_call_chunk(model: str, index: int, call_id, name, arguments: str) -> str:
    """OpenAI 流式 tool_calls 增量帧。name 非 None 为首帧（带 id+name），否则为参数增量帧。"""
    tc: dict = {"index": index}
    if call_id is not None:
        tc["id"] = call_id
    if name is not None:
        tc["type"] = "function"
        tc["function"] = {"name": name, "arguments": arguments or ""}
    else:
        tc["function"] = {"arguments": arguments or ""}
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{"index": 0, "delta": {"tool_calls": [tc]}, "finish_reason": None}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


def _openai_finish_chunk(model: str, finish_reason: str) -> str:
    """OpenAI 流式收尾帧（finish_reason）。"""
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


# ── Anthropic → OpenAI（响应） ───────────────────────────────────────────────

def _anthropic_resp_to_openai(data: dict) -> dict:
    """将 Anthropic 非流式响应转换为 OpenAI chat completion 格式（含 tool_use→tool_calls）。"""
    blocks = data.get("content", [])
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    tool_calls = []
    for b in blocks:
        if b.get("type") == "tool_use":
            tool_calls.append({
                "id": b.get("id") or _gen_id("call_"),
                "type": "function",
                "function": {"name": b.get("name", ""), "arguments": json.dumps(b.get("input") or {})},
            })
    message = {"role": "assistant", "content": text or (None if tool_calls else "")}
    if tool_calls:
        message["tool_calls"] = tool_calls
    stop = data.get("stop_reason")
    if stop == "tool_use" or tool_calls:
        finish = "tool_calls"
    elif stop == "max_tokens":
        finish = "length"
    else:
        finish = "stop"
    usage = data.get("usage", {})
    prompt_t = int(usage.get("input_tokens") or 0)
    compl_t = int(usage.get("output_tokens") or 0)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "model": data.get("model", ""),
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": prompt_t,
            "completion_tokens": compl_t,
            "total_tokens": prompt_t + compl_t,
        },
    }


# ── OpenAI → Gemini（请求） ──────────────────────────────────────────────────

def _sanitize_gemini_schema(v, inside_properties: bool = False):
    """递归清洗 JSON Schema（Gemini 不支持部分元字段，否则 functionDeclarations 会被 400）。"""
    if isinstance(v, list):
        return [_sanitize_gemini_schema(x, False) for x in v]
    if isinstance(v, dict):
        out = {}
        const_value = None
        has_const = False
        for k, val in v.items():
            if inside_properties:
                out[k] = _sanitize_gemini_schema(val, False)
                continue
            if k in ("$schema", "title", "examples", "additionalProperties",
                     "propertyNames", "exclusiveMinimum", "exclusiveMaximum"):
                continue
            if k == "const":
                const_value = val
                has_const = True
                continue
            out[k] = _sanitize_gemini_schema(val, k == "properties")
        if has_const and "enum" not in out:
            out["enum"] = [_sanitize_gemini_schema(const_value, False)]
        return out
    return v


def _oai_tools_to_gemini(tools):
    if not isinstance(tools, list):
        return None
    decls = []
    for t in tools:
        fn = t.get("function") if isinstance(t, dict) and t.get("function") else t
        if not isinstance(fn, dict) or not fn.get("name"):
            continue
        decls.append({
            "name": fn["name"],
            "description": fn.get("description", ""),
            "parameters": _sanitize_gemini_schema(fn.get("parameters") or {"type": "object", "properties": {}}),
        })
    return [{"functionDeclarations": decls}] if decls else None


def _oai_tool_choice_to_gemini(tc):
    if tc is None:
        return None
    if isinstance(tc, str):
        mode = {"auto": "AUTO", "required": "ANY", "none": "NONE"}.get(tc)
        return {"functionCallingConfig": {"mode": mode}} if mode else None
    if isinstance(tc, dict) and tc.get("type") == "function" and (tc.get("function") or {}).get("name"):
        return {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": [tc["function"]["name"]]}}
    return None


def _gemini_fn_response_payload(content):
    """Gemini functionResponse.response 必须是对象：字符串包成 {result}。"""
    if content is None:
        return {"result": ""}
    if isinstance(content, str):
        return {"result": content}
    if isinstance(content, dict):
        return content
    return {"result": str(content)}


def _oai_content_to_gemini_parts(content):
    if isinstance(content, str):
        return [{"text": content}] if content else []
    if not isinstance(content, list):
        return []
    parts = []
    for p in content:
        if not isinstance(p, dict):
            continue
        if p.get("type") == "text":
            if p.get("text"):
                parts.append({"text": p["text"]})
        elif p.get("type") == "image_url":
            url = (p.get("image_url") or {}).get("url", "")
            mm = _IMG_DATA_RE.match(url)
            if mm:
                parts.append({"inlineData": {"mimeType": mm.group(1), "data": mm.group(2)}})
    return parts


def _to_gemini_body(payload: dict) -> dict:
    """将 OpenAI 格式请求体转换为 Gemini generateContent 格式（含 tool calling + 多模态）。"""
    messages = payload.get("messages", [])
    system_parts = []
    contents = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if role == "system":
            for p in _oai_content_to_gemini_parts(content):
                if p.get("text"):
                    system_parts.append({"text": p["text"]})
            continue
        if role == "tool":
            # 工具结果 → functionResponse（user 角色；name 用 tool_call_id 做关联键）
            contents.append({"role": "user", "parts": [{"functionResponse": {
                "name": m.get("tool_call_id"),
                "response": _gemini_fn_response_payload(content)}}]})
            continue
        if role == "assistant":
            parts = _oai_content_to_gemini_parts(content)
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                # thoughtSignature 与 functionCall 同级（part 层级）
                parts.append({"functionCall": {"name": fn.get("name"), "args": args},
                              "thoughtSignature": GEMINI_DUMMY_SIG})
            contents.append({"role": "model", "parts": parts if parts else [{"text": ""}]})
            continue
        parts = _oai_content_to_gemini_parts(content)
        contents.append({"role": "user", "parts": parts if parts else [{"text": ""}]})

    body: dict = {"contents": contents}
    if system_parts:
        body["systemInstruction"] = {"parts": system_parts}
    tools = _oai_tools_to_gemini(payload.get("tools"))
    if tools:
        body["tools"] = tools
    tool_cfg = _oai_tool_choice_to_gemini(payload.get("tool_choice"))
    if tool_cfg:
        body["toolConfig"] = tool_cfg
    gen_config: dict = {}
    if payload.get("max_tokens"):
        gen_config["maxOutputTokens"] = payload["max_tokens"]
    if payload.get("temperature") is not None:
        gen_config["temperature"] = payload["temperature"]
    if payload.get("top_p") is not None:
        gen_config["topP"] = payload["top_p"]
    if gen_config:
        body["generationConfig"] = gen_config
    return body


# ── Gemini → OpenAI（响应） ──────────────────────────────────────────────────

def _gemini_extract_parts(data: dict):
    """从 Gemini 响应提取 text + functionCall（→ OpenAI tool_calls）。
    Gemini 用 functionCall.name 当关联键（无独立 call_id），args 是对象（需 json.dumps）。"""
    text = ""
    tool_calls = []
    for candidate in data.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if part.get("thought"):
                continue
            if isinstance(part.get("text"), str):
                text += part["text"]
            if part.get("functionCall"):
                fc = part["functionCall"]
                tool_calls.append({
                    "id": fc.get("name"),
                    "type": "function",
                    "function": {"name": fc.get("name"), "arguments": json.dumps(fc.get("args") or {})},
                })
    return text, tool_calls


def _gemini_resp_to_openai(data: dict, model: str) -> dict:
    """将 Gemini 非流式响应转换为 OpenAI chat completion 格式（含 functionCall→tool_calls）。"""
    text, tool_calls = _gemini_extract_parts(data)
    usage_meta = data.get("usageMetadata", {})
    prompt_t = int(usage_meta.get("promptTokenCount") or 0)
    compl_t = int(usage_meta.get("candidatesTokenCount") or 0)
    message = {"role": "assistant", "content": text or (None if tool_calls else "")}
    if tool_calls:
        message["tool_calls"] = tool_calls
    if tool_calls:
        finish = "tool_calls"
    else:
        finish = "stop"
        candidates = data.get("candidates", [])
        if candidates:
            reason = candidates[0].get("finishReason", "STOP")
            if reason in ("STOP", "END_TURN"):
                finish = "stop"
            elif reason == "MAX_TOKENS":
                finish = "length"
            else:
                finish = reason.lower()
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": prompt_t,
            "completion_tokens": compl_t,
            "total_tokens": prompt_t + compl_t,
        },
    }


# ── VirtualWorkerConnection ───────────────────────────────────────────────────

@dataclass
class VirtualWorkerConnection:
    base_url: str
    api_key: str
    api_style: str          # 'openai' | 'anthropic' | 'claude_oauth'
    models: list
    worker_id: str
    name: str
    model_types: dict = field(default_factory=dict)
    user_id: Optional[int] = None
    # OAuth 账号（api_style='claude_oauth'）使用，存 access_token/refresh_token/expires_at
    credentials: dict = field(default_factory=dict)
    agent_id: Optional[int] = None   # 用于 token 刷新后回写数据库
    owner_user_id: Optional[int] = None   # 个人供给源归属真实用户；None=全局共享
    circle_id: Optional[int] = None   # 贡献给指定圈子；None=私有或公开
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    country_code: str = ""
    city: str = ""
    connected_at: datetime = field(default_factory=datetime.now)
    active_requests: int = 0
    pending: dict = field(default_factory=dict)
    period_start: float = field(default_factory=time.time)
    period_stats: dict = field(default_factory=dict)
    _oauth_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, data: dict) -> None:
        """dispatch.py 调用此方法分发请求；spawn task 避免阻塞事件循环。"""
        req_id = data.get("req_id")
        payload = data.get("payload", {})
        if not req_id:
            return
        # 防御：虚拟 worker 只转发 chat 端点，未实现图像生成。若收到图像请求，
        # 明确报错而非误发到 /chat/completions（正常路径已在 dispatch_image 提前排除虚拟 worker）。
        if data.get("type") == "image_request":
            entry = self.pending.get(req_id)
            if entry:
                await entry["queue"].put(("error", "virtual worker does not support image generation"))
            return
        self.active_requests += 1
        asyncio.create_task(self._dispatch(req_id, payload))

    async def _dispatch(self, req_id: str, payload: dict) -> None:
        entry = self.pending.get(req_id)
        if not entry:
            self.active_requests = max(0, self.active_requests - 1)
            return
        q = entry["queue"]
        stream = payload.get("stream", False)
        model = payload.get("model", "")
        try:
            if self.api_style == "anthropic":
                await self._dispatch_anthropic(entry, q, payload, stream, model)
            elif self.api_style == "claude_oauth":
                await self._dispatch_claude_oauth(entry, q, payload, stream, model)
            elif self.api_style == "gemini":
                await self._dispatch_gemini(entry, q, payload, stream, model)
            else:
                await self._dispatch_openai(entry, q, payload, stream, model)
        except Exception as e:
            await q.put(("error", str(e)))
            self.record_complete(model, 0, False, None)
        finally:
            self.pending.pop(req_id, None)
            self.active_requests = max(0, self.active_requests - 1)

    async def _dispatch_openai(self, entry: dict, q: asyncio.Queue,
                                payload: dict, stream: bool, model: str) -> None:
        url = self.base_url.rstrip("/") + "/v1/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        async with httpx.AsyncClient(timeout=120) as client:
            if stream:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        await q.put(("error", f"HTTP {resp.status_code}: {body.decode()}"))
                        self.record_complete(model, 0, False, None)
                        return
                    buf = ""
                    output_tokens = 0
                    last_usage: dict | None = None
                    async for text in resp.aiter_text():
                        if entry.get("ttft_ms") is None:
                            entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                        buf += text
                        lines = buf.split("\n")
                        buf = lines[-1]
                        for line in lines[:-1]:
                            s = line.strip()
                            if not s or s == "data: [DONE]":
                                continue
                            if s.startswith("data: "):
                                try:
                                    d = json.loads(s[6:])
                                    if d.get("usage"):
                                        last_usage = d["usage"]
                                    delta = d.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                    if delta:
                                        output_tokens += len(delta)
                                except Exception:
                                    pass
                                await q.put(("chunk", line + "\n"))
                    # 流式扣费依赖 done 上的 usage；上游未带时按估算 completion 计费
                    await q.put(("done", last_usage or {"completion_tokens": output_tokens}))
                    self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))
            else:
                resp = await client.post(url, json=payload, headers=headers)
                if resp.status_code >= 400:
                    await q.put(("error", f"HTTP {resp.status_code}: {resp.text}"))
                    self.record_complete(model, 0, False, None)
                    return
                entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                data = resp.json()
                usage = data.get("usage", {})
                output_tokens = int(
                    usage.get("completion_tokens") or usage.get("output_tokens") or 0
                )
                await q.put(("chunk", resp.text))
                await q.put(("done", None))
                self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))

    async def _dispatch_anthropic(self, entry: dict, q: asyncio.Queue,
                                   payload: dict, stream: bool, model: str) -> None:
        url = self.base_url.rstrip("/") + "/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }
        body = _to_anthropic_body(payload)
        await self._run_anthropic(entry, q, url, headers, body, stream, model)

    async def _ensure_oauth_token(self) -> dict:
        """确保 OAuth access_token 有效；临近过期则刷新并回写数据库。"""
        import claude_oauth
        async with self._oauth_lock:
            creds = self.credentials or {}
            if not claude_oauth.needs_refresh(creds):
                return creds
            refresh_token = creds.get("refresh_token")
            if not refresh_token:
                raise RuntimeError("OAuth 账号缺少 refresh_token，请重新授权")
            new_creds = await claude_oauth.refresh_access_token(refresh_token)
            self.credentials = new_creds
            if self.agent_id is not None:
                try:
                    import database as _db
                    await _db.update_virtual_agent_credentials(self.agent_id, new_creds)
                except Exception:
                    # 回写失败不阻断请求；下次仍会按内存中的 creds 判断刷新
                    pass
            return new_creds

    async def _dispatch_claude_oauth(self, entry: dict, q: asyncio.Queue,
                                     payload: dict, stream: bool, model: str) -> None:
        """Claude 订阅账号（OAuth）：刷新 token → 伪装 CLI 头 → 注入 system → 转发。"""
        import claude_oauth
        creds = await self._ensure_oauth_token()
        base = (self.base_url or claude_oauth.ANTHROPIC_BASE_URL).rstrip("/")
        url = base + "/v1/messages"
        headers = claude_oauth.build_oauth_headers(creds["access_token"])
        body = claude_oauth.inject_claude_code_system(_to_anthropic_body(payload))
        await self._run_anthropic(entry, q, url, headers, body, stream, model)

    async def _run_anthropic(self, entry: dict, q: asyncio.Queue, url: str,
                             headers: dict, body: dict, stream: bool, model: str) -> None:
        """向 Anthropic Messages 端点发请求并把响应转成 OpenAI 格式回传。"""
        async with httpx.AsyncClient(timeout=120) as client:
            if stream:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    if resp.status_code >= 400:
                        raw = await resp.aread()
                        await q.put(("error", f"HTTP {resp.status_code}: {raw.decode()}"))
                        self.record_complete(model, 0, False, None)
                        return
                    buf = ""
                    output_tokens = 0          # 文本字符数兜底（上游不带 usage 时用）
                    usage_in = 0
                    usage_out = 0
                    stop_reason = "stop"
                    tool_index_by_block: dict = {}   # Anthropic block index → OpenAI tool_calls index
                    tool_counter = 0
                    async for text in resp.aiter_text():
                        if entry.get("ttft_ms") is None:
                            entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                        buf += text
                        lines = buf.split("\n")
                        buf = lines[-1]
                        for line in lines[:-1]:
                            stripped = line.rstrip()
                            if not stripped.startswith("data: "):
                                continue
                            try:
                                d = json.loads(stripped[6:])
                            except Exception:
                                continue
                            etype = d.get("type")
                            if etype == "content_block_start" and (d.get("content_block") or {}).get("type") == "tool_use":
                                cb = d["content_block"]
                                oai_index = tool_counter
                                tool_counter += 1
                                tool_index_by_block[d.get("index")] = oai_index
                                await q.put(("chunk", _openai_tool_call_chunk(
                                    model, oai_index, cb.get("id"), cb.get("name", ""), "")))
                            elif etype == "content_block_delta":
                                delta = d.get("delta", {})
                                if delta.get("type") == "text_delta" and delta.get("text"):
                                    output_tokens += len(delta["text"])
                                    await q.put(("chunk", _openai_sse_chunk(delta["text"], model)))
                                elif delta.get("type") == "input_json_delta":
                                    oai_index = tool_index_by_block.get(d.get("index"), 0)
                                    pj = delta.get("partial_json", "")
                                    if pj:
                                        await q.put(("chunk", _openai_tool_call_chunk(
                                            model, oai_index, None, None, pj)))
                            elif etype == "message_start":
                                usage_in = int(((d.get("message") or {}).get("usage") or {}).get("input_tokens") or 0)
                            elif etype == "message_delta":
                                sr = (d.get("delta") or {}).get("stop_reason")
                                if sr:
                                    stop_reason = ("tool_calls" if sr == "tool_use"
                                                   else "length" if sr == "max_tokens"
                                                   else "stop" if sr == "end_turn" else sr)
                                uo = (d.get("usage") or {}).get("output_tokens")
                                if uo is not None:
                                    usage_out = int(uo)
                    final_out = usage_out or output_tokens
                    await q.put(("chunk", _openai_finish_chunk(model, stop_reason)))
                    await q.put(("done", {"prompt_tokens": usage_in, "completion_tokens": final_out}))
                    self.record_complete(model, final_out, True, entry.get("ttft_ms"))
            else:
                resp = await client.post(url, json=body, headers=headers)
                if resp.status_code >= 400:
                    await q.put(("error", f"HTTP {resp.status_code}: {resp.text}"))
                    self.record_complete(model, 0, False, None)
                    return
                entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                anthropic_data = resp.json()
                openai_data = _anthropic_resp_to_openai(anthropic_data)
                output_tokens = int(anthropic_data.get("usage", {}).get("output_tokens") or 0)
                await q.put(("chunk", json.dumps(openai_data)))
                await q.put(("done", None))
                self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))

    async def _dispatch_gemini(self, entry: dict, q: asyncio.Queue,
                               payload: dict, stream: bool, model: str) -> None:
        """Gemini generateContent API: converts OpenAI chat format to Gemini and back."""
        raw_base = (self.base_url or "https://generativelanguage.googleapis.com").rstrip("/")
        # 如果用户已在 base_url 里带了 /v1beta，避免重复拼接
        if "/v1beta" in raw_base:
            base = raw_base
        else:
            base = raw_base + "/v1beta"
        action = "streamGenerateContent?alt=sse" if stream else "generateContent"
        url = f"{base}/models/{model}:{action}"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key,
        }
        body = _to_gemini_body(payload)

        async with httpx.AsyncClient(timeout=120) as client:
            if stream:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    if resp.status_code >= 400:
                        raw = await resp.aread()
                        await q.put(("error", f"HTTP {resp.status_code}: {raw.decode()}"))
                        self.record_complete(model, 0, False, None)
                        return
                    buf = ""
                    output_tokens = 0          # 文本字符数兜底
                    usage_in = 0
                    usage_out = 0
                    # Gemini 流式里 functionCall 一次性完整出现（非增量），先缓存，流末统一发工具帧
                    pending_tools: list = []
                    async for text in resp.aiter_text():
                        if entry.get("ttft_ms") is None:
                            entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                        buf += text
                        lines = buf.split("\n")
                        buf = lines[-1]
                        for line in lines[:-1]:
                            s = line.strip()
                            if not s or not s.startswith("data: "):
                                continue
                            try:
                                d = json.loads(s[6:])
                            except Exception:
                                continue
                            for cand in d.get("candidates", []):
                                for part in cand.get("content", {}).get("parts", []):
                                    if part.get("thought"):
                                        continue
                                    if isinstance(part.get("text"), str) and part["text"]:
                                        output_tokens += len(part["text"])
                                        await q.put(("chunk", _openai_sse_chunk(part["text"], model)))
                                    if part.get("functionCall"):
                                        fc = part["functionCall"]
                                        pending_tools.append({"name": fc.get("name"), "args": fc.get("args") or {}})
                            um = d.get("usageMetadata")
                            if um:
                                usage_in = int(um.get("promptTokenCount") or usage_in)
                                usage_out = int(um.get("candidatesTokenCount") or usage_out)
                    for i, tcall in enumerate(pending_tools):
                        await q.put(("chunk", _openai_tool_call_chunk(
                            model, i, tcall["name"], tcall["name"], json.dumps(tcall["args"]))))
                    final_out = usage_out or output_tokens
                    await q.put(("chunk", _openai_finish_chunk(model, "tool_calls" if pending_tools else "stop")))
                    await q.put(("done", {"prompt_tokens": usage_in, "completion_tokens": final_out}))
                    self.record_complete(model, final_out, True, entry.get("ttft_ms"))
            else:
                resp = await client.post(url, json=body, headers=headers)
                if resp.status_code >= 400:
                    await q.put(("error", f"HTTP {resp.status_code}: {resp.text}"))
                    self.record_complete(model, 0, False, None)
                    return
                entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                gemini_data = resp.json()
                openai_data = _gemini_resp_to_openai(gemini_data, model)
                output_tokens = int(
                    gemini_data.get("usageMetadata", {}).get("candidatesTokenCount") or 0
                )
                await q.put(("chunk", json.dumps(openai_data)))
                await q.put(("done", None))
                self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))

    def record_complete(self, model: str, output_tokens: int,
                        success: bool, ttft_ms: Optional[float]) -> None:
        s = self.period_stats.setdefault(
            model,
            {"output_tokens": 0, "requests": 0, "success": 0, "ttft_sum": 0.0, "ttft_count": 0},
        )
        s["output_tokens"] += output_tokens
        s["requests"] += 1
        if success:
            s["success"] += 1
        if success and ttft_ms is not None and ttft_ms >= 0:
            s["ttft_sum"] += ttft_ms
            s["ttft_count"] += 1

    def record_image_complete(self, model: str, image_count: int) -> None:
        s = self.period_stats.setdefault(
            model,
            {"output_tokens": 0, "requests": 0, "success": 0,
             "ttft_sum": 0.0, "ttft_count": 0, "image_count": 0},
        )
        s["requests"] += 1
        s["success"] += 1
        s["image_count"] = s.get("image_count", 0) + image_count

    def take_period(self) -> dict:
        snapshot = dict(self.period_stats)
        self.period_stats = {}
        self.period_start = time.time()
        return snapshot

    def period_online_mins(self) -> float:
        return (time.time() - self.period_start) / 60

    def to_dict(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "name": self.name,
            "models": self.models,
            "model_types": self.model_types,
            "connected_at": self.connected_at.isoformat(),
            "active_requests": self.active_requests,
            "user_id": self.user_id,
            "is_virtual": True,
        }

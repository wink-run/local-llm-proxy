"""虚拟 Worker：无需 WebSocket，直接 HTTP 转发 LLM 请求。"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import httpx


# ── 格式转换工具 ──────────────────────────────────────────────────────────────

def _to_anthropic_body(payload: dict) -> dict:
    """将 OpenAI 格式请求体转换为 Anthropic Messages 格式。"""
    messages = payload.get("messages", [])
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]
    body: dict = {
        "model": payload.get("model", ""),
        "max_tokens": payload.get("max_tokens", 8096),
        "messages": non_system,
        "stream": payload.get("stream", False),
    }
    if system_msgs:
        content = system_msgs[0].get("content", "")
        body["system"] = content if isinstance(content, str) else ""
    return body


def _openai_sse_chunk(text: str, model: str) -> str:
    """将 Anthropic delta text 包装为 OpenAI SSE chunk 行（含末尾 \\n\\n）。"""
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


def _anthropic_resp_to_openai(data: dict) -> dict:
    """将 Anthropic 非流式响应转换为 OpenAI chat completion 格式。"""
    text = "".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    )
    usage = data.get("usage", {})
    prompt_t = int(usage.get("input_tokens") or 0)
    compl_t = int(usage.get("output_tokens") or 0)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "model": data.get("model", ""),
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
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
                    current_event: Optional[str] = None
                    output_tokens = 0
                    async for text in resp.aiter_text():
                        if entry.get("ttft_ms") is None:
                            entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                        buf += text
                        lines = buf.split("\n")
                        buf = lines[-1]
                        for line in lines[:-1]:
                            stripped = line.rstrip()
                            if not stripped:
                                current_event = None
                                continue
                            if stripped.startswith("event: "):
                                current_event = stripped[7:].strip()
                            elif stripped.startswith("data: ") and current_event == "content_block_delta":
                                try:
                                    d = json.loads(stripped[6:])
                                    delta_text = d.get("delta", {}).get("text", "")
                                    if delta_text:
                                        output_tokens += len(delta_text)
                                        await q.put(("chunk", _openai_sse_chunk(delta_text, model)))
                                except Exception:
                                    pass
                    await q.put(
                        ("done", {"prompt_tokens": 0, "completion_tokens": output_tokens})
                    )
                    self.record_complete(model, output_tokens, True, entry.get("ttft_ms"))
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

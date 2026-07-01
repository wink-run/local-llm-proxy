"""OpenAI 兼容错误体 + Worker/P2P 转发失败状态映射。"""

from __future__ import annotations

import json
import re

from fastapi.responses import JSONResponse


class DispatchError(Exception):
    """dispatch 层统一错误，由 /v1/* 端点转为 OpenAI 风格 JSON。"""

    def __init__(self, status_code: int, message: str, error_type: str = "api_error"):
        self.status_code = status_code
        self.message = message
        self.error_type = error_type
        super().__init__(message)


def openai_error_content(message: str, error_type: str = "api_error") -> dict:
    return {"error": {"message": message, "type": error_type}}


def openai_error_response(status_code: int, message: str, error_type: str = "api_error") -> JSONResponse:
    return JSONResponse(status_code=status_code, content=openai_error_content(message, error_type))


def _extract_message_from_json_text(text: str) -> str | None:
    text = (text or "").strip()
    if not text:
        return None
    try:
        j = json.loads(text)
    except Exception:
        return text[:500] if text else None
    if not isinstance(j, dict):
        return text[:500]
    err = j.get("error")
    if isinstance(err, dict):
        return err.get("message") or err.get("detail") or str(err)
    if isinstance(err, str):
        return err
    detail = j.get("detail")
    if detail is not None:
        return str(detail)
    return text[:500]


def parse_worker_error(err: str) -> tuple[int, str, str]:
    """Worker/上游错误文本 → (HTTP 状态, 可读消息, OpenAI error.type)。"""
    s = str(err or "").strip()
    if not s:
        return 502, "Worker error", "api_error"

    m = re.match(r"^HTTP[_\s]?(\d{3})\s*[:\s]*(.*)$", s, re.I | re.S)
    if m:
        code = int(m.group(1))
        tail = (m.group(2) or "").strip()
        msg = _extract_message_from_json_text(tail) or s
        if code == 402 or "insufficient credits" in msg.lower():
            return 402, msg, "insufficient_credits"
        if code == 401:
            return 401, msg, "authentication_error"
        if code == 429:
            return 429, msg, "rate_limit_exceeded"
        if code in (504, 408) or "timeout" in msg.lower():
            return 504, msg, "timeout"
        if code == 503:
            return 503, msg, "service_unavailable"
        if 400 <= code < 500:
            return code, msg, "invalid_request_error"
        return 502, msg, "api_error"

    low = s.lower()
    if "timeout" in low:
        return 504, s, "timeout"
    if "no worker" in low or "no image-capable worker" in low:
        return 503, s, "service_unavailable"
    if "insufficient credits" in low:
        return 402, s, "insufficient_credits"
    if "failed to reach worker" in low:
        return 502, s, "api_error"
    return 502, s, "api_error"


def raise_dispatch_error(err: str) -> None:
    status, msg, etype = parse_worker_error(err)
    raise DispatchError(status, msg, etype)


def payload_has_openai_error(data: dict | None) -> bool:
    if not isinstance(data, dict):
        return False
    if data.get("error"):
        return True
    # 部分上游把错误嵌在 choices 为空且带 message 字段
    err_msg = data.get("message")
    return isinstance(err_msg, str) and err_msg.lower().startswith("error")


def error_message_from_payload(data: dict | None) -> str:
    if not isinstance(data, dict):
        return "Worker returned invalid response"
    err = data.get("error")
    if isinstance(err, dict):
        return err.get("message") or err.get("detail") or json.dumps(err, ensure_ascii=False)
    if isinstance(err, str):
        return err
    if data.get("detail"):
        return str(data["detail"])
    return json.dumps(data, ensure_ascii=False)[:500]

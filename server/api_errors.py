"""OpenAI 兼容错误体 + Worker/P2P 转发失败状态映射。"""

from __future__ import annotations

import json
import re

from fastapi.responses import JSONResponse


class DispatchError(Exception):
    """dispatch 层统一错误，由 /v1/* 端点转为 OpenAI 风格 JSON。

    worker_id / workers：社区(p2p)派发时把「具体是哪个 worker 失败」带回来——
    worker_id 为最后失败的那个，workers 为本次 failover 尝试过的全部 worker。
    """

    def __init__(self, status_code: int, message: str, error_type: str = "api_error",
                 worker_id: str | None = None, workers: list | None = None):
        self.status_code = status_code
        self.message = message
        self.error_type = error_type
        self.worker_id = worker_id
        self.workers = list(workers) if workers else None
        super().__init__(message)


def openai_error_content(message: str, error_type: str = "api_error",
                         worker_id: str | None = None, workers: list | None = None) -> dict:
    err = {"message": message, "type": error_type}
    if worker_id:
        err["worker_id"] = worker_id
    if workers:
        err["workers"] = list(workers)
    return {"error": err}


def openai_error_response(status_code: int, message: str, error_type: str = "api_error",
                          worker_id: str | None = None, workers: list | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=openai_error_content(message, error_type, worker_id, workers),
        headers={"X-TB-Worker": worker_id} if worker_id else None,
    )


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
    detail = j.get("detail")
    if isinstance(err, dict):
        return err.get("message") or err.get("detail") or str(err)
    if isinstance(err, str):
        # 网关常见 { error: "all_providers_failed", detail: "Model 'x' is not available" }
        generic = err.lower() in ("all_providers_failed", "api_error", "error")
        if generic and detail is not None:
            return str(detail)
        return err
    if detail is not None:
        return str(detail)
    return text[:500]


def combined_worker_error_text(err: str) -> str:
    """合并 HTTP 状态与 JSON body 中的 error/detail，供下线判定与日志。"""
    s = str(err or "").strip()
    if not s:
        return ""
    parts = [s]
    m = re.match(r"^HTTP[_\s]?(\d{3})\s*[:\s]*(.*)$", s, re.I | re.S)
    if not m:
        return s
    code = m.group(1)
    tail = (m.group(2) or "").strip()
    parts.append(f"http_{code}")
    try:
        j = json.loads(tail)
    except Exception:
        return " ".join(parts)
    if not isinstance(j, dict):
        return " ".join(parts)
    err = j.get("error")
    if isinstance(err, dict):
        for key in ("message", "type", "code", "detail"):
            val = err.get(key)
            if val is not None:
                parts.append(str(val))
    elif isinstance(err, str):
        parts.append(err)
    if j.get("detail") is not None:
        parts.append(str(j["detail"]))
    return " ".join(p for p in parts if p)


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
        msg_low = msg.lower()
        if "no worker available for model" in msg_low:
            return 404, msg, "model_not_found"
        if "not configured on this contributor" in msg_low or "not offered by this node" in msg_low:
            return 404, msg, "model_not_found"
        if "model_not_found" in msg_low or ("is not available" in msg_low and "model '" in msg_low):
            return 404, msg, "model_not_found"
        if "all_providers_failed" in combined_worker_error_text(s).lower():
            return 404, msg, "model_not_found"
        if code == 402 or "insufficient credits" in msg_low:
            return 402, msg, "insufficient_credits"
        if code == 401:
            return 401, msg, "authentication_error"
        if code == 429:
            return 429, msg, "rate_limit_exceeded"
        if code in (504, 408) or "timeout" in msg_low:
            return 504, msg, "timeout"
        if code == 503:
            return 503, msg, "service_unavailable"
        if 400 <= code < 500:
            return code, msg, "invalid_request_error"
        return 502, msg, "api_error"

    low = s.lower()
    if "timeout" in low:
        return 504, s, "timeout"
    if "no worker available for model" in low:
        return 404, s, "model_not_found"
    if "not configured on this contributor" in low or "not offered by this node" in low:
        return 404, s, "model_not_found"
    if "all_providers_failed" in low:
        return 404, s, "model_not_found"
    if "no worker" in low or "no image-capable worker" in low:
        return 503, s, "service_unavailable"
    if "insufficient credits" in low:
        return 402, s, "insufficient_credits"
    if "failed to reach worker" in low:
        return 502, s, "api_error"
    return 502, s, "api_error"


def raise_dispatch_error(err: str, worker_id: str | None = None, workers: list | None = None) -> None:
    status, msg, etype = parse_worker_error(err)
    raise DispatchError(status, msg, etype, worker_id=worker_id, workers=workers)


def should_offline_contributor_model(err: str) -> bool:
    """贡献节点无法实际提供该模型时，应从在线池下线对应模型。"""
    low = combined_worker_error_text(err).lower()
    if "not configured on this contributor" in low:
        return True
    if "p2p relay api key not configured" in low:
        return True
    if "no_enabled_provider_for_model" in low:
        return True
    if "model_not_found" in low:
        return True
    if "is not available" in low and "model '" in low:
        return True
    # 贡献节点本地网关 all_providers_failed：模型不存在、无供给源或全部转发失败
    if "all_providers_failed" in low:
        return True
    return False


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
        generic = err.lower() in ("all_providers_failed", "api_error", "error")
        if generic and data.get("detail") is not None:
            return str(data["detail"])
        return err
    if data.get("detail"):
        return str(data["detail"])
    return json.dumps(data, ensure_ascii=False)[:500]

"""公开网页（全球网络 / 模型试用 / 贡献者主页）用的纯函数与校验。"""
from __future__ import annotations

import re
from typing import Any, Callable, Optional


# 与客户端 Providers 对齐：文本 / 图文 / 生图 / 嵌入
MODEL_TYPES = ("chat", "vision", "image", "embedding")

# 网页短试用：限制上下文规模，防滥用
WEB_CHAT_MAX_MESSAGES = 8
WEB_CHAT_MAX_CONTENT_CHARS = 4000
WEB_IMAGE_MAX_PROMPT_CHARS = 2000

# 未登录网页试用：按 IP 限流（默认每小时 3 次成功调用）
GUEST_TRIAL_MAX_PER_HOUR = 3
_guest_hits: dict[str, list[float]] = {}

# 名称启发式（与客户端 models-mcp.inferModelTypeFromName 对齐）
_IMAGE_NAME_RE = re.compile(
    r"(?:^|[\-_/])image(?:[\-_/]|$|\d)|gpt-image|dall-e|dalle|stable-diffusion|flux-|midjourney|sdxl",
    re.I,
)
_EMBED_NAME_RE = re.compile(r"embed|text-embedding|bge-|e5-", re.I)


def guest_trial_allowed(ip: str, *, now: float | None = None, limit: int = GUEST_TRIAL_MAX_PER_HOUR) -> bool:
    """未登录试用额度：滑动 1 小时窗口。"""
    import time
    t = time.time() if now is None else now
    key = (ip or "unknown").strip() or "unknown"
    window = 3600.0
    hits = [x for x in _guest_hits.get(key, []) if t - x < window]
    if len(hits) >= limit:
        _guest_hits[key] = hits
        return False
    hits.append(t)
    _guest_hits[key] = hits
    return True


def validate_guest_web_chat_messages(messages: list) -> None:
    """访客仅允许单轮：一条 user 消息，无历史。"""
    if len(messages) != 1 or messages[0].get("role") != "user":
        raise ValueError("guest trial: one user message only — sign in to continue")


def validate_web_image_body(model: str, prompt: str, n: Any = 1) -> dict:
    """校验 /api/web-image 入参；失败抛 ValueError。"""
    m = str(model or "").strip()
    if not m:
        raise ValueError("missing model")
    text = str(prompt or "").strip()
    if not text:
        raise ValueError("missing prompt")
    if len(text) > WEB_IMAGE_MAX_PROMPT_CHARS:
        raise ValueError("prompt too long")
    try:
        count = int(n or 1)
    except (TypeError, ValueError) as e:
        raise ValueError("invalid n") from e
    if count < 1 or count > 4:
        raise ValueError("n must be 1..4")
    return {"model": m, "prompt": text, "n": count}


def normalize_model_type(raw: Any) -> str:
    """归一化为 chat|vision|image|embedding。"""
    t = str(raw or "chat").strip().lower()
    if t in ("text", "language", "llm"):
        return "chat"
    if t in ("img", "imggen", "t2i", "txt2img"):
        return "image"
    if t in ("embed", "embeddings"):
        return "embedding"
    if t in ("vl", "vlm", "multimodal"):
        return "vision"
    if t in MODEL_TYPES:
        return t
    return "chat"


def infer_model_type_from_name(name: str) -> str:
    """按名称启发式推断；vision 无法可靠从名称判断，缺省 chat。"""
    n = str(name or "")
    if _IMAGE_NAME_RE.search(n):
        return "image"
    if _EMBED_NAME_RE.search(n):
        return "embedding"
    return "chat"


def infer_model_type(name: str, type_map: Optional[dict] = None) -> str:
    """判定 chat|vision|image|embedding。
    显式 vision/image/embedding 优先；名称像生图/嵌入时纠偏误报的 chat。
    """
    m = str(name or "").strip()
    from_name = infer_model_type_from_name(m)
    declared = None
    if type_map and m in type_map:
        declared = normalize_model_type(type_map.get(m))

    if declared in ("image", "embedding", "vision"):
        # 误把生图/嵌入标成 vision 时仍以名称为准
        if declared == "vision" and from_name in ("image", "embedding"):
            return from_name
        return declared

    if from_name != "chat":
        return from_name
    return declared or "chat"


def is_chat_capable(mtype: str) -> bool:
    """文本对话路由：chat 与 vision（图文）均可走 chat completions。"""
    return normalize_model_type(mtype) in ("chat", "vision")


def validate_web_chat_body(model: str, messages: Any, sharer: Optional[str] = None) -> dict:
    """校验 /api/web-chat 入参；失败抛 ValueError(message)。"""
    m = str(model or "").strip()
    if not m:
        raise ValueError("missing model")
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages required")
    if len(messages) > WEB_CHAT_MAX_MESSAGES:
        raise ValueError(f"at most {WEB_CHAT_MAX_MESSAGES} messages")

    cleaned: list[dict] = []
    for i, raw in enumerate(messages):
        if not isinstance(raw, dict):
            raise ValueError(f"messages[{i}] must be object")
        role = str(raw.get("role") or "").strip()
        if role not in ("system", "user", "assistant"):
            raise ValueError(f"messages[{i}].role invalid")
        content = raw.get("content")
        if content is None:
            content = ""
        if not isinstance(content, str):
            raise ValueError(f"messages[{i}].content must be string")
        text = content.strip()
        if len(text) > WEB_CHAT_MAX_CONTENT_CHARS:
            raise ValueError(f"messages[{i}] too long")
        if role == "user" and not text:
            raise ValueError("empty user message")
        cleaned.append({"role": role, "content": text})

    if not any(x["role"] == "user" for x in cleaned):
        raise ValueError("need at least one user message")

    sh = str(sharer or "").strip() or None
    if sh and not (sh.startswith("s_") and len(sh) >= 4):
        raise ValueError("invalid sharer")

    return {"model": m, "messages": cleaned, "sharer": sh}


def extract_assistant_text(payload: Any) -> str:
    """从 OpenAI chat completion JSON 抽出 assistant 文本。"""
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0] if isinstance(choices[0], dict) else {}
    msg = first.get("message") if isinstance(first.get("message"), dict) else {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    # 部分上游把文本放在 text
    text = first.get("text")
    return text if isinstance(text, str) else ""


def aggregate_sharer_profile(
    workers: list,
    sharer: str,
    *,
    mask_name: Callable[[str], str],
    worker_sharer_fn: Callable[[Any], Optional[str]],
) -> Optional[dict]:
    """
    按 sharer 聚合在线供给：脱敏名、模型、公开智能体、用量统计。
    无匹配节点时返回 None。
    """
    handle = str(sharer or "").strip()
    if not handle:
        return None

    matched = [w for w in (workers or []) if worker_sharer_fn(w) == handle]
    if not matched:
        return None

    models: list[str] = []
    model_seen: set[str] = set()
    agents: list[dict] = []
    agent_seen: set[str] = set()
    period_tokens = 0
    period_agent_jobs = 0
    lat_sum = 0.0
    lat_n = 0
    display_raw = ""
    best_toks = -1

    for w in matched:
        owner = (getattr(w, "owner_nickname", None) or "").strip()
        raw_name = owner or (getattr(w, "name", None) or "")
        # 用量更高的节点名更有代表性
        toks = 0
        stats = getattr(w, "period_stats", None) or {}
        if isinstance(stats, dict):
            for k, s in stats.items():
                if not isinstance(s, dict):
                    continue
                toks += int(s.get("output_tokens") or 0)
                if str(k).startswith("__agent__"):
                    period_agent_jobs += int(s.get("agent_count") or 0)
        period_tokens += toks
        if toks > best_toks and raw_name:
            best_toks = toks
            display_raw = raw_name

        for m in getattr(w, "models", None) or []:
            mid = m if isinstance(m, str) else (m.get("name") if isinstance(m, dict) else "")
            mid = str(mid or "").strip()
            if mid and mid not in model_seen:
                model_seen.add(mid)
                models.append(mid)

        for card in getattr(w, "agents", None) or []:
            if not isinstance(card, dict) or not card.get("id"):
                continue
            if (card.get("visibility") or "public") != "public":
                continue
            aid = str(card["id"])
            if aid in agent_seen:
                continue
            agent_seen.add(aid)
            dn = card.get("display_name") or card.get("name") or aid
            agents.append({
                "id": aid,
                "name": card.get("name") or "",
                "display_name": dn,
                "description": card.get("description") or "",
                "runtime": card.get("runtime") or "",
            })

        # 延迟：有 period_stats 的 ttft 则累加；否则跳过
        if isinstance(stats, dict):
            ttft_sum = sum(float(s.get("ttft_sum") or 0) for s in stats.values() if isinstance(s, dict))
            ttft_n = sum(int(s.get("ttft_count") or 0) for s in stats.values() if isinstance(s, dict))
            if ttft_n > 0:
                lat_sum += ttft_sum / ttft_n
                lat_n += 1

    if not display_raw:
        display_raw = getattr(matched[0], "owner_nickname", None) or getattr(matched[0], "name", None) or handle

    return {
        "sharer": handle,
        "name": mask_name(str(display_raw)),
        "online_nodes": len(matched),
        "period_tokens": period_tokens,
        "period_agent_jobs": period_agent_jobs,
        "avg_latency_ms": round(lat_sum / lat_n) if lat_n else 0,
        "models": models,
        "agents": agents,
    }

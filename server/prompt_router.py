"""Prompt 分析路由引擎（DESIGN_v2.md §8.4.2 的 v2.2 提前实现）。

输入：OpenAI Chat Completions body + 请求 headers
输出：可选 RuleMatch（含 target_model + target_provider + rule 元信息）

匹配优先级：rules.priority 升序（小者优先）。第一条命中即返回。

支持的 match_kind：
  - token_count_gt:  输入 messages 估算的 token 数 > value
  - has_tools:       body.tools / body.tool_choice 存在
  - system_regex:    system message content regex 匹配
  - message_regex:   全部 messages 拼接后 regex 匹配
  - header_hint:     请求头 X-LLP-Hint 存在；value="*" = 任意值都触发，
                     否则 header 必须严格等于 value
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class RuleMatch:
    rule_id: int
    rule_name: str
    target_model: str          # 覆盖 body.model；空 = 不覆盖
    target_provider: str       # 偏好 provider_id；空 = 任意
    match_kind: str
    matched_value: str         # 命中的具体内容（debug 显示）


# ── 估算 token 数（粗略） ─────────────────────────────────────────────


def estimate_tokens(messages: list[dict]) -> int:
    """1 token ≈ 4 chars (英文) / 1.5 chars (中文)。

    这是粗估，避免引入 tiktoken 依赖。误差 ±30% 可接受。
    """
    total_chars = 0
    for m in messages or []:
        content = m.get("content")
        if isinstance(content, str):
            total_chars += len(content)
        elif isinstance(content, list):
            for p in content:
                if p.get("type") in (None, "text"):
                    total_chars += len(p.get("text", ""))
    # 用 3 作为综合系数（中英混合）
    return total_chars // 3


def _join_system(messages: list[dict]) -> str:
    """拼出所有 system messages 的文本。"""
    parts = []
    for m in messages or []:
        if m.get("role") == "system":
            c = m.get("content")
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, list):
                parts.extend(p.get("text", "") for p in c if p.get("type") in (None, "text"))
    return "\n".join(parts)


def _join_all_messages(messages: list[dict]) -> str:
    parts = []
    for m in messages or []:
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            parts.extend(p.get("text", "") for p in c if p.get("type") in (None, "text"))
    return "\n".join(parts)


# ── 单条规则匹配 ────────────────────────────────────────────────────


def _match_rule(rule: dict, body: dict, headers_lower: dict) -> Optional[str]:
    """返回命中时的「具体值」字符串（debug 用）；不命中返回 None。"""
    kind = rule.get("match_kind", "")
    value = rule.get("match_value", "")
    messages = body.get("messages") or []

    if kind == "token_count_gt":
        try:
            threshold = int(value)
        except (ValueError, TypeError):
            return None
        est = estimate_tokens(messages)
        return f"est~{est}" if est > threshold else None

    if kind == "has_tools":
        truthy = value.lower() in ("true", "1", "yes")
        present = bool(body.get("tools") or body.get("tool_choice"))
        return "tools=present" if (truthy and present) else None

    if kind == "system_regex":
        text = _join_system(messages)
        if not text:
            return None
        try:
            m = re.search(value, text)
            return f"matched: {m.group(0)[:60]}" if m else None
        except re.error:
            return None

    if kind == "message_regex":
        text = _join_all_messages(messages)
        if not text:
            return None
        try:
            m = re.search(value, text)
            return f"matched: {m.group(0)[:60]}" if m else None
        except re.error:
            return None

    if kind == "header_hint":
        hint = headers_lower.get("x-llp-hint") or headers_lower.get("x-llp-scenario")
        if not hint:
            return None
        if value == "*" or hint == value:
            return f"X-LLP-Hint={hint}"

    return None


# ── 对外 ────────────────────────────────────────────────────────────


def match_rules(rules: list[dict], body: dict, headers_lower: dict) -> Optional[RuleMatch]:
    """按 priority 升序找第一条 enabled 且命中的规则。"""
    for r in rules:
        if not r.get("enabled"):
            continue
        matched = _match_rule(r, body, headers_lower)
        if matched is not None:
            target_model = r.get("target_model") or ""
            # header_hint 特殊：用 header 值作 model 名
            if r.get("match_kind") == "header_hint" and not target_model:
                target_model = headers_lower.get("x-llp-hint") \
                            or headers_lower.get("x-llp-scenario") \
                            or ""
            return RuleMatch(
                rule_id=r.get("id", 0),
                rule_name=r.get("name", ""),
                target_model=target_model,
                target_provider=r.get("target_provider") or "",
                match_kind=r.get("match_kind", ""),
                matched_value=matched,
            )
    return None

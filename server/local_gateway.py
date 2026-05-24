"""本地网关 —— OpenAI / Anthropic 兼容入口，监听 127.0.0.1:11435。

设计文档：DESIGN_v2.md §1（板块①「模型接入」）

启动方式：
  uvicorn server.local_gateway:app --host 127.0.0.1 --port 11435 --reload

  或直接：
  python -m server.local_gateway

职责（P0 范围）：
  - 加载 data/free_providers.yaml 作为 Layer 1 内置目录
  - 提供 /v1/chat/completions、/v1/messages、/v1/models（OpenAI / Anthropic 兼容）
  - 提供 /__local__/* 管理端点（供 client UI 读写策略与 provider 配置）
  - 路由策略 = cost（按 price_in + price_out 升序）；quality / custom 后续迭代
  - 故障转移：候选链遇 5xx/超时按顺序重试

不做（推到 P0.5+）：
  - Electron 集成（用户先用 uvicorn 手动启动）
  - prompt-cache 中间件
  - WS 反向通道（板块③ 用，与本网关解耦）
"""

from __future__ import annotations

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import adapters
import app_writers
import ccswitch_import
import dashboard as dashboard_mod
import keystore
import local_db
import prompt_cache
import prompt_router
import subscription_providers
import subscriptions as subscriptions_mod

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s — %(message)s"
)
log = logging.getLogger("local-gateway")

# ── 路径 & 资源加载 ─────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("LLP_DATA_DIR", REPO_ROOT / "data"))
GUIDES_DIR = DATA_DIR / "guides"

_REQUEST_TIMEOUT = float(os.getenv("LLP_REQUEST_TIMEOUT", "120"))


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_free_providers_catalog() -> list[dict]:
    """Layer 1 内置目录 + 用户覆盖（~/.local-llm-proxy/free_providers.user.yaml）。"""
    base = _load_yaml(DATA_DIR / "free_providers.yaml").get("providers", [])
    user_path = Path.home() / ".local-llm-proxy" / "free_providers.user.yaml"
    user = _load_yaml(user_path).get("providers", []) if user_path.exists() else []
    by_id = {p["id"]: p for p in base}
    for p in user:
        by_id[p["id"]] = {**by_id.get(p["id"], {}), **p}
    return list(by_id.values())


def load_paid_providers_catalog() -> list[dict]:
    """Layer 2 内置目录 + 用户覆盖（含导入自 cc-switch 的条目）。"""
    base = _load_yaml(DATA_DIR / "paid_providers.yaml").get("providers", [])
    user_path = Path.home() / ".local-llm-proxy" / "paid_providers.user.yaml"
    user = _load_yaml(user_path).get("providers", []) if user_path.exists() else []
    by_id = {p["id"]: p for p in base}
    for p in user:
        by_id[p["id"]] = {**by_id.get(p["id"], {}), **p}
    return list(by_id.values())


def save_user_paid_providers(providers: list[dict]) -> None:
    """合并写入 ~/.local-llm-proxy/paid_providers.user.yaml。"""
    user_path = Path.home() / ".local-llm-proxy" / "paid_providers.user.yaml"
    user_path.parent.mkdir(parents=True, exist_ok=True)
    existing = _load_yaml(user_path).get("providers", []) if user_path.exists() else []
    by_id = {p["id"]: p for p in existing}
    for p in providers:
        by_id[p["id"]] = {**by_id.get(p["id"], {}), **p}
    with user_path.open("w", encoding="utf-8") as f:
        yaml.safe_dump({"providers": list(by_id.values())}, f, allow_unicode=True, sort_keys=False)


# ── Lifecycle ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await local_db.init_local_db()
    log.info("local.db ready at %s", local_db.LOCAL_DB_PATH)
    log.info("keystore backend: %s", keystore.backend_name())
    log.info("free provider catalog: %d entries", len(load_free_providers_catalog()))
    # 触发 gateway key 生成（首次启动）
    gw_key = await local_db.get_or_create_gateway_key()
    log.info("gateway key ready: %s", keystore.mask(gw_key))
    # P1 订阅层 scaffold 表
    await subscription_providers.init_subscription_db()
    # prompt-cache 表（M9 Step 1）
    await prompt_cache.init_cache_db()
    # 订阅管理（DASH-B）
    await subscriptions_mod.init_subscriptions_table()
    # 加载 model_prices.yaml（dashboard 节省估值）
    dashboard_mod.load_model_prices()
    yield


app = FastAPI(title="Local LLM Proxy — Local Gateway", lifespan=lifespan)

# Electron renderer / Vite dev server / curl 都需要
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════════════════════════════════════
# 路由策略 —— P0 只实现 cost；quality / custom 留 TODO
# ═══════════════════════════════════════════════════════════════════════════


async def _filter_cooled_down(candidates: list[dict]) -> list[dict]:
    """剔除当前在 cooldown 的 provider（429 等）。"""
    cooled = await local_db.list_active_cooldowns()
    if not cooled:
        return candidates
    return [c for c in candidates if c["id"] not in cooled]


async def _candidates_from_scenario(scenario: dict, model_hint: str | None = None) -> list[dict]:
    """从 scenario.degradation_chain 展开成扁平 candidate 列表。

    chain 形如：
      [
        {"label":"优先", "candidates":[{"provider_id":"ollama","model":"llama3.2"}, ...]},
        {"label":"改选", "candidates":[{"provider_id":"groq","model":"llama-3.1-8b"}, ...]},
      ]

    展平后按 step 顺序、step 内顺序成 [provider1, provider2, ...]，
    并把每个候选的 _forced_model 注入到 provider dict 上以便上游请求时改写。
    """
    providers = await local_db.list_providers(enabled_only=True)
    by_id = {p["provider_id"]: p for p in providers}
    chain = scenario.get("degradation_chain") or []
    flat = []
    seen = set()
    for step in chain:
        for cand in (step.get("candidates") or []):
            pid = cand.get("provider_id")
            mdl = cand.get("model") or model_hint
            if not pid or pid not in by_id:
                continue
            key = (pid, mdl or "")
            if key in seen:
                continue
            seen.add(key)
            entry = dict(by_id[pid])  # copy
            entry["_forced_model"] = mdl
            entry["_step_label"] = step.get("label") or ""
            flat.append(entry)
    return flat


async def _candidates_for_model(model: str, *, policy: dict | None = None) -> list[dict]:
    """返回该 model 的候选 provider 列表。

    匹配规则：
      - provider.models 列表里精确含 model，或
      - provider.models 为空（Ollama 这类「任意模型」provider 总是候选）

    排序规则：
      - 若提供 policy（M13 routing_policies）：先按 allowed_tiers 过滤 →
        按 tier_order 分组排序 → 组内按 cost / health 二次排序
      - 否则退回到全局 strategy 设置（cost / quality / custom）
    """
    providers = await local_db.list_providers(enabled_only=True)

    candidates = []
    for p in providers:
        models = p.get("models") or []
        if not models or model in models:
            candidates.append(p)

    # M13：app 关联的 routing_policy 优先
    if policy is not None:
        allowed = set(policy.get("allowed_tiers") or [])
        if allowed:
            candidates = [p for p in candidates if (p.get("tier") or "free") in allowed]
        order = policy.get("tier_order") or []
        order_index = {t: i for i, t in enumerate(order)}
        candidates.sort(
            key=lambda p: (
                order_index.get(p.get("tier") or "free", 999),
                (p.get("price_in") or 0.0) + (p.get("price_out") or 0.0),
                -(p.get("health_score") or 1.0),
            )
        )
        return candidates

    strategy = await local_db.get_setting("strategy", "cost")
    if strategy == "cost":
        candidates.sort(
            key=lambda p: (
                (p.get("price_in") or 0.0) + (p.get("price_out") or 0.0),
                -(p.get("health_score") or 1.0),
                p.get("priority") or 100,
            )
        )
    elif strategy == "quality":
        candidates.sort(
            key=lambda p: (
                -(p.get("health_score") or 1.0),
                (p.get("price_in") or 0.0) + (p.get("price_out") or 0.0),
                p.get("priority") or 100,
            )
        )
    else:  # custom
        candidates.sort(key=lambda p: p.get("priority") or 100)

    return candidates


def _parse_retry_after(headers, default: int = 300) -> int:
    """从 Retry-After 头解析秒数；缺失则返回 default。"""
    val = headers.get("retry-after") or headers.get("Retry-After")
    if not val:
        return default
    try:
        return max(1, int(val))
    except (ValueError, TypeError):
        # HTTP-date 格式较罕见，简化忽略
        return default


def _auth_headers(provider: dict) -> dict[str, str]:
    """根据 provider.auth_type 与 key_ref 组装请求头。"""
    auth_type = provider.get("auth_type") or "bearer"
    if auth_type == "none":
        return {}
    key_ref = provider.get("key_ref") or ""
    secret = keystore.get_key(key_ref) if key_ref else None
    if not secret:
        # 无 key 不强制失败：可能是 ollama 这类无鉴权的，但 auth_type=bearer 时上游会拒
        return {}
    return {"Authorization": f"Bearer {secret}"}


# ═══════════════════════════════════════════════════════════════════════════
# OpenAI 兼容路由
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/v1/models")
async def list_models():
    """返回所有 enabled provider 的模型并集（OpenAI 兼容格式）。"""
    providers = await local_db.list_providers(enabled_only=True)
    data = []
    seen = set()
    for p in providers:
        for m in (p.get("models") or []):
            if m in seen:
                continue
            seen.add(m)
            data.append({
                "id": m,
                "object": "model",
                "created": int(time.time()),
                "owned_by": p["provider_id"],
            })
    return {"object": "list", "data": data}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    return await _forward_openai(request, path_suffix="/chat/completions")


@app.post("/v1/embeddings")
async def embeddings(request: Request):
    return await _forward_openai(request, path_suffix="/embeddings")


async def _forward_openai(request: Request, *, path_suffix: str):
    """OpenAI 兼容请求转发：按候选链尝试，遇 5xx/超时换下一个；流式直通。

    M11/M14：识别 X-Source-App 头；M11 写 call_logs；M14 用对应 app_binding
    的 policy 决定候选链；调用结束时落日志。
    """
    started = time.time()
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    model = body.get("model")
    if not model:
        raise HTTPException(400, "Missing 'model' field")

    headers_lower = {k.lower(): v for k, v in request.headers.items()}
    app_source = headers_lower.get("x-source-app", "")
    debug_mode = headers_lower.get("x-llp-debug", "").lower() in ("1", "on", "true")
    debug_attempts: list[dict] = []  # 记录每次候选尝试，给 _llp_debug 用

    # v2.1 redesign：识别 Authorization: Bearer tb-* → scenario
    scenario = None
    auth_hdr = headers_lower.get("authorization", "")
    if auth_hdr.lower().startswith("bearer "):
        bearer = auth_hdr[7:].strip()
        if bearer.startswith("tb-"):
            scenario = await local_db.get_scenario_by_api_key(bearer)
            if scenario and not app_source:
                app_source = scenario["name"]  # 显示用

    # M14：根据 app_source 查关联 policy（仅当无 scenario 时退回到 policy 路径）
    policy = None
    if scenario is None and app_source:
        binding = await local_db.get_app_binding_with_policy(app_source)
        if binding and binding.get("policy"):
            policy = binding["policy"]

    # PROMPT-2：规则引擎匹配。命中后改写 body.model 和优先 provider
    rules = await local_db.list_routing_rules(enabled_only=True)
    rule_match = prompt_router.match_rules(rules, body, headers_lower)
    if rule_match and rule_match.target_model:
        original_model = model
        model = rule_match.target_model
        body = {**body, "model": model}
        log.info("prompt-rule '%s' matched: %s → model=%s",
                 rule_match.rule_name, rule_match.matched_value, model)

    # prompt-cache 查找
    cache_key = None
    if path_suffix == "/chat/completions" and prompt_cache.is_cacheable_request(body, headers_lower):
        cache_key = prompt_cache.compute_cache_key(body)
        cache_hit_resp = await prompt_cache.get(cache_key)
        if cache_hit_resp is not None:
            log.info("prompt-cache HIT key=%s model=%s", cache_key[:12], model)
            await local_db.log_call(
                model=model, routed_to="prompt-cache",
                tier="cache", app_source=app_source,
                input_tokens=0, output_tokens=0,
                latency_ms=int((time.time() - started) * 1000),
                cached=True,
                scenario_id=(scenario["id"] if scenario else None),
            )
            return JSONResponse(content={**cache_hit_resp, "_llp_cached": True})

    if scenario is not None:
        candidates = await _candidates_from_scenario(scenario, model_hint=model)
    else:
        candidates = await _candidates_for_model(model, policy=policy)

    # 剔除 cooldown 中的 provider（429 临时禁用）
    candidates = await _filter_cooled_down(candidates)

    # 规则引擎指定的 target_provider 抬到候选链最前
    if rule_match and rule_match.target_provider:
        candidates.sort(key=lambda c: 0 if c["provider_id"] == rule_match.target_provider else 1)

    if not candidates:
        await local_db.log_call(
            model=model, routed_to="none", tier="none",
            app_source=app_source, success=False,
            error_msg="No provider matches model + policy/scenario",
            latency_ms=int((time.time() - started) * 1000),
        )
        raise HTTPException(
            404, f"No provider available for model '{model}' "
                 f"({'scenario=' + scenario['name'] if scenario else ('policy=' + policy['name'] if policy else 'default')})."
        )

    streaming = bool(body.get("stream"))
    last_err: Optional[str] = None

    for p in candidates:
        # scenario 候选可能强制改写 model（候选 = {provider, model} 二元组）
        send_body = body
        if p.get("_forced_model") and p["_forced_model"] != model:
            send_body = {**body, "model": p["_forced_model"]}

        # 选 adapter：provider.protocol 决定（默认 openai 兼容透传）
        protocol = p.get("protocol") or "openai"
        adapter = adapters.get_adapter(protocol)
        api_key = keystore.get_key(p.get("key_ref") or "") if p.get("key_ref") else None
        adapter_result = adapter.build_request(
            base_url=p.get("base_url") or "",
            api_key=api_key,
            openai_body=send_body,
            request_headers=headers_lower,
        )
        url = adapter_result.url
        headers = adapter_result.headers
        upstream_body = adapter_result.body

        try:
            if streaming:
                return StreamingResponse(
                    _stream_upstream_with_adapter(
                        url, headers, upstream_body, p, adapter,
                        model=(p.get("_forced_model") or model),
                    ),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )
            else:
                async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as cli:
                    r = await cli.post(url, headers=headers, json=upstream_body)
                if r.status_code >= 500:
                    last_err = f"{p['display_name']} → HTTP {r.status_code}: {r.text[:200]}"
                    log.warning("Upstream 5xx, trying next candidate: %s", last_err)
                    await local_db.update_provider(p["id"], last_error=last_err)
                    if debug_mode:
                        debug_attempts.append({
                            "provider_id": p["provider_id"], "model": p.get("_forced_model") or model,
                            "step": p.get("_step_label", ""), "status": r.status_code,
                            "outcome": "5xx, fallback",
                        })
                    continue
                # 429 = 配额耗尽 / 速率限制：标 cooldown 并 fallback
                if r.status_code == 429:
                    retry_after = _parse_retry_after(r.headers, default=300)
                    until_ts = await local_db.set_provider_cooldown(
                        p["id"], cooldown_seconds=retry_after,
                        reason=f"upstream 429: {r.text[:120]}",
                    )
                    last_err = f"{p['display_name']} → 429 quota exhausted, cooldown {retry_after}s"
                    log.warning(last_err)
                    await local_db.update_provider(p["id"], last_error=last_err)
                    if debug_mode:
                        debug_attempts.append({
                            "provider_id": p["provider_id"], "model": p.get("_forced_model") or model,
                            "step": p.get("_step_label", ""), "status": 429,
                            "outcome": f"429 cooldown {retry_after}s, fallback",
                        })
                    continue
                # 4xx 视为客户端问题，直接返回不重试
                await local_db.update_provider(
                    p["id"], last_used_at=time.strftime("%Y-%m-%dT%H:%M:%S"), last_error=""
                )
                raw_resp = r.json() if "application/json" in r.headers.get("content-type", "") else None
                # adapter 转响应为 OpenAI 格式（passthrough adapter 就直接返回）
                if raw_resp is not None and r.status_code < 400:
                    try:
                        resp_data = adapter.convert_response(raw_resp, model=(p.get("_forced_model") or model))
                    except Exception as e:
                        log.warning("adapter %s convert_response failed: %s", adapter.name, e)
                        resp_data = raw_resp
                else:
                    resp_data = raw_resp
                if cache_key and r.status_code < 300 and resp_data:
                    ttl_hdr = headers_lower.get("x-llp-cache-ttl")
                    try:
                        ttl = int(ttl_hdr) if ttl_hdr else prompt_cache.DEFAULT_TTL_SECONDS
                    except ValueError:
                        ttl = prompt_cache.DEFAULT_TTL_SECONDS
                    await prompt_cache.put(cache_key, model, resp_data, ttl_seconds=ttl)
                # M11：调用日志
                usage = (resp_data or {}).get("usage") or {} if isinstance(resp_data, dict) else {}
                latency = int((time.time() - started) * 1000)
                await local_db.log_call(
                    model=(p.get("_forced_model") or model),
                    routed_to=p["provider_id"],
                    tier=p.get("tier", "free"), app_source=app_source,
                    input_tokens=int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
                    output_tokens=int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
                    latency_ms=latency,
                    success=(r.status_code < 400),
                    error_msg="" if r.status_code < 400 else f"HTTP {r.status_code}",
                    scenario_id=(scenario["id"] if scenario else None),
                )
                # 调试模式：在 JSON 响应里附 _llp_debug 元数据
                if debug_mode and isinstance(resp_data, dict):
                    debug_attempts.append({
                        "provider_id": p["provider_id"], "model": p.get("_forced_model") or model,
                        "step": p.get("_step_label", ""), "status": r.status_code,
                        "outcome": "success" if r.status_code < 400 else f"HTTP {r.status_code}",
                    })
                    resp_data = {
                        **resp_data,
                        "_llp_debug": {
                            "scenario_name": scenario["name"] if scenario else None,
                            "scenario_id":   scenario["id"]   if scenario else None,
                            "routed_to":     p["provider_id"],
                            "actual_model":  p.get("_forced_model") or model,
                            "step_label":    p.get("_step_label", ""),
                            "tier":          p.get("tier", "free"),
                            "protocol":      p.get("protocol", "openai"),
                            "latency_ms":    latency,
                            "attempts":      debug_attempts,
                            "rule_match":    None if not rule_match else {
                                "rule_name":     rule_match.rule_name,
                                "match_kind":    rule_match.match_kind,
                                "matched_value": rule_match.matched_value,
                                "target_model":  rule_match.target_model,
                                "target_provider": rule_match.target_provider,
                            },
                        },
                    }
                return JSONResponse(
                    content=resp_data if resp_data is not None else r.text,
                    status_code=r.status_code,
                )
        except httpx.HTTPError as e:
            last_err = f"{p['display_name']} → {type(e).__name__}: {e}"
            log.warning("Upstream error, trying next candidate: %s", last_err)
            await local_db.update_provider(p["id"], last_error=last_err)
            if debug_mode:
                debug_attempts.append({
                    "provider_id": p["provider_id"], "model": p.get("_forced_model") or model,
                    "step": p.get("_step_label", ""), "status": 0,
                    "outcome": f"{type(e).__name__}: {e}",
                })
            continue

    await local_db.log_call(
        model=model, routed_to="exhausted", tier="none",
        app_source=app_source, success=False, error_msg=last_err or "all failed",
        latency_ms=int((time.time() - started) * 1000),
        scenario_id=(scenario["id"] if scenario else None),
    )
    raise HTTPException(502, f"All upstream providers failed. Last error: {last_err}")


async def _stream_upstream_with_adapter(url: str, headers: dict, body: dict,
                                          provider: dict, adapter, *, model: str):
    """SSE 流：经 adapter 包一层转换为 OpenAI SSE。"""
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as cli:
        try:
            async with cli.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code >= 400:
                    text = (await r.aread()).decode("utf-8", errors="replace")
                    yield f'data: {{"error": "Upstream {r.status_code}: {text[:200]}"}}\n\n'.encode("utf-8")
                    await local_db.update_provider(provider["id"], last_error=f"HTTP {r.status_code}")
                    return
                async for out_chunk in adapter.convert_stream(r.aiter_bytes(), model=model):
                    if out_chunk:
                        yield out_chunk
            await local_db.update_provider(
                provider["id"], last_used_at=time.strftime("%Y-%m-%dT%H:%M:%S"), last_error="",
            )
        except httpx.HTTPError as e:
            err = f"{type(e).__name__}: {e}"
            yield f'data: {{"error": "{err}"}}\n\n'.encode("utf-8")
            await local_db.update_provider(provider["id"], last_error=err)


async def _stream_upstream(url: str, headers: dict, body: dict, provider: dict):
    """SSE 直通流式响应。"""
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as cli:
        try:
            async with cli.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code >= 400:
                    text = (await r.aread()).decode("utf-8", errors="replace")
                    yield f'data: {{"error": "Upstream {r.status_code}: {text[:200]}"}}\n\n'
                    await local_db.update_provider(
                        provider["id"], last_error=f"HTTP {r.status_code}"
                    )
                    return
                async for chunk in r.aiter_bytes():
                    if chunk:
                        yield chunk
            await local_db.update_provider(
                provider["id"], last_used_at=time.strftime("%Y-%m-%dT%H:%M:%S"), last_error=""
            )
        except httpx.HTTPError as e:
            err = f"{type(e).__name__}: {e}"
            yield f'data: {{"error": "{err}"}}\n\n'
            await local_db.update_provider(provider["id"], last_error=err)


# ═══════════════════════════════════════════════════════════════════════════
# Anthropic 兼容路由（最小可用 —— /v1/messages 透传到 Anthropic-shape 上游）
# ═══════════════════════════════════════════════════════════════════════════


@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    """对外暴露 Anthropic Messages API。

    P0 简化策略：只有当候选 provider 的 base_url 看起来是 Anthropic 端点
    （含 'anthropic' 或 '/v1' 后缀但无 /chat/completions 形式）时才走原生透传，
    否则路由到对应 OpenAI 兼容上游并由调用方负责形式适配（P1 再补转换）。
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    model = body.get("model")
    if not model:
        raise HTTPException(400, "Missing 'model' field")

    candidates = await _candidates_for_model(model)
    if not candidates:
        raise HTTPException(404, f"No provider available for model '{model}'")

    streaming = bool(body.get("stream"))
    last_err: Optional[str] = None

    for p in candidates:
        base_url = (p["base_url"] or "").rstrip("/")
        url = base_url + "/messages" if "anthropic" in base_url else base_url + "/messages"
        # Anthropic 需要 x-api-key + anthropic-version
        key = keystore.get_key(p.get("key_ref") or "")
        headers = {
            "Content-Type": "application/json",
            "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
        }
        if key:
            headers["x-api-key"] = key

        try:
            if streaming:
                return StreamingResponse(
                    _stream_upstream(url, headers, body, p),
                    media_type="text/event-stream",
                )
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as cli:
                r = await cli.post(url, headers=headers, json=body)
            if r.status_code >= 500:
                last_err = f"{p['display_name']} → HTTP {r.status_code}"
                continue
            return JSONResponse(content=r.json(), status_code=r.status_code)
        except httpx.HTTPError as e:
            last_err = f"{p['display_name']} → {type(e).__name__}: {e}"
            continue

    raise HTTPException(502, f"All upstream providers failed. Last error: {last_err}")


# ═══════════════════════════════════════════════════════════════════════════
# 管理端 API —— /__local__/* 仅本机调用，client UI 用
# ═══════════════════════════════════════════════════════════════════════════


class StrategyUpdate(BaseModel):
    strategy: str = Field(..., pattern="^(cost|quality|custom)$")


@app.get("/__local__/health")
async def local_health():
    gw_key = await local_db.get_or_create_gateway_key()
    return {
        "ok": True,
        "strategy": await local_db.get_setting("strategy", "cost"),
        "advanced_mode": (await local_db.get_setting("advanced_mode", "0")) == "1",
        "keystore_backend": keystore.backend_name(),
        "local_db": local_db.LOCAL_DB_PATH,
        "gateway_url": f"http://127.0.0.1:{os.getenv('LLP_PORT', '11435')}",
        "gateway_key_masked": keystore.mask(gw_key),
    }


@app.get("/__local__/gateway-key")
async def reveal_gateway_key():
    """返回未脱敏 key。仅本机回环访问，且由 UI 显式调用（点「显示」按钮）。

    TODO: 加 Bearer 校验前应严格限制此端点，并对 /v1/* 强制验 key。
    """
    return {
        "gateway_key": await local_db.get_or_create_gateway_key(),
        "gateway_url": f"http://127.0.0.1:{os.getenv('LLP_PORT', '11435')}",
    }


@app.post("/__local__/gateway-key/rotate")
async def rotate_gateway_key():
    new_key = await local_db.rotate_gateway_key()
    return {"gateway_key": new_key, "rotated": True}


# ═══════════════════════════════════════════════════════════════════════════
# 板块① Path B —— 一键写入器（M2）
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/__local__/apps")
async def list_apps():
    """列出所有支持的客户端工具 + 当前 DB 中的 binding 状态。"""
    schemas = app_writers.list_schemas()
    bindings = {b["app_name"]: b for b in await local_db.list_app_bindings()}
    out = []
    for s in schemas:
        b = bindings.get(s["app_name"])
        out.append({
            **s,
            "bound": bool(b),
            "binding": b,
        })
    return {"apps": out}


@app.get("/__local__/apps/{app_name}/preview")
async def preview_app(app_name: str, preferred_model: Optional[str] = None):
    gw_key = await local_db.get_or_create_gateway_key()
    gw_url = f"http://127.0.0.1:{os.getenv('LLP_PORT', '11435')}/v1"
    ctx = {"base_url": gw_url, "api_key": gw_key, "preferred_model": preferred_model}
    try:
        return app_writers.preview(app_name, ctx)
    except KeyError as e:
        raise HTTPException(404, str(e))


class WriteAppBindingPayload(BaseModel):
    preferred_model: Optional[str] = None


@app.post("/__local__/apps/{app_name}/write")
async def write_app(app_name: str, payload: WriteAppBindingPayload):
    if app_name not in app_writers.SCHEMAS:
        raise HTTPException(404, f"Unknown app: {app_name}")
    gw_key = await local_db.get_or_create_gateway_key()
    gw_url = f"http://127.0.0.1:{os.getenv('LLP_PORT', '11435')}/v1"
    ctx = {
        "base_url": gw_url,
        "api_key": gw_key,
        "preferred_model": payload.preferred_model,
    }
    result = app_writers.write(app_name, ctx)
    if result.ok:
        await local_db.upsert_app_binding(
            app_name=result.app_name,
            base_url=gw_url,
            api_key_masked=keystore.mask(gw_key),
            last_error="",
        )
    else:
        await local_db.upsert_app_binding(
            app_name=app_name,
            base_url=gw_url,
            api_key_masked=keystore.mask(gw_key),
            last_error=result.error or "",
        )
    return {
        "ok": result.ok,
        "app_name": result.app_name,
        "display": result.display,
        "path": result.path,
        "backup_path": result.backup_path,
        "needs_env_var": result.needs_env_var,
        "env_var_hint": result.env_var_hint,
        "error": result.error,
    }


@app.delete("/__local__/apps/{app_name}/binding")
async def delete_app_binding(app_name: str):
    """仅清除 DB 中 binding 记录（不撤销文件写入）。

    用户若想恢复工具原配置，需到 ~/.local-llm-proxy/backups/ 找备份手动还原。
    """
    if app_name not in app_writers.SCHEMAS:
        raise HTTPException(404, f"Unknown app: {app_name}")
    import aiosqlite
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        await db.execute("DELETE FROM app_bindings WHERE app_name = ?", (app_name,))
        await db.commit()
    return {"ok": True, "note": "DB record removed; file unchanged. Check ~/.local-llm-proxy/backups/ for prior state."}


@app.get("/__local__/strategy")
async def get_strategy():
    return {"strategy": await local_db.get_setting("strategy", "cost")}


@app.post("/__local__/strategy")
async def set_strategy(payload: StrategyUpdate):
    await local_db.set_setting("strategy", payload.strategy)
    return {"strategy": payload.strategy}


@app.get("/__local__/providers")
async def list_local_providers():
    providers = await local_db.list_providers()
    cooldowns = await local_db.list_active_cooldowns()
    now_ts = int(time.time())
    for p in providers:
        ref = p.get("key_ref") or ""
        secret = keystore.get_key(ref) if ref else None
        p["key_present"] = bool(secret) if p.get("auth_type") != "none" else True
        p["key_masked"] = keystore.mask(secret) if secret else ""
        p.pop("key_ref", None)
        cd = cooldowns.get(p["id"])
        if cd:
            p["cooldown_remaining_sec"] = max(0, cd["cooldown_until"] - now_ts)
            p["cooldown_reason"] = cd.get("reason", "")
            p["cooldown_count_429"] = cd.get("count_429", 0)
        else:
            p["cooldown_remaining_sec"] = 0
    return {"providers": providers, "strategy": await local_db.get_setting("strategy", "cost")}


@app.post("/__local__/providers/{row_id}/clear-cooldown")
async def clear_cooldown_endpoint(row_id: int):
    await local_db.clear_provider_cooldown(row_id)
    return {"ok": True}


# ── Free catalog ────────────────────────────────────────────────────────────


@app.get("/__local__/free-catalog")
async def free_catalog():
    """暴露 free_providers.yaml 的目录给 Onboarding UI。"""
    catalog = load_free_providers_catalog()
    out = []
    for entry in catalog:
        guide_path = DATA_DIR / entry.get("guide_md", "")
        guide_text = ""
        if guide_path.exists():
            try:
                guide_text = guide_path.read_text(encoding="utf-8")
            except OSError:
                pass
        out.append({**entry, "guide_text": guide_text})
    return {"providers": out}


@app.get("/__local__/paid-catalog")
async def paid_catalog():
    """Layer 2 付费/订阅目录。"""
    return {"providers": load_paid_providers_catalog()}


@app.get("/__local__/share-pool")
async def share_pool():
    """Layer 3 用户分享池 —— 来自板块③ 贡献网络。

    本地网关单独运行时无法获取真实分享池（需要 VPS 端 worker_pool）。
    返回空列表 + 提示，等 P2 接入板块③ 时再填充。
    """
    return {
        "providers": [],
        "available": False,
        "notice": "分享池需要连接 VPS 贡献网络（板块③）。"
                  "请到「Agent」页登录账号、启动 worker，"
                  "并到 Onboarding 页配置 VPS URL 才能看到。",
    }


@app.get("/__local__/ccswitch/available")
async def ccswitch_available():
    """检测本机是否安装 cc-switch。"""
    return {
        "available": ccswitch_import.is_available(),
        "db_path": str(ccswitch_import.CCSWITCH_DB),
    }


@app.post("/__local__/ccswitch/import")
async def do_ccswitch_import():
    """一次性导入 cc-switch 的 provider 条目到 paid_providers.user.yaml。"""
    if not ccswitch_import.is_available():
        raise HTTPException(404, "cc-switch is not installed on this machine.")
    imported = ccswitch_import.read_providers()
    if imported:
        save_user_paid_providers(imported)
    return {"imported": len(imported), "items": imported}


# ═══════════════════════════════════════════════════════════════════════════
# 板块③ 贡献体系（Phase C）—— 三层 source_kind + 高级模式 + ToS ack
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/__local__/contribute/sources")
async def list_contribute_sources():
    return {
        "sources": await local_db.list_contribution_sources(),
        "advanced_mode": (await local_db.get_setting("advanced_mode", "0")) == "1",
    }


class AddSourcePayload(BaseModel):
    source_kind: str = Field(..., pattern="^(local|gateway|subscription)$")
    display_name: str
    base_url: str = ""
    models: list[str] = []
    quota_unit: str = ""
    quota_total: float = 0.0
    schedule: str = ""
    notes: str = ""


@app.post("/__local__/contribute/sources")
async def add_contribute_source(payload: AddSourcePayload):
    if payload.source_kind == "subscription":
        if (await local_db.get_setting("advanced_mode", "0")) != "1":
            raise HTTPException(
                403,
                "Subscription sources are gated behind advanced mode. "
                "Enable it first via POST /__local__/contribute/advanced-mode/enable with ack.",
            )
    row_id = await local_db.add_contribution_source(
        source_kind=payload.source_kind,
        display_name=payload.display_name,
        base_url=payload.base_url,
        models=payload.models,
        quota_unit=payload.quota_unit,
        quota_total=payload.quota_total,
        schedule=payload.schedule,
        notes=payload.notes,
    )
    return {"id": row_id, "ok": True}


@app.post("/__local__/contribute/sources/{row_id}/toggle")
async def toggle_contribute_source(row_id: int, enabled: bool):
    await local_db.toggle_contribution_source(row_id, enabled)
    return {"id": row_id, "enabled": enabled}


@app.delete("/__local__/contribute/sources/{row_id}")
async def remove_contribute_source(row_id: int):
    await local_db.delete_contribution_source(row_id)
    return {"ok": True}


# 高级模式开关 + 三重 ack

ADVANCED_MODE_ACK_TEXT = """
启用高风险贡献源（订阅账号转 API）涉及以下 4 条具体风险：

1. **上游服务条款（ToS）**：OpenAI / Anthropic / Google 等订阅协议明确禁止
   把账号 / Cookie / 会话 token 分享或用于第三方代理调用，违反将导致永久封号。
2. **共享 IP 风控**：你的贡献流量与其他用户的请求会混合，
   触发上游的滥用检测后可能整批被风控；不仅你受影响。
3. **本地法律合规**：在部分地区"未授权转售算力 / 账号"可能违反相关条款；
   产生的法律责任由你本人承担。
4. **数据隐私**：消费者的 prompt 内容会经你的账号转发上游，
   上游服务商和你的账号都会看到这些数据。

我已阅读并理解以上 4 条具体风险，并自愿承担相应后果。
"""


class EnableAdvancedPayload(BaseModel):
    ack: bool = False
    user_hint: str = ""


@app.post("/__local__/contribute/advanced-mode/enable")
async def enable_advanced_mode(payload: EnableAdvancedPayload):
    if not payload.ack:
        raise HTTPException(400, "Must acknowledge the 4 specific risks before enabling.")
    await local_db.record_tos_ack(
        action="enable_advanced",
        ack_text=ADVANCED_MODE_ACK_TEXT.strip(),
        user_hint=payload.user_hint,
    )
    await local_db.set_setting("advanced_mode", "1")
    return {"advanced_mode": True}


@app.post("/__local__/contribute/advanced-mode/disable")
async def disable_advanced_mode():
    await local_db.record_tos_ack(
        action="disable_advanced",
        ack_text="user disabled advanced mode",
    )
    await local_db.set_setting("advanced_mode", "0")
    return {"advanced_mode": False}


@app.get("/__local__/contribute/advanced-mode/text")
async def advanced_mode_text():
    return {"text": ADVANCED_MODE_ACK_TEXT.strip()}


@app.get("/__local__/contribute/tos-acks")
async def list_acks(limit: int = 50):
    return {"acks": await local_db.list_tos_acks(limit=limit)}


# ═══════════════════════════════════════════════════════════════════════════
# P1 订阅层 scaffold（仅平台清单 + 状态查询，dispatch 未实现）
# ═══════════════════════════════════════════════════════════════════════════


# ── PROMPT-1/2/3 routing_rules CRUD ─────────────────────────────────


@app.get("/__local__/rules")
async def list_rules_endpoint():
    return {"rules": await local_db.list_routing_rules()}


class UpsertRulePayload(BaseModel):
    name: str
    match_kind: str = Field(..., pattern="^(token_count_gt|has_tools|system_regex|message_regex|header_hint)$")
    match_value: str
    target_model: str = ""
    target_provider: str = ""
    priority: int = 100
    enabled: bool = True
    description: str = ""


@app.post("/__local__/rules")
async def upsert_rule_endpoint(payload: UpsertRulePayload):
    rid = await local_db.upsert_routing_rule(**payload.model_dump())
    return {"id": rid, "ok": True}


@app.post("/__local__/rules/{rule_id}/toggle")
async def toggle_rule_endpoint(rule_id: int, enabled: bool):
    await local_db.toggle_routing_rule(rule_id, enabled)
    return {"id": rule_id, "enabled": enabled}


@app.delete("/__local__/rules/{rule_id}")
async def delete_rule_endpoint(rule_id: int):
    ok = await local_db.delete_routing_rule(rule_id)
    if not ok:
        raise HTTPException(400, "Cannot delete builtin rule")
    return {"ok": True}


@app.get("/__local__/cache/stats")
async def cache_stats():
    return await prompt_cache.stats()


@app.post("/__local__/cache/clear")
async def cache_clear():
    cleared = await prompt_cache.clear()
    return {"cleared": cleared}


@app.get("/__local__/subscription/platforms")
async def list_subscription_platforms():
    return {
        "platforms": subscription_providers.list_supported_platforms(),
        "status": "scaffold-only",
        "notice": (
            "订阅层正在开发中（P1 / M10）。当前仅展示支持的平台清单与 schema；"
            "实际的 cookie 持久化 + 浏览器自动化 + ToS-risky 调用通路尚未启用。"
        ),
    }


# ═══════════════════════════════════════════════════════════════════════════
# M11 Dashboard / M13 Policies / M15 QuickStart
# ═══════════════════════════════════════════════════════════════════════════

from datetime import datetime, timedelta


def _today_iso() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d 00:00:00")


def _month_iso() -> str:
    return datetime.utcnow().strftime("%Y-%m-01 00:00:00")


@app.get("/__local__/dashboard/summary")
async def dashboard_summary(window: str = "today"):
    """聚合 Dashboard 主页用的所有数据。window = today / month / all."""
    if window == "today":
        since = _today_iso()
    elif window == "month":
        since = _month_iso()
    else:
        since = None

    providers = await local_db.list_providers()
    tier_capacity = {"free": {"providers": 0, "models": set()},
                     "paid": {"providers": 0, "models": set()},
                     "shared": {"providers": 0, "models": set()}}
    for p in providers:
        if not p.get("enabled"):
            continue
        t = p.get("tier") or "free"
        if t not in tier_capacity:
            t = "free"
        tier_capacity[t]["providers"] += 1
        for m in (p.get("models") or []):
            tier_capacity[t]["models"].add(m)
    for v in tier_capacity.values():
        v["model_count"] = len(v["models"])
        del v["models"]

    by_tier = await local_db.aggregate_by_tier(since_iso=since)
    by_app = await local_db.aggregate_by_app(since_iso=since)
    bindings = await local_db.list_app_bindings()
    # 给每个 binding 关联 policy.name
    bindings_full = []
    for b in bindings:
        full = await local_db.get_app_binding_with_policy(b["app_name"])
        bindings_full.append({
            **b,
            "policy_name": (full or {}).get("policy", {}).get("name") if full else None,
        })

    return {
        "window": window,
        "since": since,
        "tier_capacity": tier_capacity,
        "tier_usage": by_tier,
        "by_app": by_app,
        "bindings": bindings_full,
        "provider_count": len([p for p in providers if p.get("enabled")]),
    }


@app.get("/__local__/dashboard/recent")
async def dashboard_recent(limit: int = 10):
    return {"calls": await local_db.recent_calls(limit)}


# ── M13 policies ──────────────────────────────────────────────────────────


@app.get("/__local__/policies")
async def list_policies():
    return {"policies": await local_db.list_routing_policies()}


class UpsertPolicyPayload(BaseModel):
    name: str
    tier_order: list[str]
    allowed_tiers: list[str]
    max_cost_per_1m: float = 0
    fallback_enabled: bool = True
    model_preference: str = ""


@app.post("/__local__/policies")
async def upsert_policy(payload: UpsertPolicyPayload):
    pid = await local_db.upsert_routing_policy(
        name=payload.name,
        tier_order=payload.tier_order,
        allowed_tiers=payload.allowed_tiers,
        max_cost_per_1m=payload.max_cost_per_1m,
        fallback_enabled=payload.fallback_enabled,
        model_preference=payload.model_preference,
    )
    return {"id": pid, "ok": True}


@app.delete("/__local__/policies/{policy_id}")
async def delete_policy(policy_id: int):
    ok = await local_db.delete_routing_policy(policy_id)
    if not ok:
        raise HTTPException(400, "Cannot delete builtin policy or policy not found.")
    return {"ok": True}


class SetAppPolicyPayload(BaseModel):
    policy_id: int | None = None  # None = 取消关联


@app.post("/__local__/apps/{app_name}/policy")
async def set_app_policy(app_name: str, payload: SetAppPolicyPayload):
    if app_name not in app_writers.SCHEMAS:
        raise HTTPException(404, f"Unknown app: {app_name}")
    await local_db.set_app_binding_policy(app_name, payload.policy_id)
    return {"ok": True, "app_name": app_name, "policy_id": payload.policy_id}


# ── M15 QuickStart ────────────────────────────────────────────────────────


@app.get("/__local__/quickstart/detect")
async def quickstart_detect():
    """探测本机可以零摩擦接入的资源。"""
    home = Path.home()

    # Ollama 检测：尝试 GET 127.0.0.1:11434
    ollama_alive = False
    ollama_models: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=2) as cli:
            r = await cli.get("http://127.0.0.1:11434/api/tags")
            if r.status_code == 200:
                ollama_alive = True
                data = r.json()
                ollama_models = [m.get("name", "") for m in (data.get("models") or [])][:10]
    except httpx.HTTPError:
        pass

    # 各 app 配置文件存在性
    app_status = []
    for name, schema in app_writers.SCHEMAS.items():
        app_status.append({
            "app_name": name,
            "display": schema.display,
            "config_exists": schema.path.exists(),
            "path": str(schema.path),
        })

    # 已有 provider / binding 数量
    provider_count = len(await local_db.list_providers(enabled_only=True))
    binding_count = len(await local_db.list_app_bindings())

    # 推荐组合
    recommendation = []
    if ollama_alive:
        recommendation.append({
            "kind": "free_provider",
            "provider_id": "ollama",
            "reason": f"本机检测到 Ollama 在线 ({len(ollama_models)} 个模型)，零成本零摩擦",
        })
    else:
        recommendation.append({
            "kind": "free_provider",
            "provider_id": "groq",
            "reason": "Ollama 未运行；推荐 Groq（注册 1 分钟，速度最快）",
        })
    for entry in app_status:
        if entry["config_exists"] and entry["app_name"] == "claude_code":
            recommendation.append({
                "kind": "app_binding",
                "app_name": "claude_code",
                "reason": "检测到 ~/.claude/settings.local.json，可直接写入",
            })
            break

    return {
        "ollama": {"alive": ollama_alive, "models": ollama_models},
        "apps": app_status,
        "existing": {"providers": provider_count, "bindings": binding_count},
        "recommendation": recommendation,
        "needs_quickstart": provider_count == 0 and binding_count == 0,
    }


# ── scenarios（v2.1 redesign）───────────────────────────────────────────

SCENARIO_TEMPLATES = [
    {
        "id": "claude-code-daily",
        "name": "Claude Code 日常",
        "icon": "🦙",
        "description": "本机 Qwen3 → Groq Llama 4 → GitHub Models GPT-5.5-mini 终极兜底",
        "chain": [
            {"label": "优先", "candidates": [{"provider_id": "ollama", "model": "qwen3:8b"}]},
            {"label": "改选", "candidates": [{"provider_id": "groq", "model": "llama-4-70b-instruct"}]},
            {"label": "兜底", "candidates": [{"provider_id": "github-models", "model": "gpt-5.5-mini"}]},
        ],
    },
    {
        "id": "writing",
        "name": "写作创作",
        "icon": "✨",
        "description": "Gemini 2.5 Flash 主力 → Qwen 3 兜底，写文章 / 翻译 / 总结都合适",
        "chain": [
            {"label": "优先", "candidates": [{"provider_id": "gemini-ai-studio", "model": "gemini-2.5-flash"}]},
            {"label": "改选", "candidates": [{"provider_id": "groq", "model": "qwen-3-32b"}]},
            {"label": "兜底", "candidates": [{"provider_id": "siliconflow", "model": "Qwen/Qwen3-8B-Instruct"}]},
        ],
    },
    {
        "id": "code-review",
        "name": "代码 Review",
        "icon": "🔬",
        "description": "重质量推理：DeepSeek-R1 优先 → GPT-5.5 → Claude Sonnet 4.6 兜底",
        "chain": [
            {"label": "优先", "candidates": [{"provider_id": "siliconflow", "model": "deepseek-ai/DeepSeek-R1"}]},
            {"label": "改选", "candidates": [{"provider_id": "github-models", "model": "gpt-5.5"}]},
            {"label": "兜底", "candidates": [{"provider_id": "anthropic-official", "model": "claude-sonnet-4-6"}]},
        ],
    },
    {
        "id": "long-context",
        "name": "长文本分析",
        "icon": "📊",
        "description": "Gemini 2.5 Pro（2M 上下文）→ Claude Opus 4.7（1M）→ Llama 4 405B 兜底",
        "chain": [
            {"label": "优先", "candidates": [{"provider_id": "gemini-ai-studio", "model": "gemini-2.5-pro"}]},
            {"label": "改选", "candidates": [{"provider_id": "anthropic-official", "model": "claude-opus-4-7"}]},
            {"label": "兜底", "candidates": [{"provider_id": "github-models", "model": "Meta-Llama-4-405B-Instruct"}]},
        ],
    },
    {
        "id": "batch-cheap",
        "name": "批量便宜跑",
        "icon": "💸",
        "description": "全部走免费极速 Llama 4 / Qwen 3 8B，无成本批量任务",
        "chain": [
            {"label": "优先", "candidates": [
                {"provider_id": "ollama", "model": "qwen3:8b"},
                {"provider_id": "cerebras", "model": "llama-4-8b"},
                {"provider_id": "groq", "model": "llama-4-8b-instant"},
            ]},
        ],
    },
    {
        "id": "production-stable",
        "name": "生产稳定",
        "icon": "🔒",
        "description": "仅自有付费 key：Claude Opus 4.7 / GPT-5.5-pro / DeepSeek-R1 顶级三件套",
        "chain": [
            {"label": "优先", "candidates": [
                {"provider_id": "anthropic-official", "model": "claude-opus-4-7"},
                {"provider_id": "openai-official", "model": "gpt-5.5-pro"},
                {"provider_id": "deepseek-official", "model": "deepseek-reasoner"},
            ]},
        ],
    },
]


@app.get("/__local__/scenarios/templates")
async def list_scenario_templates():
    """6 个内置模板 + 每个模板缺哪些 provider 的提示。"""
    installed_ids = {p["provider_id"] for p in await local_db.list_providers(enabled_only=True)}
    out = []
    for tpl in SCENARIO_TEMPLATES:
        required = set()
        for step in tpl["chain"]:
            for cand in step["candidates"]:
                required.add(cand["provider_id"])
        missing = sorted(required - installed_ids)
        out.append({**tpl, "required_providers": sorted(required), "missing_providers": missing})
    return {"templates": out}


class CreateFromTemplatePayload(BaseModel):
    template_id: str
    name: Optional[str] = None  # 不传则用模板默认名


@app.post("/__local__/scenarios/from-template")
async def create_scenario_from_template(payload: CreateFromTemplatePayload):
    tpl = next((t for t in SCENARIO_TEMPLATES if t["id"] == payload.template_id), None)
    if not tpl:
        raise HTTPException(404, f"Unknown template '{payload.template_id}'")
    s = await local_db.create_scenario(
        name=payload.name or tpl["name"],
        degradation_chain=tpl["chain"],
        description=tpl["description"],
    )
    return {**s, "template_id": tpl["id"], "missing_providers": [
        p for p in {c["provider_id"] for step in tpl["chain"] for c in step["candidates"]}
        if p not in {pr["provider_id"] for pr in await local_db.list_providers(enabled_only=True)}
    ]}


@app.get("/__local__/scenarios")
async def list_scenarios_endpoint():
    scenarios = await local_db.list_scenarios()
    # 给每个 scenario 附加今日统计
    today = _today_iso()
    for s in scenarios:
        s["stats_today"] = await local_db.scenario_call_stats(s["id"], since_iso=today)
    return {"scenarios": scenarios}


class CreateScenarioPayload(BaseModel):
    name: str
    description: str = ""
    degradation_chain: list[dict] = []  # [{label, candidates:[{provider_id, model}]}]


@app.post("/__local__/scenarios")
async def create_scenario_endpoint(payload: CreateScenarioPayload):
    s = await local_db.create_scenario(
        name=payload.name,
        degradation_chain=payload.degradation_chain,
        description=payload.description,
    )
    return s


class UpdateScenarioPayload(BaseModel):
    name: str | None = None
    description: str | None = None
    degradation_chain: list[dict] | None = None


@app.patch("/__local__/scenarios/{scenario_id}")
async def update_scenario_endpoint(scenario_id: int, payload: UpdateScenarioPayload):
    ok = await local_db.update_scenario(
        scenario_id,
        name=payload.name,
        description=payload.description,
        degradation_chain=payload.degradation_chain,
    )
    if not ok:
        raise HTTPException(400, "No fields to update")
    return await local_db.get_scenario(scenario_id)


@app.post("/__local__/scenarios/{scenario_id}/rotate-key")
async def rotate_scenario_key_endpoint(scenario_id: int):
    new_key = await local_db.rotate_scenario_key(scenario_id)
    if not new_key:
        raise HTTPException(404, "Scenario not found")
    return {"api_key": new_key}


@app.delete("/__local__/scenarios/{scenario_id}")
async def delete_scenario_endpoint(scenario_id: int):
    await local_db.delete_scenario(scenario_id)
    return {"ok": True}


# ── Gateway KPIs（v2.1 redesign Gateway 页顶部 4 个数字） ──────────────


# ── Dashboard 数据端点（DASH-A） ────────────────────────────────────

@app.get("/__local__/dashboard/trend")
async def dashboard_trend(window: str = "7d"):
    return await dashboard_mod.aggregate_trend(window=window)


@app.get("/__local__/dashboard/attribution")
async def dashboard_attribution(window: str = "today", limit: int = 10):
    since = _today_iso() if window == "today" else (_month_iso() if window == "month" else None)
    items = await dashboard_mod.aggregate_attribution(since_iso=since, limit=limit)
    return {"window": window, "items": items}


@app.get("/__local__/dashboard/savings")
async def dashboard_savings(window: str = "today"):
    since = _today_iso() if window == "today" else (_month_iso() if window == "month" else None)
    return await dashboard_mod.aggregate_savings(since_iso=since)


# ── 订阅 CRUD（DASH-B） ──────────────────────────────────────────────

@app.get("/__local__/subscriptions")
async def list_subs_endpoint():
    subs = await subscriptions_mod.list_subscriptions()
    enriched = [await subscriptions_mod.enrich_subscription(s) for s in subs]
    return {"subscriptions": enriched}


class CreateSubPayload(BaseModel):
    provider_id: str
    display_name: str
    plan_kind: str = "payg"   # plan / payg / prepaid
    plan_name: str = ""
    monthly_cost: float = 0
    currency: str = "USD"
    quota_total: float = 0
    balance_remaining: Optional[float] = None
    renews_at: Optional[str] = None
    auto_renew: bool = False
    alert_balance_pct: float = 20
    alert_days_before: int = 1
    alert_enabled: bool = True
    notes: str = ""


@app.post("/__local__/subscriptions")
async def create_sub_endpoint(payload: CreateSubPayload):
    sid = await subscriptions_mod.create_subscription(**payload.model_dump())
    return await subscriptions_mod.get_subscription(sid)


class UpdateSubPayload(BaseModel):
    display_name: Optional[str] = None
    plan_kind: Optional[str] = None
    plan_name: Optional[str] = None
    monthly_cost: Optional[float] = None
    quota_total: Optional[float] = None
    balance_remaining: Optional[float] = None
    renews_at: Optional[str] = None
    auto_renew: Optional[bool] = None
    alert_balance_pct: Optional[float] = None
    alert_days_before: Optional[int] = None
    alert_enabled: Optional[bool] = None
    notes: Optional[str] = None


@app.patch("/__local__/subscriptions/{sub_id}")
async def update_sub_endpoint(sub_id: int, payload: UpdateSubPayload):
    safe = {k: v for k, v in payload.model_dump().items() if v is not None}
    await subscriptions_mod.update_subscription(sub_id, **safe)
    return await subscriptions_mod.get_subscription(sub_id)


@app.delete("/__local__/subscriptions/{sub_id}")
async def delete_sub_endpoint(sub_id: int):
    await subscriptions_mod.delete_subscription(sub_id)
    return {"ok": True}


@app.get("/__local__/alerts")
async def alerts_endpoint():
    return {"alerts": await subscriptions_mod.compute_alerts()}


# ── 原 KPI 加 savings 字段 ──────────────────────────────────────────


@app.get("/__local__/gateway/kpis")
async def gateway_kpis(window: str = "today"):
    if window == "today":
        since = _today_iso()
    elif window == "month":
        since = _month_iso()
    else:
        since = None

    by_tier = await local_db.aggregate_by_tier(since_iso=since)
    total_calls = sum(t["calls"] for t in by_tier.values())
    free_calls = (by_tier.get("free") or {}).get("calls", 0)
    cache_calls = (by_tier.get("cache") or {}).get("calls", 0)
    free_hit_rate = round(((free_calls + cache_calls) / total_calls * 100), 1) if total_calls else 0.0

    # 错误率 + 平均延迟：从 call_logs 直接算
    import aiosqlite
    err_rate = 0.0
    avg_latency = 0
    async with aiosqlite.connect(local_db.LOCAL_DB_PATH) as db:
        sql = "SELECT COUNT(*) AS total, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS errs, AVG(latency_ms) AS lat FROM call_logs"
        args: list = []
        if since:
            sql += " WHERE timestamp >= ?"
            args.append(since)
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, args) as cur:
            r = await cur.fetchone()
        if r and r["total"]:
            err_rate = round((r["errs"] or 0) / r["total"] * 100, 2)
            avg_latency = int(r["lat"] or 0)

    # 加上 savings（DASH-B：今日节省）
    savings = await dashboard_mod.aggregate_savings(since_iso=since)
    return {
        "window": window,
        "total_calls": total_calls,
        "free_hit_rate": free_hit_rate,
        "error_rate": err_rate,
        "avg_latency_ms": avg_latency,
        "saved_usd": savings["saved_usd"],
        "saved_pct": savings["saved_pct"],
        "paid_equivalent_usd": savings["paid_equivalent_usd"],
    }


class QuickstartRunPayload(BaseModel):
    free_provider_id: str        # 例如 'ollama' / 'groq'
    api_key: str = ""
    app_names: list[str] = []    # 要一键写入的工具列表
    policy_name: str = "cost-first"
    preferred_model: str | None = None


@app.post("/__local__/quickstart/run")
async def quickstart_run(payload: QuickstartRunPayload):
    """事务性 quickstart：加 provider + 一次性写入多个 app binding。

    失败时尽量回滚（删掉本次添加的 provider；已写入的 app 配置回滚需要用户去 backup 找）。
    """
    catalog = {p["id"]: p for p in load_free_providers_catalog()}
    entry = catalog.get(payload.free_provider_id)
    if not entry:
        raise HTTPException(404, f"Unknown free provider '{payload.free_provider_id}'")

    auth_type = (entry.get("auth") or {}).get("type", "bearer")
    key_ref = ""
    if auth_type != "none":
        if not payload.api_key:
            raise HTTPException(400, "api_key is required for this provider")
        key_ref = payload.free_provider_id
        keystore.set_key(key_ref, payload.api_key)

    provider_row_id = await local_db.add_provider(
        provider_id=payload.free_provider_id,
        display_name=entry.get("display") or payload.free_provider_id,
        tier=entry.get("tier", "free"),
        base_url=entry.get("base_url", ""),
        auth_type=auth_type,
        key_ref=key_ref,
        models=entry.get("models") or [],
    )

    # 选 policy id
    policy = await local_db.get_routing_policy_by_name(payload.policy_name)
    policy_id = policy["id"] if policy else None

    # 自动选模型（用户没指定时）
    chosen_model = payload.preferred_model or (entry.get("models") or [None])[0]

    written = []
    errors = []
    gw_key = await local_db.get_or_create_gateway_key()
    gw_url = f"http://127.0.0.1:{os.getenv('LLP_PORT', '11435')}/v1"

    for app_name in payload.app_names:
        if app_name not in app_writers.SCHEMAS:
            errors.append({"app_name": app_name, "error": "Unknown app"})
            continue
        result = app_writers.write(app_name, {
            "base_url": gw_url, "api_key": gw_key,
            "preferred_model": chosen_model,
        })
        if result.ok:
            await local_db.upsert_app_binding(
                app_name=result.app_name, base_url=gw_url,
                api_key_masked=keystore.mask(gw_key), last_error="",
            )
            if policy_id:
                await local_db.set_app_binding_policy(result.app_name, policy_id)
            written.append({"app_name": app_name, "path": result.path,
                             "backup_path": result.backup_path})
        else:
            errors.append({"app_name": app_name, "error": result.error})

    return {
        "ok": len(errors) == 0,
        "provider_id": payload.free_provider_id,
        "provider_row_id": provider_row_id,
        "policy_id": policy_id,
        "model": chosen_model,
        "written": written,
        "errors": errors,
    }


# ── Provider CRUD（从 free catalog 派生） ──────────────────────────────────


class CreateFromCatalog(BaseModel):
    provider_id: str           # free_providers.yaml 中的 id
    api_key: str = ""          # 用户填写的 key（auth_type=none 时为空）
    models: Optional[list[str]] = None  # 若用户改了模型列表
    account_id: Optional[str] = None    # Cloudflare 类需要的 {ACCOUNT_ID} 模板填充


@app.post("/__local__/providers/from-catalog")
async def create_from_catalog(payload: CreateFromCatalog):
    """根据 free_providers.yaml 目录条目实例化一个 local_providers 记录。

    若 auth_type != none 则会把 api_key 写入 keystore，并存 key_ref 到 DB。
    """
    catalog = {p["id"]: p for p in load_free_providers_catalog()}
    entry = catalog.get(payload.provider_id)
    if not entry:
        raise HTTPException(404, f"Unknown provider_id '{payload.provider_id}'")

    auth = entry.get("auth") or {}
    auth_type = auth.get("type", "bearer")

    key_ref = ""
    if auth_type != "none":
        if not payload.api_key:
            raise HTTPException(400, "api_key is required for non-public providers")
        # key_ref 用 provider_id（同一目录同 ref，覆盖更新）
        key_ref = payload.provider_id
        ok = keystore.set_key(key_ref, payload.api_key)
        if not ok and keystore.backend_name().startswith("env-only"):
            # 让用户知道 key 没真存进 OS keychain，但 env-only 模式下可用环境变量绕过
            log.warning(
                "Keystore unavailable; user must set env var %s=<key>",
                payload.provider_id.upper().replace("-", "_") + "_API_KEY",
            )

    # 模板替换：{ACCOUNT_ID} 等
    base_url = entry.get("base_url", "")
    if entry.get("requires_account_id"):
        if not payload.account_id:
            raise HTTPException(400, "account_id is required for this provider (Cloudflare, etc.)")
        base_url = base_url.replace("{ACCOUNT_ID}", payload.account_id.strip())
    # 同时按 yaml 中其它 {{...}} 占位符简单 format 处理（预留）
    row_id = await local_db.add_provider(
        provider_id=payload.provider_id,
        display_name=entry.get("display") or payload.provider_id,
        tier=entry.get("tier", "free"),
        base_url=base_url,
        auth_type=auth_type,
        key_ref=key_ref,
        models=payload.models if payload.models is not None else (entry.get("models") or []),
        protocol=entry.get("protocol", "openai"),
    )
    return {"id": row_id, "provider_id": payload.provider_id, "protocol": entry.get("protocol", "openai"), "base_url": base_url}


@app.delete("/__local__/providers/{row_id}")
async def delete_local_provider(row_id: int):
    p = await local_db.get_provider(row_id)
    if not p:
        raise HTTPException(404, "Provider not found")
    if p.get("key_ref"):
        keystore.delete_key(p["key_ref"])
    await local_db.delete_provider(row_id)
    return {"ok": True}


# ── Test connection ────────────────────────────────────────────────────────


class TestConnPayload(BaseModel):
    provider_id: str           # catalog id（如 'groq'）
    api_key: str = ""          # 测试用 key（不入库）
    model: Optional[str] = None  # 若不传，用 catalog 中第一个模型


@app.post("/__local__/test-connection")
async def test_connection(payload: TestConnPayload):
    """对一个 catalog 条目做最小请求验活，不入库 / 不写 keystore。

    优先 GET {base_url}/models（OpenAI 兼容），失败时再尝试 chat/completions 探一次。
    """
    catalog = {p["id"]: p for p in load_free_providers_catalog()}
    entry = catalog.get(payload.provider_id)
    if not entry:
        raise HTTPException(404, f"Unknown provider_id '{payload.provider_id}'")

    base_url = (entry.get("base_url") or "").rstrip("/")
    auth_type = (entry.get("auth") or {}).get("type", "bearer")
    headers: dict[str, str] = {}
    if auth_type == "bearer":
        if not payload.api_key:
            raise HTTPException(400, "api_key is required")
        headers["Authorization"] = f"Bearer {payload.api_key}"

    started = time.time()
    async with httpx.AsyncClient(timeout=15) as cli:
        # 1) GET /models
        try:
            r = await cli.get(base_url + "/models", headers=headers)
            if r.status_code < 400:
                return {
                    "ok": True,
                    "via": "GET /models",
                    "latency_ms": int((time.time() - started) * 1000),
                    "model_count": len(r.json().get("data", [])) if "application/json" in r.headers.get("content-type", "") else None,
                }
        except httpx.HTTPError:
            pass

        # 2) POST /chat/completions（最小请求）
        model = payload.model or (entry.get("models") or ["unknown"])[0]
        try:
            r = await cli.post(
                base_url + "/chat/completions",
                headers={**headers, "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "hi"}],
                    "max_tokens": 1,
                },
            )
            if r.status_code < 400:
                return {
                    "ok": True,
                    "via": f"POST /chat/completions (model={model})",
                    "latency_ms": int((time.time() - started) * 1000),
                }
            return {
                "ok": False,
                "status": r.status_code,
                "error": (r.text or "")[:500],
                "latency_ms": int((time.time() - started) * 1000),
            }
        except httpx.HTTPError as e:
            return {
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
                "latency_ms": int((time.time() - started) * 1000),
            }


# ═══════════════════════════════════════════════════════════════════════════
# Entry
# ═══════════════════════════════════════════════════════════════════════════

def main():
    import uvicorn
    uvicorn.run(
        "local_gateway:app",
        host=os.getenv("LLP_HOST", "127.0.0.1"),
        port=int(os.getenv("LLP_PORT", "11435")),
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()

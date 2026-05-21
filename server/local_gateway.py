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

import app_writers
import keystore
import local_db

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
    # user 覆盖 base：按 id merge
    by_id = {p["id"]: p for p in base}
    for p in user:
        by_id[p["id"]] = {**by_id.get(p["id"], {}), **p}
    return list(by_id.values())


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


async def _candidates_for_model(model: str) -> list[dict]:
    """返回该 model 的候选 provider 列表，按当前策略排序。

    匹配规则：
      - provider.models 列表里精确含 model，或
      - provider.models 为空（Ollama 这类「任意模型」provider 总是候选）
    """
    strategy = await local_db.get_setting("strategy", "cost")
    providers = await local_db.list_providers(enabled_only=True)

    candidates = []
    for p in providers:
        models = p.get("models") or []
        if not models or model in models:
            candidates.append(p)

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
    """OpenAI 兼容请求转发：按候选链尝试，遇 5xx/超时换下一个；流式直通。"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    model = body.get("model")
    if not model:
        raise HTTPException(400, "Missing 'model' field")

    candidates = await _candidates_for_model(model)
    if not candidates:
        raise HTTPException(
            404, f"No provider available for model '{model}'. "
                  "Add one via /__local__/providers."
        )

    streaming = bool(body.get("stream"))
    last_err: Optional[str] = None

    for p in candidates:
        base_url = (p["base_url"] or "").rstrip("/")
        url = base_url + path_suffix
        headers = {"Content-Type": "application/json", **_auth_headers(p)}

        try:
            if streaming:
                return StreamingResponse(
                    _stream_upstream(url, headers, body, p),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )
            else:
                async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as cli:
                    r = await cli.post(url, headers=headers, json=body)
                if r.status_code >= 500:
                    last_err = f"{p['display_name']} → HTTP {r.status_code}: {r.text[:200]}"
                    log.warning("Upstream 5xx, trying next candidate: %s", last_err)
                    await local_db.update_provider(p["id"], last_error=last_err)
                    continue
                # 4xx 视为客户端问题，直接返回不重试
                await local_db.update_provider(
                    p["id"], last_used_at=time.strftime("%Y-%m-%dT%H:%M:%S"), last_error=""
                )
                return JSONResponse(
                    content=r.json() if "application/json" in r.headers.get("content-type", "") else r.text,
                    status_code=r.status_code,
                )
        except httpx.HTTPError as e:
            last_err = f"{p['display_name']} → {type(e).__name__}: {e}"
            log.warning("Upstream error, trying next candidate: %s", last_err)
            await local_db.update_provider(p["id"], last_error=last_err)
            continue

    raise HTTPException(502, f"All upstream providers failed. Last error: {last_err}")


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
    # 不返回 key_ref 之外的敏感信息，且把 key 是否可用算出来
    for p in providers:
        ref = p.get("key_ref") or ""
        secret = keystore.get_key(ref) if ref else None
        p["key_present"] = bool(secret) if p.get("auth_type") != "none" else True
        p["key_masked"] = keystore.mask(secret) if secret else ""
        # 不暴露 key 本身
        p.pop("key_ref", None)
    return {"providers": providers, "strategy": await local_db.get_setting("strategy", "cost")}


# ── Free catalog ────────────────────────────────────────────────────────────


@app.get("/__local__/free-catalog")
async def free_catalog():
    """暴露 free_providers.yaml 的目录给 Onboarding UI。"""
    catalog = load_free_providers_catalog()
    # 加上 guide markdown 内联（UI 直接渲染）
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


# ── Provider CRUD（从 free catalog 派生） ──────────────────────────────────


class CreateFromCatalog(BaseModel):
    provider_id: str           # free_providers.yaml 中的 id
    api_key: str = ""          # 用户填写的 key（auth_type=none 时为空）
    models: Optional[list[str]] = None  # 若用户改了模型列表


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

    row_id = await local_db.add_provider(
        provider_id=payload.provider_id,
        display_name=entry.get("display") or payload.provider_id,
        tier=entry.get("tier", "free"),
        base_url=entry.get("base_url", ""),
        auth_type=auth_type,
        key_ref=key_ref,
        models=payload.models if payload.models is not None else (entry.get("models") or []),
    )
    return {"id": row_id, "provider_id": payload.provider_id}


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

#!/usr/bin/env python3
"""LLM Agent — 将本地内网 LLM 接入远程代理服务"""

import asyncio
import json
import re
import socket
import sys
from pathlib import Path

import httpx
from httpx import URL

import click
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

CONFIG_PATH = Path.home() / ".llm-agent" / "config.json"
RECONNECT_DELAY = 5


def explain_ws_close(exc: ConnectionClosed) -> str:
    """Map server close codes to English hints (aligned with server/server.py)."""
    code = getattr(exc, "code", None) or 0
    reason = (getattr(exc, "reason", "") or "").strip()
    hints = {
        4001: (
            "registration rejected: server requires a valid user portal worker_key (wk-...); "
            "copy from User Portal after login; re-run llm-agent register --worker-key ..."
        ),
        4008: (
            "registration timeout: server gave up waiting for the first message "
            "(network too slow or stalled)"
        ),
        1011: "registration failed: server-side error (check VPS logs tagged [worker/ws])",
        1000: "normal closure",
        1006: (
            "abnormal disconnect (no close frame received; often network loss or remote kill)"
        ),
    }
    hint = hints.get(code, "see WebSocket close code documentation")
    parts = [f"code={code}"]
    if reason:
        parts.append(f'reason="{reason}"')
    parts.append(hint)
    return " | ".join(parts)


# ── Config ──────────────────────────────────────────────────────────────────

def load_config(path: Path) -> dict:
    if not path.exists():
        click.echo(f"[agent] config file not found: {path}", err=True)
        click.echo("[agent] run `llm-agent register ...` first", err=True)
        sys.exit(1)
    return json.loads(path.read_text(encoding="utf-8"))


def save_config(cfg: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def log_forward(cfg: dict, message: str) -> None:
    """转发调试日志（stderr，避免与正常输出混在一起）"""
    if cfg.get("forward_log"):
        click.echo(message, err=True)


# ── CLI ──────────────────────────────────────────────────────────────────────

@click.group()
def cli():
    """LLM Agent — 将本地 LLM 贡献到远程代理服务"""


@cli.command()
@click.option("--server",    required=True, help="代理服务 WebSocket 地址，如 ws://vps:8000/ws/worker")
@click.option("--worker-key", required=True, help="用户中心 Worker Key（wk-...），用于接入鉴权与积分归属")
@click.option("--models",    required=True, help="支持的模型，逗号分隔，如 qwen3-32b,qwen3-7b")
@click.option("--llm-url",   required=True, help="内网 LLM base URL，如 http://localhost:11434")
@click.option("--llm-token",   default="",    help="内网 LLM 的 API Token（可选）")
@click.option("--name",        default="",    help="节点名称（默认使用主机名）")
@click.option("--forward-log", is_flag=True, default=False, help="在配置中启用转发日志（也可用 start --forward-log 临时开启）")
@click.option("--config",      default=str(CONFIG_PATH), help="配置文件保存路径")
def register(server, worker_key, models, llm_url, llm_token, name, forward_log, config):
    """注册并保存 Agent 配置"""
    wk = worker_key.strip()
    cfg = {
        "server_url":   server,
        "worker_key":   wk,
        "name":         name.strip() or socket.gethostname(),
        "models":       [m.strip() for m in models.split(",") if m.strip()],
        "llm_base_url": llm_url.rstrip("/"),
        "llm_token":    llm_token,
        "forward_log":  forward_log,
    }
    path = Path(config)
    save_config(cfg, path)
    click.echo(f"配置已保存至 {path}")
    click.echo(f"  服务器  : {server}")
    click.echo(f"  节点名  : {cfg['name']}")
    click.echo(f"  模型    : {', '.join(cfg['models'])}")
    click.echo(f"  LLM URL : {llm_url}")
    click.echo(f"  Worker Key: {wk[:12]}… (masked)")
    click.echo("\n运行 'llm-agent start' 启动 Agent")


@cli.command()
@click.option("--config", default=str(CONFIG_PATH), help="配置文件路径")
def status(config):
    """查看当前配置"""
    cfg = load_config(Path(config))
    click.echo("当前配置：")
    click.echo(f"  服务器  : {cfg['server_url']}")
    click.echo(f"  节点名  : {cfg['name']}")
    click.echo(f"  模型    : {', '.join(cfg['models'])}")
    click.echo(f"  LLM URL : {cfg['llm_base_url']}")
    click.echo(f"  LLM Token: {'已设置' if cfg.get('llm_token') else '未设置'}")
    wk = (cfg.get("worker_key") or "").strip()
    click.echo(f"  Worker Key: {wk[:12] + '…' if len(wk) > 12 else (wk or '(missing)')}")
    click.echo(f"  转发日志: {'开启' if cfg.get('forward_log') else '关闭'}")


@cli.command()
@click.option("--forward-log/--no-forward-log", default=None, help="是否打印转发日志（覆盖配置文件；默认按配置 forward_log）")
@click.option("--config", default=str(CONFIG_PATH), help="配置文件路径")
def start(config, forward_log):
    """启动 Agent"""
    cfg = load_config(Path(config))
    if forward_log is not None:
        cfg["forward_log"] = forward_log
    wk = (cfg.get("worker_key") or "").strip()
    if not wk:
        click.echo(
            "[agent] worker_key missing in config; run: llm-agent register --worker-key <wk-...>",
            err=True,
        )
        sys.exit(1)
    cfg["worker_key"] = wk
    click.echo(f"启动 LLM Agent: {cfg['name']}")
    click.echo(f"连接服务器: {cfg['server_url']}")
    click.echo(f"模型: {', '.join(cfg['models'])}")
    if cfg.get("forward_log"):
        click.echo("转发日志: 开启（每条请求会打印 begin/end 或错误）")
    click.echo("按 Ctrl+C 停止\n")
    try:
        asyncio.run(run_agent(cfg))
    except KeyboardInterrupt:
        click.echo("\n[agent] stopped")


# ── Request handling ─────────────────────────────────────────────────────────

def _is_anthropic_base(llm_base_url: str) -> bool:
    """与 Debug / agent-worker 一致，用于识别 Claude 官方 API。"""
    lower = (llm_base_url or "").lower()
    return "anthropic" in lower


def _chat_completions_url(cfg: dict) -> str:
    """OpenAI 兼容 chat 完整 URL（与 Electron agent-worker 规则一致）。"""
    base_raw = (cfg.get("llm_base_url") or "").strip().rstrip("/")
    if not base_raw:
        raise ValueError("llm_base_url missing")
    explicit = (cfg.get("llm_chat_path") or "").strip().lstrip("/")
    if explicit:
        rel = explicit
    else:
        lower = base_raw.lower()
        if (
            re.search(r"/v\d+(/|$)", base_raw)
            or "compatible-mode" in lower
            or "bigmodel.cn" in lower
            or "volces.com/api" in lower
            or "qianfan.baidubce.com" in lower
            or ("generativelanguage.googleapis.com" in lower and "openai" in lower)
        ):
            rel = "chat/completions"
        else:
            rel = "v1/chat/completions"
    return str(URL(base_raw + "/").join(rel))


async def _forward_streaming(req_id: str, payload: dict, send_q: asyncio.Queue, cfg: dict):
    if _is_anthropic_base(cfg.get("llm_base_url", "")):
        err = (
            "命令行 llm-agent 暂不支持直连 Anthropic API；请改用 OpenAI 兼容中转，"
            "或使用 Token Bank 桌面端内置 Agent（已支持 Claude）。"
        )
        log_forward(cfg, f"[agent] anthropic not supported in CLI req_id={req_id}")
        await send_q.put(json.dumps({"type": "error", "req_id": req_id, "error": err}))
        return
    headers = {"Content-Type": "application/json"}
    if cfg.get("llm_token"):
        headers["Authorization"] = f"Bearer {cfg['llm_token']}"

    chunk_lines = 0
    try:
        url = _chat_completions_url(cfg)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10, read=120, write=30, pool=5),
        ) as client:
            async with client.stream(
                "POST", url, json=payload, headers=headers
            ) as resp:
                resp.raise_for_status()
                log_forward(cfg, f"[agent] forward stream http_status={resp.status_code} req_id={req_id}")
                last_usage = None
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    if line == "data: [DONE]":
                        break
                    chunk_lines += 1
                    # 尝试提取 usage（OpenAI 在最后一个 chunk 里携带）
                    if line.startswith("data: "):
                        try:
                            chunk_data = json.loads(line[6:])
                            if chunk_data.get("usage"):
                                last_usage = chunk_data["usage"]
                        except Exception:
                            pass
                    await send_q.put(json.dumps({
                        "type": "chunk",
                        "req_id": req_id,
                        "data": line + "\n\n",
                    }))
        log_forward(cfg, f"[agent] forward stream done req_id={req_id} sse_lines={chunk_lines}")
        await send_q.put(json.dumps({"type": "done", "req_id": req_id, "usage": last_usage}))
    except Exception as e:
        log_forward(cfg, f"[agent] forward stream error req_id={req_id} detail={e!r}")
        await send_q.put(json.dumps({"type": "error", "req_id": req_id, "error": str(e)}))


async def _forward_non_streaming(req_id: str, payload: dict, send_q: asyncio.Queue, cfg: dict):
    if _is_anthropic_base(cfg.get("llm_base_url", "")):
        err = (
            "命令行 llm-agent 暂不支持直连 Anthropic API；请改用 OpenAI 兼容中转，"
            "或使用 Token Bank 桌面端内置 Agent（已支持 Claude）。"
        )
        await send_q.put(json.dumps({"type": "error", "req_id": req_id, "error": err}))
        return
    headers = {"Content-Type": "application/json"}
    if cfg.get("llm_token"):
        headers["Authorization"] = f"Bearer {cfg['llm_token']}"

    try:
        url = _chat_completions_url(cfg)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10, read=120, write=30, pool=5),
        ) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            body = resp.text
            log_forward(
                cfg,
                f"[agent] forward json http_status={resp.status_code} req_id={req_id} bytes={len(body)}",
            )
            usage = None
            try:
                usage = resp.json().get("usage")
            except Exception:
                pass
            await send_q.put(json.dumps({
                "type": "chunk",
                "req_id": req_id,
                "data": body,
            }))
            await send_q.put(json.dumps({"type": "done", "req_id": req_id, "usage": usage}))
    except Exception as e:
        log_forward(cfg, f"[agent] forward json error req_id={req_id} detail={e!r}")
        await send_q.put(json.dumps({"type": "error", "req_id": req_id, "error": str(e)}))


async def handle_request(req_id: str, payload: dict, send_q: asyncio.Queue, cfg: dict):
    log_forward(
        cfg,
        "[agent] forward begin "
        f"req_id={req_id} model={payload.get('model', '')!r} stream={payload.get('stream', False)}",
    )
    if payload.get("stream", False):
        await _forward_streaming(req_id, payload, send_q, cfg)
    else:
        await _forward_non_streaming(req_id, payload, send_q, cfg)


# ── WebSocket session ────────────────────────────────────────────────────────

async def run_session(cfg: dict) -> None:
    send_q: asyncio.Queue = asyncio.Queue()

    async with websockets.connect(
        cfg["server_url"],
        ping_interval=30,
        ping_timeout=10,
    ) as ws:
        # Register: worker_key is the sole credential (matches DB users.worker_key)
        await ws.send(json.dumps({
            "type":       "register",
            "name":       cfg["name"],
            "models":     cfg["models"],
            "worker_key": cfg["worker_key"],
        }))

        # Server closes with 4001 if worker_key missing or unknown — recv raises ConnectionClosed
        try:
            raw = await ws.recv()
        except ConnectionClosed as e:
            raise RuntimeError(
                f"[agent] register aborted: server closed the socket before sending "
                f"'registered' ({explain_ws_close(e)})"
            ) from e

        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")

        try:
            resp = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"[agent] register failed: response is not JSON (first 200 chars)={raw[:200]!r} "
                f"| parse_error={e}"
            ) from e

        if resp.get("type") != "registered":
            raise RuntimeError(
                f"[agent] register failed: expected type='registered', "
                f"got type={resp.get('type')!r} full_response={resp!r}"
            )

        click.echo(f"[agent] connected worker_id={resp['worker_id']}")

        # Dedicated sender — serialises all WebSocket writes
        async def _sender():
            while True:
                msg = await send_q.get()
                if msg is None:
                    return
                await ws.send(msg)

        sender_task = asyncio.create_task(_sender())

        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg.get("type") == "request":
                    asyncio.create_task(
                        handle_request(msg["req_id"], msg["payload"], send_q, cfg)
                    )
        finally:
            await send_q.put(None)
            sender_task.cancel()
            click.echo("[agent] disconnected from proxy WebSocket")


# ── Reconnect loop ───────────────────────────────────────────────────────────

async def run_agent(cfg: dict) -> None:
    while True:
        try:
            await run_session(cfg)
        except InvalidStatus as e:
            sc = getattr(e.response, "status_code", None)
            if sc == 404:
                click.echo(
                    "[agent] websocket handshake failed: HTTP 404 — no route /ws/worker on server. "
                    "Redeploy from this repo (docker compose up -d --build) or fix reverse-proxy path.",
                    err=True,
                )
            else:
                click.echo(
                    f"[agent] websocket handshake failed: HTTP {sc} "
                    f"(expected 101 Switching Protocols). "
                    f"Check URL scheme ws/wss, path ends with /ws/worker, "
                    f"and proxy WebSocket upgrade headers. detail={e!r}",
                    err=True,
                )
        except ConnectionClosed as e:
            click.echo(f"[agent] websocket closed: {explain_ws_close(e)}", err=True)
        except WebSocketException as e:
            click.echo(f"[agent] websocket error: {e!r}", err=True)
        except OSError as e:
            click.echo(
                f"[agent] network error (DNS/connect/refused): {e!r}",
                err=True,
            )
        except Exception as e:
            click.echo(f"[agent] session error: {e!r}", err=True)

        click.echo(f"[agent] reconnecting in {RECONNECT_DELAY}s...")
        await asyncio.sleep(RECONNECT_DELAY)


if __name__ == "__main__":
    cli()

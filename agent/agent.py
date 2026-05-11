#!/usr/bin/env python3
"""LLM Agent — 将本地内网 LLM 接入远程代理服务"""

import asyncio
import json
import socket
import sys
from pathlib import Path

import click
import httpx
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

CONFIG_PATH = Path.home() / ".llm-agent" / "config.json"
RECONNECT_DELAY = 5


# ── Config ──────────────────────────────────────────────────────────────────

def load_config(path: Path) -> dict:
    if not path.exists():
        click.echo(f"[error] 配置文件不存在: {path}", err=True)
        click.echo("请先运行 llm-agent register ...", err=True)
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
@click.option("--token",     required=True, help="Worker Token（由管理员提供）")
@click.option("--models",    required=True, help="支持的模型，逗号分隔，如 qwen3-32b,qwen3-7b")
@click.option("--llm-url",   required=True, help="内网 LLM base URL，如 http://localhost:11434")
@click.option("--llm-token",   default="",    help="内网 LLM 的 API Token（可选）")
@click.option("--name",        default="",    help="节点名称（默认使用主机名）")
@click.option("--worker-key",  default="",    help="用户 Worker Key（登录用户中心后获取，用于积分归属）")
@click.option("--forward-log", is_flag=True, default=False, help="在配置中启用转发日志（也可用 start --forward-log 临时开启）")
@click.option("--config",      default=str(CONFIG_PATH), help="配置文件保存路径")
def register(server, token, models, llm_url, llm_token, name, worker_key, forward_log, config):
    """注册并保存 Agent 配置"""
    cfg = {
        "server_url":   server,
        "worker_token": token,
        "name":         name.strip() or socket.gethostname(),
        "worker_key":   worker_key,
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
    click.echo(f"  转发日志: {'开启' if cfg.get('forward_log') else '关闭'}")


@cli.command()
@click.option("--forward-log/--no-forward-log", default=None, help="是否打印转发日志（覆盖配置文件；默认按配置 forward_log）")
@click.option("--config", default=str(CONFIG_PATH), help="配置文件路径")
def start(config, forward_log):
    """启动 Agent"""
    cfg = load_config(Path(config))
    if forward_log is not None:
        cfg["forward_log"] = forward_log
    click.echo(f"启动 LLM Agent: {cfg['name']}")
    click.echo(f"连接服务器: {cfg['server_url']}")
    click.echo(f"模型: {', '.join(cfg['models'])}")
    if cfg.get("forward_log"):
        click.echo("转发日志: 开启（每条请求会打印 begin/end 或错误）")
    click.echo("按 Ctrl+C 停止\n")
    try:
        asyncio.run(run_agent(cfg))
    except KeyboardInterrupt:
        click.echo("\n已停止")


# ── Request handling ─────────────────────────────────────────────────────────

async def _forward_streaming(req_id: str, payload: dict, send_q: asyncio.Queue, cfg: dict):
    headers = {"Content-Type": "application/json"}
    if cfg.get("llm_token"):
        headers["Authorization"] = f"Bearer {cfg['llm_token']}"

    chunk_lines = 0
    try:
        async with httpx.AsyncClient(
            base_url=cfg["llm_base_url"],
            timeout=httpx.Timeout(connect=10, read=120, write=30, pool=5),
        ) as client:
            async with client.stream(
                "POST", "/v1/chat/completions", json=payload, headers=headers
            ) as resp:
                resp.raise_for_status()
                log_forward(cfg, f"[forward] stream http_status={resp.status_code} req_id={req_id}")
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
        log_forward(cfg, f"[forward] stream done req_id={req_id} sse_lines={chunk_lines}")
        await send_q.put(json.dumps({"type": "done", "req_id": req_id, "usage": last_usage}))
    except Exception as e:
        log_forward(cfg, f"[forward] stream error req_id={req_id} {e!r}")
        await send_q.put(json.dumps({"type": "error", "req_id": req_id, "error": str(e)}))


async def _forward_non_streaming(req_id: str, payload: dict, send_q: asyncio.Queue, cfg: dict):
    headers = {"Content-Type": "application/json"}
    if cfg.get("llm_token"):
        headers["Authorization"] = f"Bearer {cfg['llm_token']}"

    try:
        async with httpx.AsyncClient(
            base_url=cfg["llm_base_url"],
            timeout=httpx.Timeout(connect=10, read=120, write=30, pool=5),
        ) as client:
            resp = await client.post("/v1/chat/completions", json=payload, headers=headers)
            resp.raise_for_status()
            body = resp.text
            log_forward(
                cfg,
                f"[forward] json http_status={resp.status_code} req_id={req_id} bytes={len(body)}",
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
        log_forward(cfg, f"[forward] json error req_id={req_id} {e!r}")
        await send_q.put(json.dumps({"type": "error", "req_id": req_id, "error": str(e)}))


async def handle_request(req_id: str, payload: dict, send_q: asyncio.Queue, cfg: dict):
    log_forward(
        cfg,
        "[forward] begin "
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
        # Register（携带 worker_key 用于积分归属）
        await ws.send(json.dumps({
            "type":       "register",
            "token":      cfg["worker_token"],
            "name":       cfg["name"],
            "models":     cfg["models"],
            "worker_key": cfg.get("worker_key", ""),
        }))

        resp = json.loads(await ws.recv())
        if resp.get("type") != "registered":
            raise RuntimeError(f"注册失败: {resp}")

        click.echo(f"[connected] worker_id={resp['worker_id']}")

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
            click.echo("[disconnected]")


# ── Reconnect loop ───────────────────────────────────────────────────────────

async def run_agent(cfg: dict) -> None:
    while True:
        try:
            await run_session(cfg)
        except InvalidStatus as e:
            # 404：服务端进程未挂载 /ws/worker（常见为 VPS 镜像未随仓库更新）
            if getattr(e.response, "status_code", None) == 404:
                click.echo(
                    "[ws] HTTP 404：服务端未提供 WebSocket 路径 /ws/worker。"
                    "请在 VPS 进入本仓库目录执行 docker compose up -d --build（或更新代码后重启 uvicorn），"
                    "确保运行的是包含 @app.websocket(\"/ws/worker\") 的 server.py。",
                    err=True,
                )
            else:
                click.echo(f"[ws] {e}", err=True)
        except (ConnectionClosed, WebSocketException) as e:
            click.echo(f"[ws] {e}", err=True)
        except OSError as e:
            click.echo(f"[net] {e}", err=True)
        except Exception as e:
            click.echo(f"[error] {e}", err=True)

        click.echo(f"{RECONNECT_DELAY}s 后重连...")
        await asyncio.sleep(RECONNECT_DELAY)


if __name__ == "__main__":
    cli()

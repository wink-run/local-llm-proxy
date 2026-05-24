"""板块① Path B —— 一键写入器（M2）。

把本地网关（默认 http://127.0.0.1:11435）作为后端，写入到 8 个常用工具的配置文件。

设计文档：DESIGN_v2.md §1.4 Path B

核心机制（与 cc-switch 同等保障级别）：
  1. atomic write —— 先写 *.tmp 再 rename，避免半写状态
  2. backup —— 写入前把原文件复制到 ~/.local-llm-proxy/backups/{tool}-{ISO8601}.{ext}
                自动轮转保留最近 10 份
  3. backfill —— 读现有配置 → 只覆盖固定字段（base_url / api_key / model envs）
                 其它字段原样保留（用户手改的 MCP、theme 等）

支持的工具：
  - claude_code   ~/.claude/settings.local.json        env-style JSON
  - codex         ~/.codex/config.toml                  TOML
  - cursor        ~/.cursor/User/settings.json          flat JSON
  - continue_     ~/.continue/config.yaml               YAML
  - aider         ~/.aider.conf.yml                     YAML
  - cline         VS Code settings.json (per-OS)        flat JSON
  - opencode      ~/.opencode/config.json               nested JSON
  - gemini_cli    ~/.gemini/settings.json               flat JSON
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import yaml
import tomlkit

# ── 路径 ────────────────────────────────────────────────────────────────────

HOME = Path.home()
LLP_HOME = HOME / ".local-llm-proxy"
BACKUP_DIR = LLP_HOME / "backups"
BACKUP_KEEP = 10


def _vscode_settings_path() -> Path:
    """VS Code 用户级 settings.json（Cline 写这里）。

    Win:   %APPDATA%\\Code\\User\\settings.json
    macOS: ~/Library/Application Support/Code/User/settings.json
    Linux: ~/.config/Code/User/settings.json
    """
    if sys.platform == "win32":
        appdata = os.getenv("APPDATA") or str(HOME / "AppData/Roaming")
        return Path(appdata) / "Code" / "User" / "settings.json"
    if sys.platform == "darwin":
        return HOME / "Library/Application Support/Code/User/settings.json"
    return HOME / ".config/Code/User/settings.json"


# ── Schema ──────────────────────────────────────────────────────────────────


@dataclass
class AppSchema:
    """每个工具的写入策略。"""
    app_name: str
    display: str
    path: Path
    fmt: str                         # "json" | "yaml" | "toml"
    apply: Callable[[dict, dict], dict]  # 接收 (旧配置, ctx) → 新配置
    needs_env_var: bool = False      # True 表示 file 写完后还需要 shell 环境变量
    env_var_hint: str = ""           # 给用户看的 export 提示


def _apply_claude_code(cfg: dict, ctx: dict) -> dict:
    """Claude Code 写 env 块。"""
    cfg.setdefault("env", {})
    cfg["env"]["ANTHROPIC_BASE_URL"] = ctx["base_url"]
    cfg["env"]["ANTHROPIC_AUTH_TOKEN"] = ctx["api_key"]
    if ctx.get("preferred_model"):
        m = ctx["preferred_model"]
        cfg["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = m
        cfg["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"] = m
        cfg["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"] = m
    return cfg


def _apply_codex(cfg: dict, ctx: dict) -> dict:
    """Codex 写 [model_providers.local-llm-proxy]。

    Codex 要求从 env 读 key，所以我们设 env_key 指向一个固定名；用户需 export。
    """
    providers = cfg.setdefault("model_providers", {})
    providers["local-llm-proxy"] = {
        "name": "Local LLM Proxy",
        "base_url": ctx["base_url"],
        "env_key": "LOCAL_LLM_PROXY_API_KEY",
        "wire_api": "chat",
    }
    if ctx.get("preferred_model"):
        cfg.setdefault("model", ctx["preferred_model"])
        cfg.setdefault("model_provider", "local-llm-proxy")
    return cfg


def _apply_cursor(cfg: dict, ctx: dict) -> dict:
    """Cursor settings.json：写 OpenAI-style 字段。"""
    cfg["cursor.openaiApiKey"] = ctx["api_key"]
    cfg["cursor.openaiBaseUrl"] = ctx["base_url"]
    if ctx.get("preferred_model"):
        cfg["cursor.openaiModel"] = ctx["preferred_model"]
    return cfg


def _apply_continue(cfg: dict, ctx: dict) -> dict:
    """Continue config.yaml：上游 models[] 数组里替换/新增 local-llm-proxy。"""
    models = cfg.setdefault("models", [])
    entry = {
        "title": "Local LLM Proxy",
        "provider": "openai",
        "model": ctx.get("preferred_model") or "auto",
        "apiBase": ctx["base_url"],
        "apiKey": ctx["api_key"],
    }
    # 按 title 去重
    for i, m in enumerate(models):
        if isinstance(m, dict) and m.get("title") == entry["title"]:
            models[i] = entry
            break
    else:
        models.append(entry)
    return cfg


def _apply_aider(cfg: dict, ctx: dict) -> dict:
    """Aider .aider.conf.yml：openai-api-base / openai-api-key。"""
    cfg["openai-api-base"] = ctx["base_url"]
    cfg["openai-api-key"] = ctx["api_key"]
    if ctx.get("preferred_model"):
        cfg["model"] = "openai/" + ctx["preferred_model"]
    return cfg


def _apply_cline(cfg: dict, ctx: dict) -> dict:
    """Cline 通过 VS Code settings.json 配置。"""
    cfg["cline.apiProvider"] = "openai"
    cfg["cline.openAiBaseUrl"] = ctx["base_url"]
    cfg["cline.openAiApiKey"] = ctx["api_key"]
    if ctx.get("preferred_model"):
        cfg["cline.openAiModelId"] = ctx["preferred_model"]
    return cfg


def _apply_opencode(cfg: dict, ctx: dict) -> dict:
    """OpenCode nested provider.openai。"""
    provider = cfg.setdefault("provider", {})
    provider["openai"] = {
        "baseURL": ctx["base_url"],
        "apiKey": ctx["api_key"],
    }
    if ctx.get("preferred_model"):
        cfg["model"] = ctx["preferred_model"]
    return cfg


def _apply_gemini_cli(cfg: dict, ctx: dict) -> dict:
    """Gemini CLI settings.json：auth 块（兼容 OpenAI 端点写法）。"""
    auth = cfg.setdefault("auth", {})
    auth["baseUrl"] = ctx["base_url"]
    auth["apiKey"] = ctx["api_key"]
    if ctx.get("preferred_model"):
        cfg["model"] = ctx["preferred_model"]
    return cfg


SCHEMAS: dict[str, AppSchema] = {
    "claude_code": AppSchema(
        app_name="claude_code",
        display="Claude Code",
        path=HOME / ".claude" / "settings.local.json",
        fmt="json",
        apply=_apply_claude_code,
    ),
    "codex": AppSchema(
        app_name="codex",
        display="Codex CLI",
        path=HOME / ".codex" / "config.toml",
        fmt="toml",
        apply=_apply_codex,
        needs_env_var=True,
        env_var_hint="export LOCAL_LLM_PROXY_API_KEY=<gateway_key>",
    ),
    "cursor": AppSchema(
        app_name="cursor",
        display="Cursor",
        path=(Path(os.getenv("APPDATA") or str(HOME / "AppData/Roaming")) / "Cursor/User/settings.json")
        if sys.platform == "win32"
        else (
            HOME / "Library/Application Support/Cursor/User/settings.json"
            if sys.platform == "darwin"
            else HOME / ".config/Cursor/User/settings.json"
        ),
        fmt="json",
        apply=_apply_cursor,
    ),
    "continue_": AppSchema(
        app_name="continue_",
        display="Continue (VS Code)",
        path=HOME / ".continue" / "config.yaml",
        fmt="yaml",
        apply=_apply_continue,
    ),
    "aider": AppSchema(
        app_name="aider",
        display="Aider",
        path=HOME / ".aider.conf.yml",
        fmt="yaml",
        apply=_apply_aider,
    ),
    "cline": AppSchema(
        app_name="cline",
        display="Cline (VS Code)",
        path=_vscode_settings_path(),
        fmt="json",
        apply=_apply_cline,
    ),
    "opencode": AppSchema(
        app_name="opencode",
        display="OpenCode",
        path=HOME / ".opencode" / "config.json",
        fmt="json",
        apply=_apply_opencode,
    ),
    "gemini_cli": AppSchema(
        app_name="gemini_cli",
        display="Gemini CLI",
        path=HOME / ".gemini" / "settings.json",
        fmt="json",
        apply=_apply_gemini_cli,
    ),
}


# ── 序列化 ──────────────────────────────────────────────────────────────────


def _read_existing(path: Path, fmt: str) -> dict:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {}
    try:
        if fmt == "json":
            return json.loads(text)
        if fmt == "yaml":
            return yaml.safe_load(text) or {}
        if fmt == "toml":
            return dict(tomlkit.parse(text))
    except (json.JSONDecodeError, yaml.YAMLError, Exception) as e:
        # 损坏的配置：不要静默清空。抛错让上层提示用户手动修复或先备份恢复。
        raise ValueError(f"Existing config at {path} is corrupt ({type(e).__name__}: {e})") from e
    return {}


def _serialize(cfg: dict, fmt: str) -> str:
    if fmt == "json":
        return json.dumps(cfg, indent=2, ensure_ascii=False) + "\n"
    if fmt == "yaml":
        return yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False) or ""
    if fmt == "toml":
        return tomlkit.dumps(cfg)
    raise ValueError(f"Unknown format: {fmt}")


# ── 备份 ────────────────────────────────────────────────────────────────────


def _make_backup(path: Path) -> Optional[Path]:
    if not path.exists():
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%dT%H%M%S")
    suffix = path.suffix or ".bak"
    name = f"{path.stem}-{ts}{suffix}"
    bk = BACKUP_DIR / name
    shutil.copy2(path, bk)
    _rotate_backups(stem=path.stem, suffix=suffix)
    return bk


def _rotate_backups(stem: str, suffix: str) -> None:
    """同前缀 backup 只保留最近 BACKUP_KEEP 份。"""
    if not BACKUP_DIR.exists():
        return
    candidates = sorted(
        BACKUP_DIR.glob(f"{stem}-*{suffix}"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in candidates[BACKUP_KEEP:]:
        try:
            old.unlink()
        except OSError:
            pass


# ── Atomic write ────────────────────────────────────────────────────────────


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        # Windows 上 os.replace 跨 rename 是原子的（同卷）
        os.replace(tmp_name, str(path))
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


# ── 对外 API ────────────────────────────────────────────────────────────────


@dataclass
class WriteResult:
    ok: bool
    app_name: str
    display: str
    path: str
    backup_path: Optional[str]
    needs_env_var: bool
    env_var_hint: str
    error: Optional[str] = None


def preview(app_name: str, ctx: dict) -> dict:
    """返回 {before, after, diff_keys} 三段，不落盘。"""
    schema = SCHEMAS.get(app_name)
    if not schema:
        raise KeyError(f"Unknown app: {app_name}")
    before = _read_existing(schema.path, schema.fmt)
    # 深拷贝以免 apply 改 before
    after = schema.apply(json.loads(json.dumps(before)), ctx)
    diff_keys = _diff_top_level(before, after)
    return {
        "app_name": schema.app_name,
        "display": schema.display,
        "path": str(schema.path),
        "fmt": schema.fmt,
        "exists": schema.path.exists(),
        "before": before,
        "after": after,
        "diff_keys": diff_keys,
        "needs_env_var": schema.needs_env_var,
        "env_var_hint": schema.env_var_hint,
    }


def write(app_name: str, ctx: dict) -> WriteResult:
    schema = SCHEMAS.get(app_name)
    if not schema:
        return WriteResult(
            ok=False, app_name=app_name, display="", path="",
            backup_path=None, needs_env_var=False, env_var_hint="",
            error=f"Unknown app: {app_name}",
        )
    try:
        before = _read_existing(schema.path, schema.fmt)
        after = schema.apply(json.loads(json.dumps(before)), ctx)
        backup_path = _make_backup(schema.path)
        _atomic_write(schema.path, _serialize(after, schema.fmt))
        return WriteResult(
            ok=True,
            app_name=schema.app_name,
            display=schema.display,
            path=str(schema.path),
            backup_path=str(backup_path) if backup_path else None,
            needs_env_var=schema.needs_env_var,
            env_var_hint=schema.env_var_hint.replace(
                "<gateway_key>", ctx.get("api_key", "")
            ),
        )
    except Exception as e:
        return WriteResult(
            ok=False, app_name=schema.app_name, display=schema.display,
            path=str(schema.path), backup_path=None,
            needs_env_var=schema.needs_env_var, env_var_hint=schema.env_var_hint,
            error=f"{type(e).__name__}: {e}",
        )


def list_schemas() -> list[dict]:
    """给 UI 列出所有支持的 app + 当前 file 是否存在。"""
    out = []
    for s in SCHEMAS.values():
        out.append({
            "app_name": s.app_name,
            "display": s.display,
            "path": str(s.path),
            "fmt": s.fmt,
            "exists": s.path.exists(),
            "needs_env_var": s.needs_env_var,
            "env_var_hint": s.env_var_hint,
        })
    return out


def _diff_top_level(a: dict, b: dict) -> list[str]:
    """简易顶层 diff：返回 b 新增/改变的顶层 key 列表。"""
    out = []
    for k, v in b.items():
        if a.get(k) != v:
            out.append(k)
    return out

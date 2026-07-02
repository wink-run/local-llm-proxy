# 公开页「贡献 Token」展示：每结算周期确定性随机基数 + 真实消耗（全员一致）
from __future__ import annotations

import hashlib
from typing import Iterable

from settler import INTERVAL

# 与 settler 周期对齐（默认 5 分钟）
PERIOD_SECONDS = INTERVAL

BASE_MIN = 300_000_000
BASE_MAX = 500_000_000
BASE_SPAN = BASE_MAX - BASE_MIN + 1


def current_period_id(now: float | None = None) -> int:
    import time
    t = time.time() if now is None else now
    return int(t) // PERIOD_SECONDS


def period_base_tokens(period_id: int) -> int:
    """周期内全网随机基数 300M–500M（同一 period_id 所有用户一致）。"""
    digest = hashlib.md5(f"contrib-base:{period_id}".encode()).hexdigest()
    n = int(digest[:8], 16)
    return BASE_MIN + (n % BASE_SPAN)


def split_base_among_virtual(worker_ids: Iterable[str], period_id: int, base: int) -> dict[str, int]:
    """将周期基数按权重拆到各虚拟 Agent（vw-*），同一 period 结果稳定。"""
    ids = [wid for wid in worker_ids if wid]
    if not ids or base <= 0:
        return {}

    weighted: list[tuple[str, int]] = []
    for wid in ids:
        digest = hashlib.md5(f"contrib-split:{period_id}:{wid}".encode()).hexdigest()
        w = (int(digest[:8], 16) % 1000) + 1
        weighted.append((wid, w))

    total_w = sum(w for _, w in weighted)
    out: dict[str, int] = {}
    allocated = 0
    for i, (wid, w) in enumerate(weighted):
        if i == len(weighted) - 1:
            share = base - allocated
        else:
            share = int(base * w / total_w)
            allocated += share
        out[wid] = max(0, share)
    return out


def apply_contrib_display(worker_rows: list[dict]) -> tuple[list[dict], dict]:
    """
    为公开 network API 叠加展示用量：
    - 虚拟 Agent：周期随机份额 + 本周期真实 output_tokens
    - 真实 Worker：仅真实 output_tokens
    - summary.contrib_tokens = 周期基数 + 全网真实消耗
    """
    period_id = current_period_id()
    base = period_base_tokens(period_id)
    virtual_ids = [r["worker_id"] for r in worker_rows if str(r.get("worker_id", "")).startswith("vw-")]
    splits = split_base_among_virtual(virtual_ids, period_id, base)

    total_real = 0
    for row in worker_rows:
        real = int(row.get("period_tokens") or 0)
        total_real += real
        syn = splits.get(row["worker_id"], 0)
        if syn:
            row["period_tokens"] = syn + real

    return worker_rows, {
        "contrib_tokens": base + total_real,
        "contrib_base": base,
        "contrib_real": total_real,
        "contrib_period": period_id,
    }

import asyncio
import json
import random
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class WorkerConnection:
    ws: object
    models: list
    worker_id: str
    name: str
    user_id: Optional[int] = None
    connected_at: datetime = field(default_factory=datetime.now)
    active_requests: int = 0
    # req_id -> {queue, model, dispatch_time}
    pending: dict = field(default_factory=dict)
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # 5 分钟周期统计
    period_start: float = field(default_factory=time.time)
    # {model: {output_tokens, requests, success, ttft_sum, ttft_count}}
    period_stats: dict = field(default_factory=dict)

    async def send(self, data: dict) -> None:
        async with self._send_lock:
            await self.ws.send_text(json.dumps(data))

    def record_complete(self, model: str, output_tokens: int, success: bool, ttft_ms: float | None) -> None:
        """success 且 ttft_ms 有效时累加首 Token 延迟（用于周期内平均 TTFT）。"""
        s = self.period_stats.setdefault(
            model,
            {"output_tokens": 0, "requests": 0, "success": 0, "ttft_sum": 0.0, "ttft_count": 0},
        )
        s["output_tokens"] += output_tokens
        s["requests"] += 1
        if success:
            s["success"] += 1
        if success and ttft_ms is not None and ttft_ms >= 0:
            s["ttft_sum"] += ttft_ms
            s["ttft_count"] += 1

    def take_period(self) -> dict:
        """取走当前周期数据并重置，返回快照"""
        snapshot = dict(self.period_stats)
        self.period_stats = {}
        self.period_start = time.time()
        return snapshot

    def period_online_mins(self) -> float:
        return (time.time() - self.period_start) / 60

    def to_dict(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "name": self.name,
            "models": self.models,
            "connected_at": self.connected_at.isoformat(),
            "active_requests": self.active_requests,
            "user_id": self.user_id,
        }


class WorkerPool:
    def __init__(self):
        self._workers: list[WorkerConnection] = []

    def add(self, worker: WorkerConnection) -> None:
        self._workers.append(worker)

    def remove(self, worker: WorkerConnection) -> None:
        try:
            self._workers.remove(worker)
        except ValueError:
            pass

    def pick(self, model: str) -> Optional[WorkerConnection]:
        available = [w for w in self._workers if model in w.models]
        return random.choice(available) if available else None

    def all_models(self) -> list[str]:
        return sorted({m for w in self._workers for m in w.models})

    def list_workers(self) -> list[dict]:
        return [w.to_dict() for w in self._workers]

    def all_workers(self) -> list[WorkerConnection]:
        return list(self._workers)


pool = WorkerPool()

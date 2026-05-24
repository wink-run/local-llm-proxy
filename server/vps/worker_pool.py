import asyncio
import json
import random
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, TYPE_CHECKING
if TYPE_CHECKING:
    from virtual_worker import VirtualWorkerConnection


@dataclass
class WorkerConnection:
    ws: object
    models: list
    worker_id: str
    name: str
    model_types: dict = field(default_factory=dict)
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

    def record_image_complete(self, model: str, image_count: int) -> None:
        """Record completed image generation for settler contribution tracking."""
        s = self.period_stats.setdefault(
            model,
            {"output_tokens": 0, "requests": 0, "success": 0,
             "ttft_sum": 0.0, "ttft_count": 0, "image_count": 0},
        )
        s["requests"] += 1
        s["success"] += 1
        s["image_count"] = s.get("image_count", 0) + image_count

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
            "model_types": self.model_types,
            "connected_at": self.connected_at.isoformat(),
            "active_requests": self.active_requests,
            "user_id": self.user_id,
        }


class WorkerPool:
    def __init__(self):
        self._workers: list[WorkerConnection] = []
        self._virtual: list = []   # list[VirtualWorkerConnection]

    def add(self, worker: WorkerConnection) -> None:
        self._workers.append(worker)

    def remove(self, worker: WorkerConnection) -> None:
        try:
            self._workers.remove(worker)
        except ValueError:
            pass

    def sync_virtual(self, agents: list[dict]) -> None:
        """从数据库 agent 列表重建虚拟 Worker 列表，立即生效。"""
        from virtual_worker import VirtualWorkerConnection
        self._virtual = []
        for a in agents:
            if not a.get("enabled"):
                continue
            names, model_types = [], {}
            for m in a.get("models", []):
                if isinstance(m, str):
                    names.append(m)
                    model_types[m] = "chat"
                else:
                    n = m.get("name", "")
                    if n:
                        names.append(n)
                        model_types[n] = m.get("type", "chat")
            self._virtual.append(VirtualWorkerConnection(
                base_url=a["base_url"],
                api_key=a["api_key"],
                api_style=a["api_style"],
                models=names,
                model_types=model_types,
                worker_id=f"vw-{a['id']}",
                name=a["name"],
                user_id=a.get("user_id"),
            ))

    def pick(self, model: str, model_type: Optional[str] = None) -> Optional[WorkerConnection]:
        """Real workers first; fall back to virtual.
        If model_type is given, only workers whose declared type matches are considered.
        If None (default), any worker carrying the model is eligible."""
        def _matches(w) -> bool:
            return model in w.models and (
                model_type is None or w.model_types.get(model, "chat") == model_type
            )
        real = [w for w in self._workers if _matches(w)]
        if real:
            return random.choice(real)
        virtual = [v for v in self._virtual if _matches(v)]
        return random.choice(virtual) if virtual else None

    def all_models(self) -> list[str]:
        return sorted({m for w in self._workers + self._virtual for m in w.models})

    def all_model_types(self) -> dict[str, str]:
        """Returns {model_name: model_type} for all online models. Last writer wins."""
        result: dict[str, str] = {}
        for w in self._workers + self._virtual:
            for m in w.models:
                result[m] = w.model_types.get(m, "chat")
        return result

    def list_workers(self) -> list[dict]:
        return [w.to_dict() for w in self._workers + self._virtual]

    def all_workers(self) -> list:
        return list(self._workers + self._virtual)


pool = WorkerPool()

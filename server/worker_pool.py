import asyncio
import json
import random
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class WorkerConnection:
    ws: object
    models: list
    worker_id: str
    name: str
    connected_at: datetime = field(default_factory=datetime.now)
    active_requests: int = 0
    pending: dict = field(default_factory=dict)
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, data: dict) -> None:
        async with self._send_lock:
            await self.ws.send_text(json.dumps(data))

    def to_dict(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "name": self.name,
            "models": self.models,
            "connected_at": self.connected_at.isoformat(),
            "active_requests": self.active_requests,
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


pool = WorkerPool()

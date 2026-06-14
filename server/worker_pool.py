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
    _STICKY_TTL = 3600   # 粘性会话有效期（秒）

    def __init__(self):
        self._workers: list[WorkerConnection] = []
        self._virtual: list = []   # list[VirtualWorkerConnection]
        # 粘性会话：session_key -> (worker_id, expires_at)
        self._sticky: dict[str, tuple[str, float]] = {}

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
                credentials=a.get("credentials") or {},
                agent_id=a.get("id"),
                owner_user_id=a.get("owner_user_id"),
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

    def _sticky_lookup(self, session_key: str) -> Optional[str]:
        """返回粘性会话绑定且未过期的 worker_id，否则 None。"""
        item = self._sticky.get(session_key)
        if not item:
            return None
        worker_id, expires_at = item
        if time.time() > expires_at:
            self._sticky.pop(session_key, None)
            return None
        return worker_id

    def bind_sticky(self, session_key: str, worker_id: str) -> None:
        """把会话绑定到某账号，后续同会话优先打到它（续期 TTL）。"""
        if session_key:
            self._sticky[session_key] = (worker_id, time.time() + self._STICKY_TTL)

    def candidates(self, model: str, model_type: Optional[str] = None,
                   session_key: Optional[str] = None,
                   owner_user_id: Optional[int] = None) -> list:
        """返回可服务该模型的 worker 有序列表，用于账号级 failover。

        可见性：真实 worker（P2P 公共）始终可见；虚拟 worker 仅当其 owner_user_id 为空（全局）
        或等于 owner_user_id（请求者本人）。即看不到别人的个人供给源。
        排序（个人优先）：本人个人源 → 公共真实 worker → 全局虚拟源；组内按 active_requests 升序。
        若 session_key 已绑定且命中候选，则置顶（粘性会话）。
        """
        def _matches(w) -> bool:
            return model in w.models and (
                model_type is None or w.model_types.get(model, "chat") == model_type
            )

        def _visible_virtual(v) -> bool:
            owner = getattr(v, "owner_user_id", None)
            return owner is None or owner == owner_user_id

        owned = sorted(
            (v for v in self._virtual
             if _matches(v) and getattr(v, "owner_user_id", None) is not None
             and v.owner_user_id == owner_user_id),
            key=lambda v: v.active_requests,
        )
        real = sorted((w for w in self._workers if _matches(w)),
                      key=lambda w: w.active_requests)
        virt_pub = sorted(
            (v for v in self._virtual
             if _matches(v) and getattr(v, "owner_user_id", None) is None),
            key=lambda v: v.active_requests,
        )
        ordered = owned + real + virt_pub
        if session_key:
            bound = self._sticky_lookup(session_key)
            if bound:
                for i, w in enumerate(ordered):
                    if w.worker_id == bound:
                        ordered.insert(0, ordered.pop(i))
                        break
        return ordered

    def has_owned_worker(self, models: list, owner_user_id: Optional[int]) -> bool:
        """该用户是否拥有可服务 models 中任一模型的个人供给源（用于计费预检豁免）。"""
        if owner_user_id is None:
            return False
        wanted = set(models or [])
        for v in self._virtual:
            if getattr(v, "owner_user_id", None) == owner_user_id and (wanted & set(v.models)):
                return True
        return False

    def models_for_user(self, owner_user_id: Optional[int]) -> dict:
        """该用户可见的 {model: type}：公共（真实 + 全局虚拟）+ 本人个人源。"""
        result: dict[str, str] = {}
        for w in self._workers:
            for m in w.models:
                result[m] = w.model_types.get(m, "chat")
        for v in self._virtual:
            owner = getattr(v, "owner_user_id", None)
            if owner is None or owner == owner_user_id:
                for m in v.models:
                    result[m] = v.model_types.get(m, "chat")
        return result

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

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
    circle_id: Optional[int] = None          # 兼容旧逻辑（单圈子）
    circle_ids: list = field(default_factory=list)  # 多圈子共享
    client_ip: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    country_code: str = ""
    city: str = ""
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
        from geo_ip import virtual_worker_geo
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
            worker_id = f"vw-{a['id']}"
            geo = virtual_worker_geo(worker_id)
            self._virtual.append(VirtualWorkerConnection(
                base_url=a["base_url"],
                api_key=a["api_key"],
                api_style=a["api_style"],
                models=names,
                model_types=model_types,
                worker_id=worker_id,
                name=a["name"],
                user_id=a.get("user_id"),
                credentials=a.get("credentials") or {},
                agent_id=a.get("id"),
                owner_user_id=a.get("owner_user_id"),
                circle_id=a.get("circle_id"),
                latitude=geo["lat"],
                longitude=geo["lng"],
                country_code=geo["country_code"],
                city=geo["city"],
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
                   owner_user_id: Optional[int] = None,
                   user_circle_ids: Optional[set] = None) -> list:
        """返回可服务该模型的 worker 有序列表。

        可见性：
          真实 worker：circle_id is None → 公开；否则仅圈内用户可见。
          虚拟 worker：owner == uid → 私有（本人可见）；owner is None & circle is None → 全局公开；
                       owner is None & circle_id in user_circle_ids → 圈内可见。
        排序：本人私有源 → 公共/圈子真实 worker + 圈子虚拟 worker → 全局公开虚拟源。
        圈子 worker 与公共 P2P 等权竞争（不做额外排序分层）。
        """
        circles = user_circle_ids or set()

        def _matches(w) -> bool:
            return model in w.models and (
                model_type is None or w.model_types.get(model, "chat") == model_type
            )

        def _real_visible(w) -> bool:
            wids = worker_circle_ids(w)
            return not wids or bool(wids & circles)

        def _virtual_visible(v) -> bool:
            owner = getattr(v, "owner_user_id", None)
            cid = getattr(v, "circle_id", None)
            if owner == owner_user_id:
                return True   # private to self
            if owner is not None:
                return False  # someone else's private
            # owner is None: global public or circle-scoped
            return cid is None or cid in circles

        owned = sorted(
            (v for v in self._virtual
             if _matches(v) and owner_user_id is not None
             and getattr(v, "owner_user_id", None) == owner_user_id),
            key=lambda v: v.active_requests,
        )
        shared = sorted(
            [w for w in self._workers if _matches(w) and _real_visible(w)]
            + [v for v in self._virtual
               if _matches(v) and getattr(v, "owner_user_id", None) != owner_user_id
               and _virtual_visible(v)],
            key=lambda w: w.active_requests,
        )
        ordered = owned + shared

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

    def models_for_user(self, owner_user_id: Optional[int] = None,
                        user_circle_ids: Optional[set] = None) -> dict:
        """该用户可见的 {model: type}：公共 + 本人私有 + 所属圈子内的模型。"""
        circles = user_circle_ids or set()
        result: dict[str, str] = {}
        for w in self._workers:
            wids = worker_circle_ids(w)
            if not wids or wids & circles:
                for m in w.models:
                    result[m] = w.model_types.get(m, "chat")
        for v in self._virtual:
            owner = getattr(v, "owner_user_id", None)
            cid = getattr(v, "circle_id", None)
            if owner == owner_user_id:
                visible = True
            elif owner is not None:
                visible = False
            else:
                visible = cid is None or cid in circles
            if visible:
                for m in v.models:
                    result[m] = v.model_types.get(m, "chat")
        return result

    def circle_model_ids_for_user(self, owner_user_id: Optional[int] = None,
                                   user_circle_ids: Optional[set] = None) -> dict:
        """返回 {model: circle_id}，仅包含圈子内可见的 worker 模型（circle_id 非空）。"""
        circles = user_circle_ids or set()
        result: dict[str, int] = {}
        for w in self._workers:
            wids = worker_circle_ids(w)
            if not wids:
                continue
            for cid in wids:
                if cid in circles:
                    for m in w.models:
                        result[m] = cid
        for v in self._virtual:
            owner = getattr(v, "owner_user_id", None)
            cid = getattr(v, "circle_id", None)
            if cid is not None and owner is None and cid in circles:
                for m in v.models:
                    result[m] = cid
        return result

    def models_for_circle(self, circle_id: int) -> list:
        """指定圈子内共享的模型（worker / 公开虚拟源，circle_id 匹配）。"""
        seen: set[str] = set()
        out: list[dict] = []
        for w in self._workers:
            if circle_id not in worker_circle_ids(w):
                continue
            if getattr(w, "owner_user_id", None) is not None:
                continue
            for m in w.models:
                if m in seen:
                    continue
                seen.add(m)
                out.append({
                    "id": m,
                    "model_type": w.model_types.get(m, "chat"),
                })
        for v in self._virtual:
            cid = getattr(v, "circle_id", None)
            if cid != circle_id:
                continue
            if getattr(v, "owner_user_id", None) is not None:
                continue
            for m in v.models:
                if m in seen:
                    continue
                seen.add(m)
                out.append({
                    "id": m,
                    "model_type": v.model_types.get(m, "chat"),
                })
        return sorted(out, key=lambda x: x["id"])

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


def worker_circle_ids(w) -> set[int]:
    """Worker 贡献到的圈子 ID 集合；空集表示公开。"""
    ids = getattr(w, "circle_ids", None) or []
    if ids:
        return set(ids)
    cid = getattr(w, "circle_id", None)
    return {cid} if cid is not None else set()

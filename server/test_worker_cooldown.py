"""WorkerPool 节点冷却：失败记冷却、candidates 下沉、成功清除。"""
from __future__ import annotations

import time
import unittest
from types import SimpleNamespace

from worker_pool import WorkerPool


def _fake_worker(wid: str, models: list[str], model_types: dict | None = None):
    return SimpleNamespace(
        worker_id=wid,
        name=wid,
        models=list(models),
        model_types=model_types or {m: "image" for m in models},
        active_requests=0,
        user_id=None,
        owner_user_id=None,
        circle_id=None,
        circle_ids=None,
        agents=[],
        caps={},
        pending={},
        reward_multiplier=lambda: 1.0,
    )


class TestWorkerCooldown(unittest.TestCase):
    def setUp(self):
        self.pool = WorkerPool()
        self.a = _fake_worker("vw-1", ["gemini-2.5-flash-image"])
        self.b = _fake_worker("vw-2", ["gemini-2.5-flash-image"])
        self.pool._virtual = [self.a, self.b]

    def test_note_and_is_cooling(self):
        now = time.time()
        until = self.pool.note_cooldown(
            "vw-1", "gemini-2.5-flash-image", "HTTP_429 rate limit", now=now,
        )
        self.assertIsNotNone(until)
        self.assertTrue(self.pool.is_cooling("vw-1", "gemini-2.5-flash-image", now=now + 1))
        self.assertFalse(self.pool.is_cooling("vw-1", "gemini-2.5-flash-image", now=until + 1))

    def test_candidates_sink_cooled(self):
        now = time.time()
        self.pool.note_cooldown("vw-1", "gemini-2.5-flash-image", "Gateway timeout", now=now)
        # owner_user_id 非空时，owner=None 的全局虚拟源才会进 shared 候选
        cands = self.pool.candidates(
            "gemini-2.5-flash-image", model_type="image", owner_user_id=1,
        )
        self.assertEqual(len(cands), 2)
        # 冷却的 vw-1 应下沉到末尾
        self.assertEqual(cands[0].worker_id, "vw-2")
        self.assertEqual(cands[1].worker_id, "vw-1")

    def test_clear_cooldown(self):
        now = time.time()
        self.pool.note_cooldown("vw-1", "m", "timeout", now=now)
        self.pool.clear_cooldown("vw-1", "m")
        self.assertFalse(self.pool.is_cooling("vw-1", "m", now=now + 1))

    def test_auth_longer_than_transient(self):
        now = time.time()
        u_rate = self.pool.note_cooldown("w", "m", "HTTP_429", now=now)
        self.pool.clear_cooldown("w", "m")
        u_auth = self.pool.note_cooldown("w", "m", "HTTP_401 unauthorized", now=now)
        self.assertGreater(u_auth - now, u_rate - now)


if __name__ == "__main__":
    unittest.main()

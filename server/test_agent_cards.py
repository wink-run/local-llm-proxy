"""normalize_agent_cards / agent_card_visible / shared_agent_display_name 轻量单测"""

from worker_pool import (
    normalize_agent_cards,
    agent_card_visible,
    shared_agent_display_name,
    WorkerConnection,
)


class _FakeWs:
    pass


def test_shared_agent_display_name_prefixes_owner():
    assert shared_agent_display_name("写诗专家", "adam") == "adam的写诗专家"
    # 已带同前缀不重复
    assert shared_agent_display_name("adam的写诗专家", "adam") == "adam的写诗专家"
    assert shared_agent_display_name("写诗专家", "") == "写诗专家"
    assert shared_agent_display_name("", "adam") == "adam的智能体"


def test_owner_label_from_user():
    from worker_pool import owner_label_from_user
    assert owner_label_from_user({"nickname": "adam", "email": "x@y.com"}) == "adam"
    assert owner_label_from_user({"nickname": "", "email": "bob@example.com"}) == "bob"
    assert owner_label_from_user(None) == ""


def test_normalize_strips_body_fields():
    cards = normalize_agent_cards([
        {
            "id": "a1",
            "name": "poet",
            "display_name": "写诗",
            "description": "短简介",
            "visibility": "public",
            "runtime": "codex",
            "soul": "SECRET",
            "content": "LEAK",
            "prompts": [{"body": "x"}],
        },
        {"id": "a1"},  # 去重
        "bad",
        {"id": "a2", "visibility": "circle"},
    ], owner_nickname="adam")
    assert len(cards) == 2
    assert cards[0]["id"] == "a1"
    assert "soul" not in cards[0]
    assert "content" not in cards[0]
    assert cards[0]["display_name"] == "adam的写诗"
    assert cards[1]["visibility"] == "circle"
    assert cards[1]["display_name"].startswith("adam的")


def test_agent_card_visible_public_and_circle():
    w = WorkerConnection(
        ws=_FakeWs(), models=[], worker_id="w1", name="n",
        circle_ids=[7],
    )
    pub = {"id": "x", "visibility": "public"}
    cir = {"id": "y", "visibility": "circle"}
    assert agent_card_visible(pub, w, set()) is True
    assert agent_card_visible(cir, w, set()) is False
    assert agent_card_visible(cir, w, {7}) is True
    assert agent_card_visible(cir, w, {9}) is False


def test_get_agent_for_user_picks_lowest_load():
    from worker_pool import pool

    class _W:
        def __init__(self, wid, agents, load=0, circles=None):
            self.worker_id = wid
            self.agents = agents
            self.active_requests = load
            self.circle_ids = list(circles or [])
            self.circle_id = self.circle_ids[0] if len(self.circle_ids) == 1 else None
            self.name = wid
            self.owner_nickname = "adam"

    prev = list(pool._workers)
    try:
        pool._workers = [
            _W("w-busy", [{"id": "poet", "visibility": "public", "display_name": "写诗"}], load=5),
            _W("w-idle", [{"id": "poet", "visibility": "public", "display_name": "写诗"}], load=1),
            _W("w-circle", [{"id": "secret", "visibility": "circle", "display_name": "密"}], load=0, circles=[7]),
        ]
        pub = pool.get_agent_for_user("poet", public_only=True)
        assert pub and pub["worker_id"] == "w-idle"
        assert pool.get_agent_for_user("secret", public_only=True) is None
        assert pool.get_agent_for_user("secret", user_circle_ids=set()) is None
        cir = pool.get_agent_for_user("secret", user_circle_ids={7})
        assert cir and cir["id"] == "secret" and cir["worker_id"] == "w-circle"
    finally:
        pool._workers = prev


def test_pick_agent_workers_falls_back_when_pinned_offline():
    from worker_pool import pool

    class _W:
        def __init__(self, wid, agents, load=0):
            self.worker_id = wid
            self.agents = agents
            self.active_requests = load
            self.circle_ids = []
            self.circle_id = None

    # 暂存并替换真实 workers
    old = list(pool._workers)
    try:
        pool._workers = [
            _W("old-pin", [{"id": "a1", "visibility": "public"}], load=2),
            _W("fresh", [{"id": "a1", "visibility": "public"}], load=0),
        ]
        # 钉选已不存在的 id → 回退到负载更低的 fresh
        hit = pool.pick_agent_workers("a1", worker_id="gone")
        assert len(hit) == 2
        assert hit[0].worker_id == "fresh"
        # 钉选仍在线 → 只用钉选
        pin = pool.pick_agent_workers("a1", worker_id="old-pin")
        assert len(pin) == 1 and pin[0].worker_id == "old-pin"
    finally:
        pool._workers = old

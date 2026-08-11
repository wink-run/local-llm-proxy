"""routing_catalog 校验 / 编译：策略过滤路由可无 steps；scope/tier 须下发。"""

from __future__ import annotations

import sys
import types
import unittest

# 避免拉起真实 DB 依赖
sys.modules.setdefault("database", types.ModuleType("database"))

import routing_catalog as rc  # noqa: E402


class TestValidateRoute(unittest.TestCase):
    def test_tier_only_ok(self):
        r = rc.normalize_route({
            "id": "strategy-free",
            "scene_name": "仅免费",
            "model_key": "llm-router-free",
            "tier": "free",
            "steps": [],
        })
        rc.validate_route(r)

    def test_scope_only_ok(self):
        r = rc.normalize_route({
            "id": "strategy-personal",
            "scene_name": "个人源",
            "model_key": "llm-router-personal",
            "scope": "personal",
        })
        rc.validate_route(r)

    def test_flow_only_ok(self):
        r = rc.normalize_route({
            "id": "strategy-auto",
            "scene_name": "综合最优",
            "model_key": "llm-router-auto",
            "flow": "auto",
        })
        rc.validate_route(r)

    def test_empty_fails(self):
        r = rc.normalize_route({
            "id": "x",
            "scene_name": "x",
            "model_key": "llm-router-x",
            "steps": [],
        })
        with self.assertRaises(ValueError):
            rc.validate_route(r)

    def test_tier_only_step_ok(self):
        r = rc.normalize_route({
            "id": "x",
            "scene_name": "x",
            "model_key": "llm-router-x",
            "steps": [{"tier": "free"}],
        })
        rc.validate_route(r)
        self.assertEqual(r["steps"], [{"tier": "free"}])


class TestCompileRoute(unittest.TestCase):
    def test_compile_keeps_scope_tier(self):
        r = rc.normalize_route({
            "id": "strategy-free",
            "scene_name": "仅免费",
            "model_key": "llm-router-free",
            "tier": "free",
            "flow": "auto",
            "scope": "personal",
        })
        out = rc.compile_route(r)
        self.assertEqual(out.get("tier"), "free")
        self.assertEqual(out.get("flow"), "auto")
        self.assertEqual(out.get("scope"), "personal")


if __name__ == "__main__":
    unittest.main()

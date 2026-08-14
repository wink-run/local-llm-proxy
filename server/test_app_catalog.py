"""app_catalog：已存目录加载时回填新增的 default_entities。"""

from __future__ import annotations

import sys
import types
import unittest

# 避免拉起真实 DB 依赖
sys.modules.setdefault("database", types.ModuleType("database"))

import app_catalog as ac  # noqa: E402


class TestBackfillDefaultEntities(unittest.TestCase):
    def test_enrich_appends_missing_deepseek_harness(self):
        stored = [{
            "id": "hermes",
            "handler": "hermes-cli",
            "name": "Hermes Agent",
            "vars": {"capabilities": {"gateway_proxy": True, "session_trace": False}},
        }]
        out = ac.enrich_entities_from_defaults(stored)
        ids = [e["id"] for e in out]
        self.assertIn("hermes", ids, "既有实体保留")
        self.assertIn("deepseek-harness", ids, "新捆绑应用应出现在目录")
        hermes = next(e for e in out if e["id"] == "hermes")
        self.assertFalse(hermes["vars"]["capabilities"]["session_trace"])

    def test_enrich_does_not_duplicate_existing(self):
        stored = [{
            "id": "deepseek-harness",
            "handler": "deepseek-harness-cli",
            "name": "Custom DSH",
        }]
        out = ac.enrich_entities_from_defaults(stored)
        ids = [e["id"] for e in out]
        self.assertEqual(ids.count("deepseek-harness"), 1)
        dsh = next(e for e in out if e["id"] == "deepseek-harness")
        self.assertEqual(dsh["name"], "Custom DSH")

    def test_stale_gateway_only_seed_enables_session_caps(self):
        import app_handlers as ah
        caps = ah.resolve_user_capabilities(
            ah.handlers_map()["deepseek-harness-cli"],
            {"capabilities": {
                "gateway_proxy": True,
                "session_trace": False,
                "session_usage_import": False,
            }},
        )
        self.assertTrue(caps["session_trace"])
        self.assertTrue(caps["session_usage_import"])

    def test_hermes_gateway_only_seed_not_upgraded(self):
        import app_handlers as ah
        caps = ah.resolve_user_capabilities(
            ah.handlers_map()["hermes-cli"],
            {"capabilities": {
                "gateway_proxy": True,
                "session_trace": False,
                "session_usage_import": False,
            }},
        )
        self.assertFalse(caps["session_trace"])
        self.assertFalse(caps["session_usage_import"])


if __name__ == "__main__":
    unittest.main()

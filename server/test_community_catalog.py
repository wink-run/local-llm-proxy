# server/test_community_catalog.py
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import unittest
import community_catalog as cc


class TestDefaultDoc(unittest.TestCase):
    def test_default_doc_has_four_sections(self):
        doc = cc.load_default_doc()
        for key in ("mcp", "prompts", "skills", "assistants"):
            self.assertIsInstance(doc[key], list, f"{key} must be a list")

    def test_mcp_reuses_client_catalog_with_builtin(self):
        doc = cc.load_default_doc()
        ids = {m.get("catalog_id") or m.get("id") for m in doc["mcp"]}
        self.assertIn("tokenbank-agent-bridge", ids)
        self.assertIn("tokenbank-prompts", ids)

    def test_resources_seeded_from_yaml(self):
        doc = cc.load_default_doc()
        names = {p["name"] for p in doc["prompts"]}
        self.assertIn("code-review", names)
        self.assertEqual({s["name"] for s in doc["skills"]},
                         {"git-commit", "systematic-debugging"})
        self.assertEqual([a["name"] for a in doc["assistants"]], ["python-expert"])

    def test_normalize_fills_missing_sections(self):
        out = cc.normalize_catalog_doc({"mcp": [{"catalog_id": "x"}]})
        self.assertEqual(out["prompts"], [])
        self.assertEqual(out["skills"], [])
        self.assertEqual(out["assistants"], [])
        self.assertEqual(out["version"], 1)

    def test_payload_from_doc_roundtrip(self):
        payload = cc.catalog_payload_from_doc(cc.load_default_doc())
        self.assertIn("code-review", {p["name"] for p in payload["prompts"]})


from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import database as db
from db_pool import init_pool, close_pool


class TestAsyncLayer(unittest.IsolatedAsyncioTestCase):
    # IsolatedAsyncioTestCase 每个测试方法用独立事件循环，asyncpg 连接池绑定创建时的循环，
    # 因此不能像模块级 setUp 那样只初始化一次 —— 每个用例都要在自己的循环里重建连接池。
    async def asyncSetUp(self):
        await init_pool()
        await db.set_config(cc.CONFIG_KEY, "")

    async def asyncTearDown(self):
        await close_pool()

    async def test_load_doc_falls_back_to_default(self):
        doc = await cc.load_community_catalog_doc()
        self.assertIn("code-review", {p["name"] for p in doc["prompts"]})

    async def test_db_override_wins(self):
        await cc.save_catalog_doc({"version": 2, "prompts": [
            {"catalog_id": "only", "type": "prompt", "name": "only"}]})
        doc = await cc.load_community_catalog_doc()
        self.assertEqual([p["name"] for p in doc["prompts"]], ["only"])
        self.assertEqual(doc["version"], 2)

    async def test_import_from_defaults_seeds_db(self):
        res = await cc.import_from_defaults()
        self.assertTrue(res["ok"])
        doc = await cc.load_community_catalog_doc()
        self.assertIn("git-commit", {s["name"] for s in doc["skills"]})

    async def test_payload_public_shape(self):
        payload = await cc.community_catalog_payload()
        for key in ("version", "mcp", "prompts", "skills", "assistants"):
            self.assertIn(key, payload)


if __name__ == "__main__":
    unittest.main()

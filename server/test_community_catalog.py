# server/test_community_catalog.py
# 仅覆盖纯函数 / 默认 YAML 装配，不依赖 PostgreSQL。
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
        prompt_names = {p["name"] for p in doc["prompts"]}
        skill_names = {s["name"] for s in doc["skills"]}
        assistant_names = {a["name"] for a in doc["assistants"]}
        # 原始种子条目必须仍在（新增社区推荐后集合会更大，故用成员判断）
        self.assertIn("code-review", prompt_names)
        self.assertLessEqual({"git-commit", "systematic-debugging"}, skill_names)
        self.assertIn("python-expert", assistant_names)
        # 扩充后的默认推荐规模（≥50，均匀分布）
        self.assertGreaterEqual(len(prompt_names) + len(skill_names) + len(assistant_names), 50)

    def test_normalize_fills_missing_sections(self):
        out = cc.normalize_catalog_doc({"mcp": [{"catalog_id": "x"}]})
        self.assertEqual(out["prompts"], [])
        self.assertEqual(out["skills"], [])
        self.assertEqual(out["assistants"], [])
        self.assertEqual(out["version"], 1)

    def test_payload_from_doc_roundtrip(self):
        payload = cc.catalog_payload_from_doc(cc.load_default_doc())
        self.assertIn("code-review", {p["name"] for p in payload["prompts"]})


if __name__ == "__main__":
    unittest.main()

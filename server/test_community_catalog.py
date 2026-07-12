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


if __name__ == "__main__":
    unittest.main()

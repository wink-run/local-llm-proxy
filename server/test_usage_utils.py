import unittest

from usage_utils import estimate_input_tokens, normalize_usage, usage_sse_chunk


class UsageUtilsTest(unittest.TestCase):
    def test_estimate_input_tokens(self):
        body = {"messages": [{"role": "user", "content": "hello world"}]}
        self.assertGreater(estimate_input_tokens(body), 0)

    def test_normalize_fills_missing_input(self):
        usage = normalize_usage({"completion_tokens": 69}, {"messages": [{"role": "user", "content": "你是谁，用的什么模型"}]})
        self.assertGreater(usage["prompt_tokens"], 0)
        self.assertEqual(usage["completion_tokens"], 69)

    def test_normalize_keeps_existing_input(self):
        usage = normalize_usage({"prompt_tokens": 100, "completion_tokens": 20}, None)
        self.assertEqual(usage["prompt_tokens"], 100)
        self.assertEqual(usage["completion_tokens"], 20)

    def test_usage_sse_chunk(self):
        chunk = usage_sse_chunk({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}, "m")
        self.assertIn("prompt_tokens", chunk)
        self.assertIn("data:", chunk)


if __name__ == "__main__":
    unittest.main()

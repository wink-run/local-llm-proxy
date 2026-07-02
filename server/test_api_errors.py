"""api_errors 单元测试"""
import json
import unittest

from api_errors import (
    combined_worker_error_text,
    error_message_from_payload,
    openai_error_content,
    parse_worker_error,
    payload_has_openai_error,
    should_offline_contributor_model,
)


class ApiErrorsTest(unittest.TestCase):
    def test_parse_http_status_and_json_body(self):
        err = 'HTTP 503: {"detail":"No worker available for model \'glm-5.2\'"}'
        code, msg, etype = parse_worker_error(err)
        self.assertEqual(code, 404)
        self.assertIn("No worker available", msg)
        self.assertEqual(etype, "model_not_found")

    def test_parse_insufficient_credits(self):
        code, msg, etype = parse_worker_error("HTTP 402: Insufficient credits")
        self.assertEqual(code, 402)
        self.assertEqual(etype, "insufficient_credits")

    def test_openai_error_content(self):
        body = openai_error_content("Gateway timeout", "timeout")
        self.assertEqual(body["error"]["message"], "Gateway timeout")
        self.assertEqual(body["error"]["type"], "timeout")

    def test_payload_has_openai_error(self):
        self.assertTrue(payload_has_openai_error({"error": {"message": "bad"}}))
        self.assertFalse(payload_has_openai_error({"choices": []}))

    def test_error_message_from_payload(self):
        msg = error_message_from_payload({"error": {"message": "rate limited"}})
        self.assertEqual(msg, "rate limited")

    def test_parse_all_providers_failed_uses_detail(self):
        err = 'HTTP 404: {"error":"all_providers_failed","detail":"Model \'test\' is not available"}'
        code, msg, etype = parse_worker_error(err)
        self.assertEqual(code, 404)
        self.assertIn("not available", msg)
        self.assertEqual(etype, "model_not_found")

    def test_combined_worker_error_text_merges_json_detail(self):
        err = 'HTTP 404: {"error":"all_providers_failed","detail":"Model \'test\' is not available"}'
        combined = combined_worker_error_text(err)
        self.assertIn("all_providers_failed", combined)
        self.assertIn("http_404", combined)
        self.assertIn("not available", combined)

    def test_should_offline_contributor_model(self):
        self.assertTrue(should_offline_contributor_model(
            "Model 'gpt-4o' is not configured on this contributor node"
        ))
        self.assertTrue(should_offline_contributor_model(
            "P2P relay API Key not configured. Open Community"
        ))
        self.assertTrue(should_offline_contributor_model(
            'HTTP 404: {"error":"all_providers_failed","detail":"Model \'test\' is not available"}'
        ))
        self.assertTrue(should_offline_contributor_model(
            'HTTP 404: {"error":"all_providers_failed","detail":"all_providers_failed"}'
        ))
        self.assertTrue(should_offline_contributor_model(
            'HTTP 404: {"error":{"message":"Model \'test\' is not available","type":"model_not_found"}}'
        ))
        self.assertTrue(should_offline_contributor_model(
            'HTTP 502: {"error":"all_providers_failed","detail":"HTTP_401: invalid key"}'
        ))
        self.assertTrue(should_offline_contributor_model("all_providers_failed"))
        self.assertFalse(should_offline_contributor_model("Gateway timeout"))


if __name__ == "__main__":
    unittest.main()

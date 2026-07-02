"""auth 单元测试"""
import unittest

from auth import create_token, decode_token, hash_password, verify_password


class AuthTest(unittest.TestCase):
    def test_hash_and_verify_password(self):
        hashed = hash_password("secret-pass")
        self.assertTrue(verify_password("secret-pass", hashed))
        self.assertFalse(verify_password("wrong-pass", hashed))

    def test_verify_password_invalid_hash(self):
        self.assertFalse(verify_password("plain", "not-a-bcrypt-hash"))

    def test_create_and_decode_token(self):
        token = create_token(42)
        self.assertEqual(decode_token(token), 42)

    def test_decode_token_invalid(self):
        self.assertIsNone(decode_token("invalid.token.here"))


if __name__ == "__main__":
    unittest.main()

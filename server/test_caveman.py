# server/test_caveman.py
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import unittest
from caveman import inject_caveman, VALID_LEVELS

class TestInjectCaveman(unittest.TestCase):
    def test_valid_levels(self):
        self.assertEqual(VALID_LEVELS, frozenset({'lite', 'full', 'ultra'}))

    def test_injects_into_existing_system_message(self):
        body = {'messages': [{'role': 'system', 'content': 'You are helpful.'},
                              {'role': 'user', 'content': 'hi'}]}
        inject_caveman(body, 'full')
        sys_msg = body['messages'][0]['content']
        self.assertIn('You are helpful.', sys_msg)
        self.assertIn('caveman', sys_msg.lower())

    def test_creates_system_message_if_absent(self):
        body = {'messages': [{'role': 'user', 'content': 'hi'}]}
        inject_caveman(body, 'lite')
        self.assertEqual(body['messages'][0]['role'], 'system')
        self.assertEqual(len(body['messages']), 2)

    def test_noop_for_unknown_level(self):
        body = {'messages': [{'role': 'user', 'content': 'hi'}]}
        inject_caveman(body, 'invalid')
        self.assertEqual(len(body['messages']), 1)

    def test_noop_when_no_messages(self):
        body = {}
        inject_caveman(body, 'full')  # should not raise
        self.assertEqual(body, {})

    def test_lite_prompt_present(self):
        body = {'messages': [{'role': 'user', 'content': 'x'}]}
        inject_caveman(body, 'lite')
        injected = body['messages'][0]['content']
        self.assertIn('tersely', injected.lower())

    def test_ultra_prompt_present(self):
        body = {'messages': [{'role': 'user', 'content': 'x'}]}
        inject_caveman(body, 'ultra')
        injected = body['messages'][0]['content']
        self.assertIn('ultra', injected.lower())

if __name__ == '__main__':
    unittest.main()

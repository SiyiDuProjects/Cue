import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app
from app.services.openai_realtime import InterviewRegistry


class ExpiredSocketTests(unittest.TestCase):
    def test_missing_runtime_upgrades_then_closes_without_admitting_session(self):
        registry = InterviewRegistry()
        with patch.dict(os.environ, {'OPENAI_API_KEY': '', 'OPENAI_BASE_URL': 'http://127.0.0.1:1/v1',
                                     'INTERVIEW_WORKSPACE_HISTORY_DIR': '', 'INTERVIEW_ACCESS_TOKEN': 'fixture'}), \
             patch('app.services.openai_realtime._registry', registry), TestClient(app) as client:
            for channel in ['client', 'interviewer', 'candidate', 'model']:
                # Entering succeeds only if a close frame, not HTTP 403, is used.
                with client.websocket_connect(f'/ws/interviews/expired/{channel}') as socket:
                    with self.assertRaises(WebSocketDisconnect) as caught:
                        socket.receive_json()
                    self.assertEqual(caught.exception.code, 1008)
                self.assertIsNone(registry._current)
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/ws/interviews/expired/client', headers={'origin': 'https://untrusted.invalid'}):
                    self.fail('Untrusted origin was admitted')

import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from app.main import app
from app.services.openai_realtime import get_interview_registry


class CodexHostTests(unittest.TestCase):
    def setUp(self):
        get_interview_registry()._current = None
        self.env = patch.dict(os.environ, {"INTERVIEW_ACCESS_TOKEN": "test-access", "OPENAI_API_KEY": "",
                                           "OPENAI_BASE_URL": "http://127.0.0.1:1/v1", "INTERVIEW_WORKSPACE_HISTORY_DIR": ""})
        self.env.start()
        self.client = TestClient(app, base_url="https://interview.test")
        self.client.__enter__()  # All sockets must share one server event loop.
        self.session = self.client.post("/api/interviews", headers={"Authorization": "Bearer test-access"}).json()
        self.base = f"/ws/interviews/{self.session['interview_id']}/"

    def tearDown(self):
        self.client.delete(f"/api/interviews/{self.session['interview_id']}",
                           headers={"Authorization": "Bearer " + self.session["session_token"]})
        self.client.__exit__(None, None, None)
        get_interview_registry()._current = None
        self.env.stop()

    def authenticate(self, socket, key):
        socket.send_json({"type": "authenticate", "token": self.session[key]})

    def test_browser_token_cannot_become_a_model_host(self):
        with self.client.websocket_connect(self.base + "model") as socket:
            self.authenticate(socket, "session_token")
            with self.assertRaises(WebSocketDisconnect) as caught:
                socket.receive_json()
            self.assertEqual(caught.exception.code, 1008)

    def test_second_model_host_does_not_replace_the_first(self):
        with self.client.websocket_connect(self.base + "model") as first:
            self.authenticate(first, "capture_token")
            self.assertEqual(first.receive_json()["type"], "codex_ready")
            with self.client.websocket_connect(self.base + "model") as second:
                self.authenticate(second, "capture_token")
                with self.assertRaises(WebSocketDisconnect) as collision:
                    second.receive_json()
                self.assertEqual(collision.exception.code, 1013)
            first.send_json({'type': 'ping'})
            self.assertEqual(first.receive_json(), {'type': 'pong'})

    def test_real_websocket_relay_activity_and_inline_code(self):
        with self.client.websocket_connect(self.base + "model") as host:
            self.authenticate(host, "capture_token")
            self.assertEqual(host.receive_json()["realtime_protocol"], "interview-chat-v12")
            with self.client.websocket_connect(self.base + "client") as ui:
                self.authenticate(ui, "session_token")
                for identity, action in (("ordinary", "send"), ("publish", "send")):
                    ui.send_json({"type": "chat_send", "operation_id": identity, "action": action,
                                  "text": "Explain", "request_ids": []})
                    request = host.receive_json()
                    self.assertEqual(request["type"], "codex_request")
                    self.assertEqual(request["model"], "gpt-6.1-sol")
                    self.assertEqual(request["request_id"], identity)
                    def event(kind, **values):
                        host.send_json({"type": "codex_event", "request_id": identity, "kind": kind, **values})
                    event("started", thread_id="test-thread")
                    self.assertNotIn("code_seed", request)
                    event("activity", activity={"id":"read", "kind":"command", "label":"读取指南", "status":"completed"})
                    event("delta", item_id="answer", text="**回答原文**\n\n```python\nx = 42\n```")
                    event("text_done", item_id="answer", text="**回答原文**\n\n```python\nx = 42\n```")
                    event("completed")
                    text = ""
                    while True:
                        received = ui.receive_json()
                        if received.get("response_id") != f"chat:{identity}":
                            continue
                        if received["type"] == "answer_delta":
                            text += received["delta"]
                        if received["type"] == "answer_completed":
                            break
                    self.assertEqual(text, "**回答原文**\n\n```python\nx = 42\n```")

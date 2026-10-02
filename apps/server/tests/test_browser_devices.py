from __future__ import annotations

import os
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.main import app, PAIRING_COOKIE_NAME, TRUSTED_BROWSER_COOKIE_NAME
from app.services.openai_realtime import InterviewRuntime, get_interview_registry


class BrowserDeviceTests(unittest.TestCase):
    def setUp(self):
        self.registry = get_interview_registry()
        self.registry._current = None
        self.registry.draining = False
        self.env = patch.dict(os.environ, {"INTERVIEW_ACCESS_TOKEN": "device-test-secret"})
        self.env.start()
        self.client = TestClient(app, base_url="https://interview.test")
        self.origin = {"Origin": "https://interview.test"}
        self.session = self.client.post("/api/interviews", headers={"Authorization": "Bearer device-test-secret"},
                                        json={"device_name": "测试电脑"}).json()
        self.runtime = self.registry._current
        self.capture = self.client.websocket_connect(f"/ws/interviews/{self.session['interview_id']}/interviewer")
        self.socket = self.capture.__enter__()
        self.socket.send_json({"type": "authenticate", "token": self.session["capture_token"], "browser_connections": True})
        self.assertEqual(self.socket.receive_json()["type"], "session_ready")

    def tearDown(self):
        self.capture.__exit__(None, None, None)
        self.client.close()
        self.registry._current = None
        self.registry.draining = False
        self.env.stop()

    def request(self):
        response = self.client.post(f"/api/devices/{self.session['interview_id']}/connect", headers=self.origin)
        self.assertEqual(response.status_code, 202, response.text)
        event = self.socket.receive_json()
        self.assertEqual(event["type"], "browser_connection_request")
        return event

    def decide(self, event, approved):
        self.socket.send_json({"type": "browser_connection_decision", "request_id": event["request_id"], "approved": approved})
        receipt = self.socket.receive_json()
        self.assertEqual(receipt["type"], "browser_connection_result")
        self.assertTrue(receipt["ok"])

    def test_list_contains_only_online_device_metadata(self):
        response = self.client.get("/api/devices")
        self.assertEqual(response.json(), {"devices": [{"device_id": self.session["interview_id"], "name": "测试电脑", "active": False}]})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn(self.session["session_token"], response.text)
        self.assertNotIn(self.session["capture_token"], response.text)
        self.registry.draining = True
        self.assertEqual(self.client.get("/api/devices").json(), {"devices": []})

    def test_approval_remembers_browser_without_exposing_capture_or_admin_credentials(self):
        ensure = AsyncMock()
        with patch.object(InterviewRuntime, "ensure_main", ensure):
            event = self.request()
            self.assertEqual(self.client.get("/api/interviews/current").status_code, 401)
            self.assertEqual(self.client.get("/api/browser/connection").json(), {"status": "pending"})
            self.decide(event, True)
            response = self.client.get("/api/browser/connection")
            data = response.json()
            self.assertEqual(data["status"], "connected")
            self.assertEqual(data["session"]["session_token"], self.session["session_token"])
            self.assertNotIn("capture_token", data["session"])
            self.assertNotIn("device-test-secret", response.text)
            cookie = response.headers["set-cookie"].lower()
            for part in ("httponly", "secure", "samesite=strict", "max-age=2592000"):
                self.assertIn(part, cookie)
            self.assertEqual(self.client.get("/api/interviews/current").status_code, 200)
            repeated = self.client.post(f"/api/devices/{self.session['interview_id']}/connect", headers=self.origin)
            self.assertEqual(repeated.json()["status"], "connected")
            self.assertEqual(self.client.post("/api/deployment").status_code, 401)
            self.assertEqual(self.client.post("/api/interviews").status_code, 401)
            ensure.assert_not_awaited()

    def test_denial_timeout_and_cancel_do_not_grant_access(self):
        event = self.request()
        self.decide(event, False)
        self.assertEqual(self.client.get("/api/browser/connection").json()["status"], "denied")
        retry = self.request()
        self.assertNotEqual(retry["request_id"], event["request_id"])
        response = self.client.delete("/api/browser/connection", headers=self.origin)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.socket.receive_json()["type"], "browser_connection_result")
        self.assertEqual(self.client.get("/api/browser/connection").status_code, 410)
        event = self.request()
        self.runtime.browser_connection.pending["deadline"] = 0
        self.assertEqual(self.client.get("/api/browser/connection").status_code, 410)
        self.assertFalse(self.runtime.browser_connection.decide(event["request_id"], True))
        self.assertEqual(self.client.get("/api/interviews/current").status_code, 401)

    def test_another_browser_cannot_poll_or_replace_pending_request(self):
        self.request()
        # A second browser is another HTTP client, not a second ASGI lifespan.
        other = TestClient(app, base_url="https://interview.test")
        try:
            self.assertEqual(other.get("/api/browser/connection").status_code, 410)
            response = other.post(f"/api/devices/{self.session['interview_id']}/connect", headers=self.origin)
            self.assertEqual(response.status_code, 409)
        finally:
            other.close()
        response = self.client.post(f"/api/devices/{self.session['interview_id']}/connect", headers=self.origin)
        self.assertEqual(response.status_code, 202)

    def test_cross_site_requests_and_stale_device_are_rejected(self):
        url = f"/api/devices/{self.session['interview_id']}/connect"
        self.assertEqual(self.client.post(url, headers={"Origin": "https://attacker.test"}).status_code, 403)
        self.assertEqual(self.client.post(url).status_code, 403)
        self.assertEqual(self.client.post("/api/devices/missing/connect", headers=self.origin).status_code, 409)
        self.registry.draining = True
        self.assertEqual(self.client.post(url, headers=self.origin).status_code, 409)

    def test_forged_cookie_and_expired_trust_do_not_connect(self):
        self.client.cookies.set(TRUSTED_BROWSER_COOKIE_NAME, "123.invalid")
        self.assertEqual(self.client.get("/api/interviews/current").status_code, 401)
        from app.main import _make_browser_cookie
        self.client.cookies.set(TRUSTED_BROWSER_COOKIE_NAME, _make_browser_cookie("device-test-secret", issued_at=1, scope="trusted"))
        self.assertEqual(self.client.get("/api/interviews/current").status_code, 401)

    def test_list_drops_disconnected_capture_and_pending_approval(self):
        self.request()
        self.socket.send_json({"type": "close"})
        import time
        for _ in range(50):
            if not self.runtime._capture_clients:
                break
            time.sleep(.01)
        self.assertEqual(self.client.get("/api/devices").json(), {"devices": []})
        self.assertEqual(self.client.get("/api/browser/connection").status_code, 410)

    def test_browser_client_cannot_approve_a_connection(self):
        event = self.request()
        with self.client.websocket_connect(f"/ws/interviews/{self.session['interview_id']}/client") as ui:
            ui.send_json({"type": "authenticate", "token": self.session["session_token"]})
            self.assertEqual(ui.receive_json()["type"], "session_ready")
            ui.send_json({"type": "browser_connection_decision", "request_id": event["request_id"], "approved": True})
            ui.send_json({"type": "ping"})
            while ui.receive_json()["type"] != "pong":
                pass
        self.assertEqual(self.client.get("/api/browser/connection").json(), {"status": "pending"})
        self.assertEqual(self.client.get("/api/interviews/current").status_code, 401)

    def test_software_authorization_survives_end_and_next_interview(self):
        self.decide(self.request(), True)
        self.assertEqual(self.client.get("/api/browser/connection").json()["status"], "connected")
        ended = self.client.delete(f"/api/interviews/{self.session['interview_id']}",
                                   headers={"Authorization": "Bearer " + self.session["session_token"]})
        self.assertEqual(ended.status_code, 204)
        self.assertEqual(self.client.get("/api/interviews/current").status_code, 204)
        following = self.client.post("/api/interviews", headers={"Authorization": "Bearer device-test-secret"},
                                     json={"device_name": "测试电脑"}).json()
        self.assertNotEqual(following["interview_id"], self.session["interview_id"])
        with self.client.websocket_connect(f"/ws/interviews/{following['interview_id']}/interviewer") as capture:
            capture.send_json({"type": "authenticate", "token": following["capture_token"], "browser_connections": True})
            self.assertEqual(capture.receive_json()["type"], "session_ready")
            connected = self.client.post(f"/api/devices/{following['interview_id']}/connect", headers=self.origin)
            self.assertEqual(connected.json()["status"], "connected")
            self.assertEqual(self.client.get("/api/interviews/current").json()["interview_id"], following["interview_id"])

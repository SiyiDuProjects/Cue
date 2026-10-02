import asyncio
import base64
import hashlib
import json
import os
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch, AsyncMock

from fastapi.testclient import TestClient
from app.main import app, plugin_auth
from app.services.openai_realtime import InterviewRegistry
from app.services.interview_materials import InterviewMaterials

ORIGIN = "https://interview.siyidu.com"
CALLBACK = "https://chatgpt.com/connector/oauth/sage-fixture"
PNG = "data:image/png;base64,iVBORw0KGgo="


class MaterialTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPENAI_BASE_URL": "http://127.0.0.1:1/v1", "INTERVIEW_WORKSPACE_HISTORY_DIR": self.directory.name,
                                          "INTERVIEW_ACCESS_TOKEN": "fixture-owner"})
        self.env.start()
        self.registry = InterviewRegistry()
        self.rt = await self.registry.create()
        self.materials = InterviewMaterials(self.registry)

    async def asyncTearDown(self):
        await self.registry.clear(); self.env.stop(); self.directory.cleanup()

    async def test_multiframe_cursor_retry_correction_and_persistence(self):
        await self.rt.update_transcript("interviewer", "first", "old wording", "completed")
        for i in range(5):
            self.rt.transcription.history.add_screen(str(i), PNG, "fixture", question_id="")
            self.rt.collected_screens.append(str(i))
            self.rt.transcription.visible_images.add(str(i))
        first, pixels = await self.materials.read("current")
        self.assertEqual(len(pixels), 2)
        cursor = first["next_cursor"]
        second, _ = await self.materials.read("current", cursor)
        replay, _ = await self.materials.read("current", cursor)
        self.assertEqual(second["records"], replay["records"])
        await self.rt.update_transcript("interviewer", "first", "corrected wording", "completed", corrected=True)
        third, _ = await self.materials.read("current", second["next_cursor"])
        self.assertFalse(third["has_more"])
        self.assertEqual([row['text'] for row in third['records'] if row['kind'] == 'transcript'], ['corrected wording'])
        updated, _ = await self.materials.read("current", third["next_cursor"])
        self.assertEqual(updated["records"], [])
        # Independent consumer starts from the beginning, and reads do not consume attachments.
        separate, _ = await self.materials.read("current")
        self.assertEqual(len(separate["records"]), 3)
        self.assertEqual(len(self.rt.collected_screens), 5)
        restarted_reader = InterviewMaterials(self.registry)
        empty, _ = await restarted_reader.read("current", updated["next_cursor"])
        self.assertEqual(empty["records"], [])
        historical, pixels = await restarted_reader.read("current", image_ids=["0", "4"])
        self.assertEqual(len(pixels), 2)

    async def test_interview_isolation_and_removed_pending_screens(self):
        original = self.rt.interview_id
        self.rt.history.add_screen("pending", PNG, "fixture", question_id="")
        self.rt.collected_screens.append("pending")
        first, _ = await self.materials.read(original)
        self.rt.collected_screens.clear()
        changed, pixels = await self.materials.read(original, first["next_cursor"])
        self.assertEqual(changed["records"][0]["kind"], "removed")
        self.assertEqual(pixels, [])
        other = await self.registry.switch(original, None)
        with self.assertRaisesRegex(ValueError, "游标"):
            await self.materials.read(other.conversation_id, first["next_cursor"])
        with self.assertRaisesRegex(ValueError, "不存在"):
            await self.materials.read("unknown")
        _, old_pixels = await self.materials.read(original, image_ids=["pending"])
        self.assertEqual(len(old_pixels), 1)
        self.assertEqual((await self.registry.current()).interview_id, other.interview_id)

    async def test_long_transcript_pages_are_complete(self):
        text = "中文" * 30000
        await self.rt.update_transcript("interviewer", "large", text, "completed")
        result, _ = await self.materials.read("current")
        records = result["records"]
        while result["has_more"]:
            result, _ = await self.materials.read("current", result["next_cursor"])
            records += result["records"]
        self.assertEqual("".join(r["text"] for r in records), text)


class OAuthTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPENAI_BASE_URL": "http://127.0.0.1:1/v1", "INTERVIEW_WORKSPACE_HISTORY_DIR": "", "INTERVIEW_ACCESS_TOKEN": "plugin-fixture"})
        self.env.start()
        self.registry = InterviewRegistry()
        self.patch = patch("app.services.openai_realtime._registry", self.registry); self.patch.start()
        self.client = TestClient(app, base_url=ORIGIN); self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None); self.patch.stop(); self.env.stop()

    def test_oauth_pkce_consent_readonly_images_refresh_and_revoke(self):
        unauthorized = self.client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(unauthorized.status_code, 401)
        self.assertIn("resource_metadata", unauthorized.headers["www-authenticate"])
        self.assertEqual(self.client.get("/.well-known/oauth-protected-resource/mcp").json()["resource"], ORIGIN+"/mcp")
        bad = self.client.post("/register", json={"redirect_uris": ["https://evil.example/callback"], "token_endpoint_auth_method": "none"})
        self.assertEqual(bad.status_code, 400)
        registration = self.client.post("/register", json={"redirect_uris": [CALLBACK], "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "scope": "sage:read"})
        self.assertEqual(registration.status_code, 201, registration.text)
        client_id = registration.json()["client_id"]
        verifier = "a" * 64
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        response = self.client.get("/authorize", params={"client_id": client_id, "redirect_uri": CALLBACK, "response_type": "code", "code_challenge": challenge,
            "code_challenge_method": "S256", "scope": "sage:read", "resource": ORIGIN+"/mcp", "state": "fixture-state"}, follow_redirects=False)
        self.assertEqual(response.status_code, 302, response.text)
        self.assertEqual(self.client.get(response.headers["location"]).status_code, 200)
        self.assertEqual(self.client.post("/plugin/finish", headers={"Origin": ORIGIN}).status_code, 403)
        rt = self.client.portal.call(self.registry.create)
        host = AsyncMock()
        rt._capture_clients["interviewer"] = host; rt.browser_connection_host = host
        self.assertEqual(self.client.post("/plugin/begin", headers={"Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(self.client.post("/plugin/begin", headers={"Origin": ORIGIN}).status_code, 200)
        self.assertTrue(host.send_json.call_args.args[0]["read_only"])
        rt.browser_connection.decide(rt.browser_connection.current()["request_id"], True)
        finish = self.client.post("/plugin/finish", headers={"Origin": ORIGIN})
        self.assertEqual(finish.status_code, 200, finish.text)
        query = parse_qs(urlsplit(finish.json()["redirect"]).query)
        self.assertEqual(query["state"], ["fixture-state"])
        params = {"grant_type": "authorization_code", "code": query["code"][0], "redirect_uri": CALLBACK, "client_id": client_id,
                  "code_verifier": verifier, "resource": ORIGIN+"/mcp"}
        wrong = self.client.post("/token", data={**params, "code_verifier": "b"*64})
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(self.client.post("/token", data={**params, "resource": "https://evil.example/mcp"}).status_code, 400)
        tokens = self.client.post("/token", data=params)
        self.assertEqual(tokens.status_code, 200, tokens.text)
        self.assertEqual(self.client.post("/token", data=params).status_code, 400)
        token = tokens.json()["access_token"]
        headers = {"Authorization": "Bearer "+token, "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26"}
        listed = self.client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(listed.status_code, 200, listed.text)
        tools = listed.json()["result"]["tools"]
        self.assertEqual(len(tools), 4)
        self.assertTrue(all(t["annotations"]["readOnlyHint"] for t in tools))
        rt.history.add_screen("unsubmitted", PNG, "fixture", question_id="")
        rt.collected_screens.append("unsubmitted")
        read = self.client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "read_interview", "arguments": {"interview_id": rt.interview_id}}})
        self.assertEqual(read.status_code, 200, read.text)
        content = read.json()["result"]["content"]
        self.assertEqual(content[1]["type"], "image")
        self.assertEqual(content[1]["data"], PNG.split(",")[1])
        self.assertFalse(json.loads(content[0]["text"])["records"][0]["sent_to_sage"])
        self.assertFalse(json.loads(content[0]["text"])["contains_live_transcription"])
        live_route = self.client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "list_interviews", "arguments": {}}})
        routes = json.loads(live_route.json()["result"]["content"][0]["text"])
        self.assertEqual(routes["interviews"][0]["interview_id"], "current")
        refreshed = self.client.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens.json()["refresh_token"], "client_id": client_id, "resource": ORIGIN+"/mcp"})
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        revoked = self.client.post("/revoke", data={"token": token, "client_id": client_id})
        self.assertEqual(revoked.status_code, 200, revoked.text)
        self.assertEqual(self.client.post("/mcp", headers={**headers, "Authorization": "Bearer "+refreshed.json()["access_token"]}, json={"jsonrpc": "2.0", "id": 3, "method": "tools/list"}).status_code, 401)

import asyncio
import base64
import hashlib
import hmac
import json
import os
import socket
import tempfile
import time
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.services.event_webhook import CallbackError, PublicNetworkBackend, callback_url, signed_headers, signing_key
from app.services.openai_realtime import InterviewRegistry
from app.services.plugin_auth import PluginAuth
from app.services.plugin_events import PluginEvents, EventError, EVENT, principal_context

ORIGIN = "https://interview.siyidu.com"
SECRET = "whsec_" + base64.b64encode(b"a" * 32).decode()
PNG = "data:image/png;base64,iVBORw0KGgo="


class EventsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
            "INTERVIEW_WORKSPACE_HISTORY_DIR": self.directory.name, "INTERVIEW_ACCESS_TOKEN": "fixture-events"})
        self.env.start()
        self.registry = InterviewRegistry()
        self.rt = await self.registry.create()
        self.auth = PluginAuth(self.registry, ORIGIN)
        self.principal = {"client_id": "client", "subject": "sage-owner", "grant": "grant", "deadline": time.time() + 86400 * 30}
        self.deliveries = []
        self.status = 200
        async def sender(url, headers, body):
            self.deliveries.append((url, headers, body))
            value = json.loads(body)
            return self.status, json.dumps({"challenge": value.get("challenge")}).encode()
        self.events = PluginEvents(self.registry, self.auth, sender)
        self.params = {"name": EVENT, "arguments": {"channel": "mac"}, "delivery": {
            "mode": "webhook", "url": "https://receiver.example/callback", "secret": SECRET}, "cursor": None}
        self.sub = await self.events.subscribe(self.principal, self.params)

    async def asyncTearDown(self):
        await self.events.close()
        await self.registry.clear()
        self.env.stop(); self.directory.cleanup()

    async def enqueue(self, selected=None, identity=None):
        return await self.events.enqueue(self.rt, {"request_id": identity or str(uuid.uuid4()), "subscription_id": self.sub["id"],
            "conversation_id": self.rt.conversation_id, "image_ids": selected or []})

    async def test_subscription_verification_identity_refresh_and_rotation(self):
        verification = self.deliveries[0]
        self.assertEqual(json.loads(verification[2])["type"], "verification")
        headers = verification[1]
        message = f'{headers["webhook-id"]}.{headers["webhook-timestamp"]}.'.encode() + verification[2]
        expected = "v1," + base64.b64encode(hmac.new(b"a"*32, message, hashlib.sha256).digest()).decode()
        self.assertEqual(headers["webhook-signature"], expected)
        same = await self.events.subscribe(self.principal, {**self.params, "arguments": {}, "ttlMs": 2500})
        self.assertEqual(same["id"], self.sub["id"])
        self.assertEqual(len(self.deliveries), 1)
        value = await self.events.subscription(self.sub["id"])
        self.assertLessEqual(value["expires"], time.time() + 2.5)
        rotated = {**self.params, "delivery": {**self.params["delivery"], "secret": "whsec_"+base64.b64encode(b"b"*32).decode()}}
        await self.events.subscribe(self.principal, rotated)
        value = await self.events.subscription(self.sub["id"])
        self.assertEqual(len(signed_headers(value, "event", b"{}")['webhook-signature'].split()), 2)
        restart = PluginEvents(self.registry, self.auth)
        self.assertEqual((await restart.status())["subscriptions"][0]["id"], self.sub["id"])

    async def test_invalid_callbacks_secrets_and_verification(self):
        for secret in ["abc", "whsec_!", "whsec_"+base64.b64encode(b"tiny").decode()]:
            with self.assertRaises(EventError):
                await self.events.subscribe(self.principal, {**self.params, "delivery": {**self.params['delivery'], "secret": secret}})
        self.events.verified.clear(); self.status = 302
        with self.assertRaises(EventError) as error:
            await self.events.subscribe(self.principal, self.params)
        self.assertEqual(error.exception.code, -32015)
        self.assertEqual(error.exception.reason, "challenge_failed")
        with self.assertRaises(EventError):
            await self.events.subscribe(self.principal, {**self.params, "arguments": {"unexpected": True}})

    async def test_frozen_snapshot_pagination_dedup_and_owner(self):
        await self.rt.update_transcript("interviewer", "one", "原始题目", "completed")
        for i in range(3):
            self.rt.transcription.history.add_screen(str(i), PNG, "fixture", question_id="")
            self.rt.collected_screens.append(str(i)); self.rt.transcription.visible_images.add(str(i))
        receipt = await self.enqueue(["0", "1", "2"])
        repeated = await self.enqueue(["0", "1", "2"], receipt["id"])
        self.assertEqual(receipt, repeated)
        with self.assertRaises(EventError):
            await self.enqueue([], receipt["id"])
        with self.assertRaises(EventError):
            await self.enqueue([])
        self.rt.collected_screens.clear()
        await self.rt.update_transcript("interviewer", "one", "后来修正", "completed", corrected=True)
        await self.rt.update_transcript("interviewer", "two", "新题目", "completed")
        context = principal_context.set(self.principal)
        try:
            first, pixels = await self.events.read_request(receipt["id"])
            self.assertEqual(len(pixels), 2)
            second, pixels = await self.events.read_request(receipt["id"], first["next_cursor"])
            self.assertEqual(second, (await self.events.read_request(receipt["id"], first["next_cursor"]))[0])
            text = "".join(r.get('text', '') for r in first["records"] + second["records"])
            self.assertEqual(text, "原始题目")
            self.assertFalse(second["has_more"])
            with self.assertRaises(ValueError):
                await self.events.read_request(receipt["id"], str(uuid.uuid4()) + ":0::1")
        finally:
            principal_context.reset(context)
        with self.assertRaises(ValueError):
            await self.events.read_request(receipt["id"])
        with self.registry._store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM conversation_images").fetchone()[0], 1)
            saved = db.execute("SELECT body FROM plugin_event_requests").fetchone()[0]
            self.assertNotIn(PNG, saved)
        await self.events.deliver(receipt["id"])
        self.assertEqual((await self.events.request(receipt["id"]))["status"], "delivered")
        self.assertNotIn("原始题目", self.deliveries[-1][2].decode())

    async def test_followup_incremental_corrections_and_new_session_boundary(self):
        await self.rt.update_transcript("interviewer", "one", "original", "completed")
        first = await self.enqueue(); await self.events.deliver(first["id"])
        await self.rt.update_transcript("interviewer", "one", "corrected", "completed", corrected=True)
        await self.rt.update_transcript("candidate", "two", "followup", "completed")
        second = await self.enqueue()
        context = principal_context.set(self.principal)
        try:
            result, _ = await self.events.read_request(second["id"], after_request_id=first["id"])
            self.assertEqual([r['text'] for r in result['records']], ['corrected', 'followup'])
        finally:
            principal_context.reset(context)
        await self.events.deliver(second['id'])
        from app.services.transcription_buffer import TranscriptionBuffer
        self.rt.transcription = TranscriptionBuffer()
        await self.rt.update_transcript("interviewer", "three", "new session", "completed")
        third = await self.enqueue()
        context = principal_context.set(self.principal)
        try:
            with self.assertRaises(ValueError):
                await self.events.read_request(third['id'], after_request_id=second['id'])
        finally:
            principal_context.reset(context)

    async def test_retry_revocation_expiry_unsubscribe_and_restart(self):
        await self.rt.update_transcript("interviewer", "one", "question", "completed")
        first = await self.enqueue()
        self.status = 503
        await self.events.deliver(first["id"])
        self.assertEqual((await self.events.request(first["id"]))["status"], "queued")
        self.status = 200
        await self.events.deliver(first["id"])
        self.assertEqual(self.deliveries[-1][1]["webhook-id"], self.deliveries[-2][1]["webhook-id"])
        self.assertEqual(self.deliveries[-1][2], self.deliveries[-2][2])
        second = await self.enqueue()
        await self.auth.record("revoked", "grant", {"revoked": True})
        count = len(self.deliveries)
        await self.events.deliver(second["id"])
        self.assertEqual(len(self.deliveries), count)
        self.assertEqual((await self.events.status())["subscriptions"], [])
        await self.auth.record("revoked", "grant", pop=True)
        third = await self.enqueue()
        await self.events.unsubscribe(self.principal, self.params)
        await self.events.unsubscribe(self.principal, self.params)
        await self.events.deliver(third["id"])
        self.assertEqual((await self.events.request(third['id']))['status'], 'cancelled')
        await self.events.subscribe(self.principal, self.params)
        fourth = await self.enqueue()
        await self.events.start()
        self.assertEqual((await self.events.request(fourth['id']))['status'], 'interrupted')
        await self.events.close()
        self.assertEqual(len(self.deliveries), count)

    async def test_terminal_delivery_errors_never_retry(self):
        await self.rt.update_transcript("interviewer", "one", "question", "completed")
        for status in (413, 400, 410):
            request = await self.enqueue()
            self.status = status
            await self.events.deliver(request['id'])
            count = len(self.deliveries)
            await self.events.deliver(request['id'])
            self.assertEqual(count, len(self.deliveries))
            self.assertEqual((await self.events.request(request['id']))['status'], 'failed')
        self.assertEqual((await self.events.status())['subscriptions'], [])


class WebhookNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_socket_uses_validated_ip_and_rejects_mixed_dns(self):
        backend = PublicNetworkBackend()
        backend.backend = AsyncMock()
        loop = asyncio.get_running_loop()
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=public)):
            await backend.connect_tcp('receiver.example', 443)
        self.assertEqual(backend.backend.connect_tcp.call_args.args[:2], ('8.8.8.8', 443))
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=public + [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))])):
            with self.assertRaises(CallbackError):
                await backend.connect_tcp('receiver.example', 443)
        self.assertEqual(backend.backend.connect_tcp.call_count, 1)
        for ip in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fe80::1']:
            self.assertFalse(backend.public_ip(ip), ip)
        for url in ['http://example.com', 'https://a@b.com', 'https://example.com:444/a', 'https://example.com/#secret', 'https://example.com/\n']:
            with self.assertRaises(CallbackError): callback_url(url)


class EventProtocolTests(unittest.TestCase):
    def setUp(self):
        from app.main import app, plugin_auth
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY': '', 'OPENAI_BASE_URL': 'http://127.0.0.1:1/v1',
            'INTERVIEW_WORKSPACE_HISTORY_DIR': self.directory.name, 'INTERVIEW_ACCESS_TOKEN': 'protocol-fixture'})
        self.env.start()
        self.registry = InterviewRegistry()
        self.registry_patch = patch('app.services.openai_realtime._registry', self.registry); self.registry_patch.start()
        self.client = TestClient(app, base_url=ORIGIN); self.client.__enter__()
        self.client.portal.call(app.state.plugin_events.close)
        self.rt = self.client.portal.call(self.registry.create)
        self.events = app.state.plugin_events
        async def sender(url, headers, body):
            return 200, json.dumps({'challenge': json.loads(body).get('challenge')}).encode()
        self.events.sender = sender
        self.auth = plugin_auth
        tokens = self.client.portal.call(plugin_auth.issue, 'fixture-client', 'fixture-grant')
        self.headers = {'Authorization': 'Bearer '+tokens.access_token, 'MCP-Protocol-Version': '2026-07-28'}

    def tearDown(self):
        self.client.__exit__(None, None, None); self.registry_patch.stop(); self.env.stop(); self.directory.cleanup()

    def rpc(self, method, params=None, headers=None):
        return self.client.post('/mcp', headers=self.headers if headers is None else headers,
            json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}})

    def test_authenticated_discovery_events_tools_and_capture_endpoint(self):
        self.assertEqual(self.rpc('server/discover', headers={}).status_code, 401)
        self.assertEqual(self.rpc('server/discover').json()['result']['capabilities'], {'tools': {}, 'events': {}})
        self.assertEqual(self.rpc('events/list').json()['result']['events'][0]['name'], EVENT)
        self.assertEqual(len(self.rpc('tools/list').json()['result']['tools']), 4)
        params = {'name': EVENT, 'arguments': {}, 'delivery': {'mode': 'webhook', 'url': 'https://example.com/callback', 'secret': SECRET}}
        subscription = self.rpc('events/subscribe', params).json()['result']['id']
        path = '/api/interviews/'+self.rt.interview_id+'/chatgpt-events'
        self.assertEqual(self.client.get(path, headers=self.headers).status_code, 401)
        capture = {'Authorization': 'Bearer '+self.rt.capture_token}
        status = self.client.get(path, headers=capture).json()
        self.assertEqual(status['subscriptions'][0]['id'], subscription)
        self.assertNotIn(SECRET, json.dumps(status))
        self.client.portal.call(self.rt.update_transcript, 'interviewer', 'question', 'test question', 'completed')
        identity = str(uuid.uuid4())
        payload = {'request_id': identity, 'subscription_id': subscription, 'conversation_id': self.rt.conversation_id, 'image_ids': []}
        trigger = self.client.post(path, json=payload, headers=capture)
        self.assertEqual(trigger.status_code, 202, trigger.text)
        admin = {'Authorization': 'Bearer protocol-fixture'}
        self.assertTrue(self.client.get('/api/deployment', headers=admin).json()['active'])
        self.assertEqual(self.client.post('/api/deployment', headers=admin).status_code, 409)
        read = self.rpc('tools/call', {'name': 'read_interview', 'arguments': {'request_id': identity}}).json()['result']
        self.assertFalse(read['isError'], read)
        self.assertEqual(json.loads(read['content'][0]['text'])['records'][0]['text'], 'test question')
        # The same tool and OAuth scope still work for legacy SDK clients.
        legacy = self.rpc('tools/call', {'name': 'read_interview', 'arguments': {'request_id': identity}},
            headers={**self.headers, 'MCP-Protocol-Version': '2025-03-26', 'Accept': 'application/json, text/event-stream'})
        self.assertFalse(legacy.json()['result']['isError'], legacy.text)
        self.assertEqual(self.client.delete(path+'/'+identity, headers=capture).json()['status'], 'cancelled')
        notification = self.client.post('/mcp', headers=self.headers, json={'jsonrpc': '2.0', 'method': 'events/unsubscribe', 'params': params})
        self.assertEqual(notification.status_code, 202)
        self.assertEqual(len(self.client.get(path, headers=capture).json()['subscriptions']), 1)
        self.assertNotIn('error', self.rpc('events/unsubscribe', params).json())
        self.assertEqual(self.client.get(path, headers=capture).json()['subscriptions'], [])

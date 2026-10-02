from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app.services import openai_realtime as rt
from app.services.upstream_errors import provider_error
from tests.test_realtime import FakeEventStream, FakeUpstream, make_runtime


class ProviderErrors(unittest.TestCase):
    def test_quota_codes_are_actionable_without_echoing_private_provider_data(self):
        for code, expected in (("credit_balance_exhausted", "额度已耗尽"), ("insufficient_quota", "配额不足")):
            with self.subTest(code=code):
                exc = provider_error({"error": {"code": code, "message": "secret-key-and-private-resume"}}, fallback="Rejected.")
                detail = rt._safe_error_detail(exc)
                self.assertIn(expected, detail)
                self.assertNotIn("secret", detail)

    def test_unrecognized_error_content_never_becomes_public_text(self):
        for event in ({"error": "secret-key"}, {"error": {"code": "secret-key", "message": "private-resume"}}, {}):
            self.assertEqual(str(provider_error(event, fallback="Rejected safely.")), "Rejected safely.")


class ProviderHandshakeErrors(unittest.IsolatedAsyncioTestCase):
    async def test_failed_start_is_not_left_connecting_and_explains_quota(self):
        for channel in ("main", "candidate"):
            with self.subTest(channel=channel):
                runtime = make_runtime()
                runtime.active = True
                upstream = FakeUpstream()
                upstream.queue.put_nowait('{"type":"error","error":{"code":"credit_balance_exhausted","message":"private-secret"}}')
                try:
                    with patch.object(rt, "_connect_openai_realtime", AsyncMock(return_value=upstream)):
                        with self.assertRaises(RuntimeError):
                            await (runtime.ensure_main() if channel == "main" else runtime.ensure_candidate())
                    self.assertTrue(upstream.closed)
                    self.assertEqual(runtime._model_status["status"], "recovering")
                    self.assertIn("额度已耗尽", runtime._model_status["detail"])
                    self.assertNotIn("private", runtime._model_status["detail"])
                finally:
                    await runtime.close()

    async def test_initial_connect_is_not_reported_as_recovery(self):
        runtime = make_runtime()
        try:
            await runtime.update_model_status("main", "connecting", "Starting Live")
            self.assertEqual(runtime._model_status["status"], "connecting")
            await runtime.update_model_status("candidate", "connecting", "Starting ASR")
            await runtime.update_model_status("main", "ready", "Live ready")
            self.assertEqual(runtime._model_status["status"], "connecting")
            await runtime.update_model_status("candidate", "ready", "ASR ready")
            self.assertEqual(runtime._model_status["status"], "ready")
            await runtime.update_model_status("main", "recovering", "Lost connection")
            await runtime.update_model_status("candidate", "connecting", "Starting ASR")
            self.assertEqual(runtime._model_status["status"], "recovering")
        finally:
            await runtime.close()

    async def test_candidate_quota_failure_retains_safe_actionable_reason(self):
        upstream = FakeEventStream([{"type": "error", "error": {"code": "credit_balance_exhausted", "message": "secret-key"}}])
        with self.assertRaises(rt.OpenAIRealtimeError) as caught:
            await rt._wait_transcription_ready(upstream)
        self.assertIn("额度已耗尽", rt._safe_error_detail(caught.exception))
        self.assertNotIn("secret", rt._safe_error_detail(caught.exception))

    async def test_main_quota_failure_retains_safe_actionable_reason(self):
        runtime = make_runtime()
        upstream = FakeUpstream()
        upstream.queue.put_nowait('{"type":"error","error":{"code":"credit_balance_exhausted","message":"secret-key"}}')
        try:
            with self.assertRaises(RuntimeError) as caught:
                await rt._wait_transcription_ready(upstream)
            self.assertIn("额度已耗尽", rt._safe_error_detail(caught.exception))
            self.assertNotIn("secret", rt._safe_error_detail(caught.exception))
        finally:
            await runtime.close()

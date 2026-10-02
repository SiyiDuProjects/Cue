from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.services.context_store import ContextStore
from app.services import openai_realtime as rt


class Upstream:
    def __init__(self):
        self.messages = []
        self.events = asyncio.Queue()
        self.closed = False

    async def send(self, data):
        event = json.loads(data)
        self.messages.append(event)
        if event["type"] == "session.start":
            self.events.put_nowait({"type": "session.started"})
        elif event["type"] == "session.update":
            self.events.put_nowait({"type": "session.updated"})

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.events.get()
        if item is None:
            raise StopAsyncIteration
        return json.dumps(item)

    async def close(self):
        self.closed = True
        self.events.put_nowait(None)


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.001)


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        Path(self.directory.name, "background.md").write_text("COMPLETE_BACKGROUND", encoding="utf-8")
        self.runtime = rt.InterviewRuntime(interview_id="test", session_token="session", capture_token="capture",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1), context_store=ContextStore(Path(self.directory.name)))
        self.runtime.active = True
        self.upstream = Upstream()
        self.runtime.main_upstream = self.upstream
        self.client_events = []
        self.runtime.broadcast_to_clients = AsyncMock(side_effect=self.client_events.append)
        self.reader = asyncio.create_task(rt._forward_main_events(self.runtime, self.upstream))
        self.runtime._main_reader_task = self.reader

    async def asyncTearDown(self):
        await self.runtime.close()
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)
        self.directory.cleanup()

    def event(self, **event):
        self.upstream.events.put_nowait(event)

    async def test_capture_disconnect_closes_only_its_upstream_and_keeps_history(self):
        from tests.test_realtime import FakeClientWebSocket
        candidate = Upstream()
        self.runtime.candidate_upstream = candidate
        await self.runtime.remember_dialogue("interviewer", "Keep this question")
        socket = FakeClientWebSocket({"type": "authenticate", "token": "capture"})
        await self.runtime.serve(socket, "candidate")
        self.assertTrue(candidate.closed)
        self.assertFalse(self.upstream.closed)
        self.assertTrue(self.runtime.active)
        self.assertEqual(self.runtime.question_text(), "Keep this question")
        self.assertIsNone(self.runtime.candidate_upstream)

    async def test_replacement_capture_prevents_old_disconnect_cleanup_from_closing_upstream(self):
        self.runtime._capture_clients["interviewer"] = object()
        await self.runtime._release_upstream("main", self.upstream, retry=False, without_capture="interviewer")
        self.assertFalse(self.upstream.closed)
        self.assertIs(self.runtime.main_upstream, self.upstream)
        self.runtime._capture_clients.clear()

    async def test_terminal_track_failure_releases_model_without_ending_room(self):
        from tests.test_realtime import FakeSocket
        capture = FakeSocket()
        self.runtime._capture_clients["interviewer"] = capture
        await self.runtime.mark_capture_status("interviewer", capture, {"phase": "error", "detail": "track ended"})
        self.assertTrue(self.upstream.closed)
        self.assertIsNone(self.runtime.main_upstream)
        self.assertTrue(self.runtime.active)
        self.assertIs(self.runtime._capture_clients["interviewer"], capture)
        self.runtime._capture_clients.clear()

    async def test_slow_audio_provider_keeps_bounded_recent_speech_and_capture_controls(self):
        from tests.test_realtime import FakeSocket
        class Capture(FakeSocket):
            def __init__(self):
                super().__init__()
                self.incoming = asyncio.Queue()
            async def receive(self):
                return await self.incoming.get()
        capture = Capture()
        started, unblock = asyncio.Event(), asyncio.Event()
        delivered = []
        async def slow_send(upstream, data, **kwargs):
            delivered.append(data)
            if data == b"first":
                started.set()
                await unblock.wait()
        mark = AsyncMock()
        with patch.object(rt, "_send_audio_append", slow_send), patch.object(self.runtime, "mark_capture_status", mark):
            receiver = asyncio.create_task(rt._forward_capture_controls(self.runtime, capture, "interviewer"))
            try:
                capture.incoming.put_nowait({"type": "websocket.receive", "bytes": b"first"})
                await asyncio.wait_for(started.wait(), 1)
                for index in range(100):
                    capture.incoming.put_nowait({"type": "websocket.receive", "bytes": bytes([index]) * 2048})
                capture.incoming.put_nowait({"type": "websocket.receive", "text": json.dumps({"type": "capture_status", "phase": "ready"})})
                await until(lambda: mark.await_count == 1)
                self.assertEqual(delivered, [b"first"])
                self.assertEqual(self.runtime.metrics["audio_gaps"], 1)
                unblock.set()
                await asyncio.sleep(0)
                capture.incoming.put_nowait({"type": "websocket.receive", "bytes": b"fresh"})
                await until(lambda: b"fresh" in delivered)
                self.assertEqual(delivered[0], b"first")
                self.assertEqual(delivered[-1], b"fresh")
                self.assertLessEqual(len(delivered), 13)
                self.assertNotIn(bytes([0]) * 2048, delivered)
                capture.incoming.put_nowait({"type": "websocket.disconnect"})
                await receiver
            finally:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)

    async def test_frame_held_during_long_provider_startup_is_not_replayed(self):
        from tests.test_realtime import FakeSocket
        incoming = asyncio.Queue()
        capture = FakeSocket()
        capture.receive = incoming.get
        entered, connected = asyncio.Event(), asyncio.Event()
        async def connect():
            entered.set()
            await connected.wait()
            return self.upstream
        send_audio = AsyncMock()
        now = [100.0]
        with patch.object(self.runtime, "ensure_main", connect), patch.object(rt, "_send_audio_append", send_audio), \
                patch.object(rt, "time", SimpleNamespace(monotonic=lambda: now[0])):
            receiver = asyncio.create_task(rt._forward_capture_controls(self.runtime, capture, "interviewer"))
            try:
                incoming.put_nowait({"type": "websocket.receive", "bytes": b"old"})
                await entered.wait()
                now[0] = 101
                connected.set()
                await asyncio.sleep(0)
                send_audio.assert_not_awaited()
                self.assertEqual(self.runtime.metrics["audio_gaps"], 1)
                incoming.put_nowait({"type": "websocket.disconnect"})
                await receiver
            finally:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)

    async def test_end_cancels_inflight_audio_connection_without_waiting_for_handshake(self):
        from tests.test_realtime import FakeSocket
        capture = FakeSocket()
        incoming = asyncio.Queue()
        capture.receive = incoming.get
        entered = asyncio.Event()
        async def connect():
            entered.set()
            await asyncio.Future()
        with patch.object(self.runtime, "ensure_candidate", connect):
            receiver = asyncio.create_task(rt._forward_capture_controls(self.runtime, capture, "candidate"))
            try:
                incoming.put_nowait({"type": "websocket.receive", "bytes": b"pending"})
                await entered.wait()
                await asyncio.wait_for(self.runtime.close(), 1)
                self.assertFalse(self.runtime._audio_tasks)
            finally:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)


    async def test_transcription_handshake_timeout_closes_only_candidate(self):
        candidate = Upstream()
        candidate.send = AsyncMock()
        with patch.object(rt, "_connect_openai_realtime", AsyncMock(return_value=candidate)), \
                patch.object(rt, "TRANSCRIPTION_START_TIMEOUT_SECONDS", .01):
            with self.assertRaises(TimeoutError):
                await self.runtime.ensure_candidate()
        self.assertTrue(candidate.closed)
        self.assertIsNone(self.runtime.candidate_upstream)
        self.assertIs(await self.runtime.ensure_main(), self.upstream)

    async def test_ending_interview_during_transcription_handshake_cannot_publish_a_new_connection(self):
        candidate = Upstream()
        candidate.send = AsyncMock()
        with patch.object(rt, "_connect_openai_realtime", AsyncMock(return_value=candidate)):
            connecting = asyncio.create_task(self.runtime.ensure_candidate())
            await until(lambda: candidate.send.await_count == 1)
            closing = asyncio.create_task(self.runtime.close())
            try:
                await until(lambda: self.runtime.closed)
                candidate.events.put_nowait({"type": "session.updated"})
                with self.assertRaises(rt.OpenAIRealtimeError):
                    await asyncio.wait_for(connecting, 1)
                await asyncio.wait_for(closing, 1)
                self.assertTrue(candidate.closed)
                self.assertIsNone(self.runtime.candidate_upstream)
                self.assertIsNone(self.runtime._candidate_reader_task)
            finally:
                connecting.cancel()
                closing.cancel()
                await asyncio.gather(connecting, closing, return_exceptions=True)

    async def test_transcription_waits_for_configuration_acceptance_before_audio(self):
        candidate = Upstream()
        candidate.send = AsyncMock()
        with patch.object(rt, "_connect_openai_realtime", AsyncMock(return_value=candidate)):
            connecting = asyncio.create_task(self.runtime.ensure_candidate())
            try:
                await until(lambda: candidate.send.await_count == 1)
                self.assertFalse(connecting.done())
                self.assertIsNone(self.runtime.candidate_upstream)
                candidate.events.put_nowait({"type": "session.created"})
                candidate.events.put_nowait({"type": "session.updated"})
                self.assertIs(await asyncio.wait_for(connecting, 1), candidate)
                self.assertEqual(self.runtime._model_channels["candidate"]["status"], "ready")
            finally:
                connecting.cancel()
                await asyncio.gather(connecting, return_exceptions=True)

    async def test_transcription_rejection_is_closed_and_retry_is_delayed(self):
        candidate = Upstream()
        candidate.send = AsyncMock()
        candidate.events.put_nowait({"type": "error", "error": {"message": "SYNTHETIC_PRIVATE_ERROR"}})
        with patch.object(rt, "_connect_openai_realtime", AsyncMock(return_value=candidate)) as connect:
            with self.assertRaises(rt.OpenAIRealtimeError) as caught:
                await self.runtime.ensure_candidate()
            self.assertNotIn("SYNTHETIC_PRIVATE_ERROR", str(caught.exception))
            self.assertTrue(candidate.closed)
            self.assertIsNone(self.runtime.candidate_upstream)
            with self.assertRaises(rt.OpenAIRealtimeError):
                await self.runtime.ensure_candidate()
            self.assertEqual(connect.await_count, 1)

    async def test_repeated_immediate_disconnects_back_off_instead_of_reconnecting_per_audio_frame(self):
        for failure in range(3):
            candidate = Upstream()
            self.runtime._candidate_retry_after = 0
            with patch.object(rt, "_connect_openai_realtime", AsyncMock(return_value=candidate)):
                await self.runtime.ensure_candidate()
            before = time.monotonic()
            await self.runtime._release_upstream("candidate", candidate)
            self.assertEqual(self.runtime._candidate_failures, failure + 1)
            self.assertGreaterEqual(self.runtime._candidate_retry_after - before, 2 ** failure)
            with patch.object(rt, "_connect_openai_realtime", AsyncMock()) as connect:
                with self.assertRaises(rt.OpenAIRealtimeError):
                    await self.runtime.ensure_candidate()
                connect.assert_not_awaited()


    async def test_candidate_connect_does_not_block_healthy_main_audio(self):
        entered, release = asyncio.Event(), asyncio.Event()
        candidate = Upstream()
        async def connect(**kwargs):
            entered.set()
            await release.wait()
            return candidate
        with patch.object(rt, "_connect_openai_realtime", connect):
            connecting = asyncio.create_task(self.runtime.ensure_candidate())
            try:
                await entered.wait()
                main = await asyncio.wait_for(self.runtime.ensure_main(), .1)
                await rt._send_audio_append(main, b"audio")
                self.assertEqual(main.messages[-1]["type"], "input_audio_buffer.append")
            finally:
                release.set()
                await connecting

    async def test_slow_main_reconnect_does_not_block_candidate_transcription_connection(self):
        await self.runtime.reset_main("test")
        entered, release = asyncio.Event(), asyncio.Event()
        main, candidate = Upstream(), Upstream()
        async def connect(*, kind):
            if kind == "main":
                entered.set()
                await release.wait()
                return main
            return candidate
        with patch.object(rt, "_connect_openai_realtime", connect):
            connecting = asyncio.create_task(self.runtime.ensure_main())
            try:
                await entered.wait()
                self.assertIs(await asyncio.wait_for(self.runtime.ensure_candidate(), .1), candidate)
            finally:
                release.set()
                await connecting

    async def test_dropped_ui_connection_is_closed_so_it_can_reconnect(self):
        from tests.test_realtime import FakeClientWebSocket, attach_ui
        stale, healthy = FakeClientWebSocket({}), FakeClientWebSocket({})
        stale.send_json = AsyncMock(side_effect=TimeoutError())
        attach_ui(self.runtime, stale, "stale")
        attach_ui(self.runtime, healthy, "healthy")
        await self.runtime._broadcast_clients_locked({"type": "test"})
        async with asyncio.timeout(1):
            while not stale.closed_codes:
                await asyncio.sleep(0)
        self.assertEqual(stale.closed_codes, [1013])
        self.assertEqual(healthy.messages[-1], {"type": "test"})
        self.assertIn(healthy, self.runtime._ui_clients.values())








    async def test_muted_channel_remains_ready_and_preserves_phase_in_public_snapshot(self):
        socket = object()
        self.runtime._capture_clients["candidate"] = socket
        self.runtime._capture_ready.add("candidate")
        await self.runtime.mark_capture_status("candidate", socket, {"phase": "muted", "detail": "source muted"})
        state = await self.runtime.public_state()
        self.assertTrue(state["device_status"]["channels"]["candidate"])
        self.assertEqual(state["device_status"]["channel_details"]["candidate"]["phase"], "muted")
        self.runtime._capture_clients.clear()



    async def test_main_recovery_does_not_hide_failed_candidate_connection(self):
        await self.runtime.update_model_status("candidate", "recovering", "Candidate context unavailable")
        await self.runtime.update_model_status("main", "ready", "Main connected")
        self.assertEqual(self.runtime._model_status["status"], "recovering")
        self.assertIn("Candidate context unavailable", self.runtime._model_status["detail"])
        await self.runtime.update_model_status("candidate", "ready", "Candidate connected")
        self.assertEqual(self.runtime._model_status["status"], "ready")



if __name__ == "__main__":
    unittest.main()

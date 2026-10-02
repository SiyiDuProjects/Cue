from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from app.services import openai_realtime as rt
from tests.test_realtime import FakeSocket, FakeUpstream, make_runtime, attach_ui


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


class MockInterviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = make_runtime("mock-test")
        self.ui = FakeSocket()
        attach_ui(self.runtime, self.ui)
        self.host = FakeSocket()
        self.runtime._capture_clients = {"interviewer": self.host, "candidate": FakeSocket()}
        self.runtime._capture_ready = {"interviewer", "candidate"}
        self.connections = []

        async def connect(*, kind):
            socket = FakeUpstream()
            self.connections.append((kind, socket))
            return socket

        self.connection_patch = patch.object(rt, "_connect_openai_realtime", side_effect=connect)
        self.connection_patch.start()

    async def asyncTearDown(self):
        await self.runtime.close()
        self.connection_patch.stop()
        self.assertTrue(all(socket.closed for _, socket in self.connections))

    async def start_mock(self):
        await self.runtime.mark_capture_status("interviewer", self.host, {"phase": "ready", "mode": "mock"})
        await self.runtime.start_transcription(self.ui, "mock")
        await until(lambda: self.runtime.mock.status in {"ready", "error"})
        self.assertEqual(self.runtime.mock.status, "ready")
        return self.runtime.mock.socket

    async def test_assist_still_starts_without_extra_upstream_and_cannot_change_live_mode(self):
        await self.runtime.start_transcription(self.ui)
        self.assertFalse(self.connections)
        await self.runtime.start_transcription(self.ui, "mock")
        self.assertEqual(self.runtime.mode, "assist")
        self.assertFalse(self.connections)

    async def test_mock_requires_explicit_virtual_audio_readiness(self):
        await self.runtime.start_transcription(self.ui, "mock")
        self.assertFalse(self.runtime.active)
        self.assertFalse(self.connections)
        self.assertEqual(self.host.messages[-1], {"type": "prepare_capture", "mode": "mock"})

    async def test_mock_live_and_two_transcribers_are_owned_by_one_runtime(self):
        await self.start_mock()
        self.assertEqual([kind for kind, _ in self.connections].count("main"), 1)
        self.assertEqual([kind for kind, _ in self.connections].count("mock"), 1)
        self.assertEqual([kind for kind, _ in self.connections].count("candidate"), 1)
        original = self.runtime.mock.task
        await self.runtime.start_transcription(self.ui, "mock")
        self.assertIs(self.runtime.mock.task, original)
        self.assertEqual(len(self.connections), 3)

    async def test_mock_startup_accepts_real_websocket_iterable_contract(self):
        class IterableSocket:
            def __init__(self):
                self.socket = FakeUpstream()

            def __getattr__(self, name):
                return getattr(self.socket, name)

            def __aiter__(self):
                async def events():
                    async for raw in self.socket:
                        yield raw
                return events()

        async def connect(*, kind):
            socket = IterableSocket()
            self.connections.append((kind, socket))
            return socket

        with patch.object(rt, "_connect_openai_realtime", side_effect=connect):
            await self.start_mock()
        self.assertEqual(len(self.connections), 3)

    async def test_interviewer_never_receives_copilot_answers_screens_or_unsubmitted_code(self):
        self.runtime.transcription.history.add_turn("candidate", "ACTUAL_SPOKEN_REPLY")
        self.runtime.history.add_answer("private-hint", "q")
        self.runtime.response_buffers["private-hint"] = "PRIVATE_COACH_HINT"
        self.runtime.code_workspace.publish({"title": "Private", "files": [{"filename": "main.py", "code": "PRIVATE_UNSUBMITTED_CODE", "language": "python"}]})
        self.runtime.history.add_screen("screen", "PRIVATE_SCREEN", "PRIVATE_SCREEN_SUMMARY", question_id="q")
        socket = await self.start_mock()
        serialized = json.dumps(socket.messages)
        self.assertIn("ACTUAL_SPOKEN_REPLY", serialized)
        for private in ("PRIVATE_COACH_HINT", "PRIVATE_UNSUBMITTED_CODE", "PRIVATE_SCREEN"):
            self.assertNotIn(private, serialized)
        config = socket.messages[0]["session"]
        self.assertFalse(config["store"])
        self.assertEqual(config["delegation"]["responses"]["tools"], [])

    async def test_audio_only_goes_to_capture_host_and_not_browser_or_answer_history(self):
        socket = await self.start_mock()
        await socket.queue.put(json.dumps({"type": "session.output_audio.delta", "delta": "AAAA"}))
        await until(lambda: any(m.get("type") == "mock_audio" for m in self.host.messages))
        self.assertFalse(any(m.get("type") == "mock_audio" for m in self.ui.messages))
        self.assertFalse(self.runtime.response_order)
        await self.runtime.mock.feed(b"\x00\x00" * 10)
        await until(lambda: any(m.get("type") == "session.input_audio.append" for m in socket.messages))
        self.assertEqual(socket.messages[-1]["type"], "session.input_audio.append")

    async def test_mock_failure_retains_helper_and_history_and_explicit_restart_isolated(self):
        socket = await self.start_mock()
        self.runtime.transcription.history.add_turn("candidate", "Keep my reply")
        await socket.queue.put(None)
        await self.runtime.mock.task
        self.assertEqual(self.runtime.mock.status, "error")
        self.assertFalse(self.runtime.main_upstream.closed)
        self.assertTrue(self.runtime.active)
        self.assertEqual(self.host.messages[-1]["type"], "mock_audio_reset")
        self.runtime.mock.start()
        await until(lambda: self.runtime.mock.status == "ready")
        self.assertIsNot(self.runtime.mock.socket, socket)
        self.assertIn("Keep my reply", json.dumps(self.runtime.mock.socket.messages))

    async def test_capture_failure_stops_mock_without_erasing_history(self):
        socket = await self.start_mock()
        self.runtime.transcription.history.add_turn("candidate", "Retained")
        await self.runtime.mark_capture_status("candidate", self.runtime._capture_clients["candidate"], {"phase": "error"})
        self.assertTrue(socket.closed)
        self.assertEqual(self.runtime.mock.status, "error")
        self.assertTrue(self.runtime.recent_dialogue)

    async def test_audio_backpressure_drops_old_frames_without_stopping_mock(self):
        socket = await self.start_mock()
        entered, release = asyncio.Event(), asyncio.Event()
        async def stalled(_):
            entered.set()
            await release.wait()
        socket.send = stalled
        with patch.object(rt, "MAX_QUEUED_AUDIO_BYTES", 4):
            await self.runtime.mock.feed(b"00")
            await entered.wait()
            for data in (b"11", b"22", b"33", b"44"):
                await self.runtime.mock.feed(data)
            self.assertEqual(self.runtime.metrics["audio_gaps"], 1)
            self.assertEqual(self.runtime.mock.status, "ready")
            self.assertFalse(socket.closed)
            self.assertEqual([frame[0] for frame in self.runtime.mock.audio.frames], [b"33", b"44"])
            release.set()

    async def test_interrupted_capture_keeps_mock_but_substantive_barge_in_clears_audio(self):
        socket = await self.start_mock()
        await self.runtime.mark_capture_status("candidate", self.runtime._capture_clients["candidate"], {"phase": "interrupted"})
        self.assertFalse(socket.closed)
        with patch("app.services.mock_interviewer.BARGE_IN_SECONDS", .01):
            self.runtime.mock._watch_barge_in("Yes")
            self.assertIsNone(self.runtime.mock.barge_in)
            self.runtime.mock._watch_barge_in("Can I clarify the question?")
            await self.runtime.mock.barge_in
        self.assertEqual(self.host.messages[-1]["type"], "mock_audio_reset")
        self.assertEqual(self.runtime.mock.status, "ready")

    async def test_audio_send_failure_stops_mock_and_closes_socket(self):
        socket = await self.start_mock()
        async def stalled(_):
            raise OSError("synthetic send failure")
        socket.send = stalled
        await self.runtime.mock.feed(b"\x00\x00")
        await self.runtime.mock.feed(b"\x00\x00")
        await asyncio.wait_for(self.runtime.mock.task, 1)
        self.assertTrue(socket.closed)
        self.assertEqual(self.runtime.mock.status, "error")
        self.assertTrue(any(m.get("type") == "mock_status" and m.get("status") == "error" for m in self.ui.messages))

    async def test_ending_closes_interviewer_without_late_audio(self):
        socket = await self.start_mock()
        await self.runtime.close()
        await self.runtime.mock.feed(b"\x00\x00")
        self.assertIsNone(self.runtime.mock.socket)
        self.assertTrue(socket.closed)
        self.assertFalse(self.runtime.active)

    async def test_end_during_mock_startup_cannot_leave_a_third_connection(self):
        from app.services import mock_interviewer
        original = mock_interviewer.send
        waiting = asyncio.Event()
        async def delay(socket, payload):
            if payload.get("type") == "session.start":
                waiting.set()
                await asyncio.sleep(30)
            await original(socket, payload)
        self.runtime.capture_mode = "mock"
        with patch.object(mock_interviewer, "send", side_effect=delay):
            await self.runtime.start_transcription(self.ui, "mock")
            await asyncio.wait_for(waiting.wait(), 2)
            await asyncio.wait_for(self.runtime.close(), 2)
        self.assertIsNone(self.runtime.mock.socket)
        self.assertTrue(all(socket.closed for _, socket in self.connections))
        self.assertFalse(any(m.get("type") == "mock_audio" for m in self.host.messages))

    async def test_code_is_shared_only_at_explicit_saved_revision_and_recovers_separately(self):
        socket = await self.start_mock()
        doc = self.runtime.code_workspace
        doc.publish({"title": "Submitted", "files": [{"filename": "main.py", "code": "print('submitted')", "language": "python"}]})
        self.assertFalse(await self.runtime.mock.share_code("main.py", doc.revision + 1))
        self.assertNotIn("print('submitted')", json.dumps(socket.messages))
        self.assertTrue(await self.runtime.mock.share_code("main.py", doc.revision))
        count = len(socket.messages)
        self.assertTrue(await self.runtime.mock.share_code("main.py", doc.revision))
        self.assertEqual(len(socket.messages), count)
        doc.publish({"title": "New", "files": [{"filename": "main.py", "code": "NEW_UNSUBMITTED_CODE", "language": "python"}]})
        await socket.queue.put(None)
        await self.runtime.mock.task
        self.runtime.mock.start()
        await until(lambda: self.runtime.mock.status == "ready")
        messages = json.dumps(self.runtime.mock.socket.messages)
        self.assertIn("print('submitted')", messages)
        self.assertNotIn("NEW_UNSUBMITTED_CODE", messages)

    async def test_submission_explains_pinned_code_is_not_proof_of_external_editor(self):
        socket = await self.start_mock()
        doc = self.runtime.code_workspace
        doc.publish({"title": "Reference", "files": [{"filename": "service.py", "code": "def run(): pass", "language": "python"}]})
        self.assertTrue(await self.runtime.mock.share_code("service.py", doc.revision))
        self.assertEqual(self.runtime.mock.submissions[-1]["filename"], "service.py")
        self.assertIn("pinned reference answer", json.dumps(socket.messages))
        self.assertIn("does not prove the external editor", json.dumps(socket.messages))

    async def test_explicit_submission_addresses_a_pinned_file_at_its_exact_revision(self):
        socket = await self.start_mock()
        workspace = self.runtime.code_workspace
        workspace.publish({"title": "Service", "files": [{"filename": "service.py", "code": "class Service: pass", "language": "python"}]})
        self.assertFalse(await self.runtime.mock.share_code("service.py", workspace.revision - 1))
        self.assertFalse(await self.runtime.mock.share_code("proposed-only-file", 0))
        self.assertTrue(await self.runtime.mock.share_code("service.py", workspace.revision))
        self.assertEqual(self.runtime.mock.submissions[-1]["filename"], "service.py")
        self.assertIn("class Service: pass", json.dumps(socket.messages))

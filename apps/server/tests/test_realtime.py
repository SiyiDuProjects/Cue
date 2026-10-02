from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.config import get_settings
from app.services.context_store import ContextStore
from app.services.openai_realtime import (
    InterviewRuntime,
    OpenAIRealtimeError,
    _begin_response,
    _forward_capture_controls,
    _forward_ui_controls,
    _emit_terminal,
    _request_current_screen,
    _resolve_screen_snapshot,
    _send_transcription_session_update,
    _validate_image_data_url,
)


PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nminimal").decode("ascii")


class FakeUpstream:
    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.closed = False

    async def send(self, payload: str) -> None:
        event = json.loads(payload)
        self.messages.append(event)
        if event["type"] == "session.start":
            self.queue.put_nowait(json.dumps({"type": "session.started"}))
        elif event["type"] == "session.update":
            self.queue.put_nowait(json.dumps({"type": "session.updated"}))

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def close(self) -> None:
        self.closed = True
        self.queue.put_nowait(None)




class FakeEventStream:
    def __init__(self, events: list[dict]) -> None:
        self.events = [json.dumps(event) for event in events]

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        if not self.events:
            raise StopAsyncIteration
        return self.events.pop(0)


class FakeSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.messages.append(payload)


class FakeClientWebSocket(FakeSocket):
    def __init__(self, authentication: dict, controls: list[dict] | None = None) -> None:
        super().__init__()
        self.authentication = authentication
        self.controls = list(controls or [{"type": "websocket.disconnect"}])
        self.accepted = False
        self.closed_codes: list[int] = []
        self.receive_count = 0

    async def accept(self) -> None:
        self.accepted = True

    async def receive_json(self) -> dict:
        return self.authentication

    async def receive(self) -> dict:
        self.receive_count += 1
        return self.controls.pop(0)

    async def close(self, *, code: int) -> None:
        self.closed_codes.append(code)


class FailingSocket(FakeSocket):
    async def send_json(self, payload: dict) -> None:
        raise RuntimeError("client disconnected")


class StreamingClientWebSocket(FakeSocket):
    def __init__(self, authentication: dict) -> None:
        super().__init__()
        self.authentication = authentication
        self.controls: asyncio.Queue[dict] = asyncio.Queue()
        self.snapshot_sent = asyncio.Event()
        self.accepted = False
        self.closed_codes: list[int] = []

    async def accept(self) -> None:
        self.accepted = True

    async def receive_json(self) -> dict:
        return self.authentication

    async def receive(self) -> dict:
        return await self.controls.get()

    async def send_json(self, payload: dict) -> None:
        await super().send_json(payload)
        if payload.get("type") == "answer_snapshot":
            self.snapshot_sent.set()

    async def close(self, *, code: int) -> None:
        self.closed_codes.append(code)


class FakeHTTPResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"status": "completed", "output_text": "Use a bounded queue and backpressure."}


class FakeHTTPClient:
    def __init__(self) -> None:
        self.requests: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> None:
        return None

    async def post(self, url: str, **kwargs) -> FakeHTTPResponse:
        self.requests.append({"url": url, **kwargs})
        return FakeHTTPResponse()


def make_runtime(name: str = "one", *, context_store: ContextStore | None = None) -> InterviewRuntime:
    if context_store is None:
        with tempfile.TemporaryDirectory() as empty_root:
            context_store = ContextStore(empty_root)
    return InterviewRuntime(
        interview_id=name,
        session_token=f"token-{name}",
        capture_token=f"capture-{name}",
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        context_store=context_store,
    )


def attach_ui(runtime: InterviewRuntime, socket: FakeSocket, name: str = "ui") -> None:
    runtime._ui_clients[name] = socket  # type: ignore[assignment]
    runtime._ready_ui_clients.add(name)


def attach_capture(
    runtime: InterviewRuntime,
    socket: FakeSocket,
    speaker: str = "interviewer",
) -> None:
    runtime._capture_clients[speaker] = socket  # type: ignore[index,assignment]


async def finish_operations(runtime: InterviewRuntime) -> None:
    while runtime._jobs:
        await asyncio.gather(*tuple(runtime._jobs.values()), return_exceptions=True)


async def wait_until(predicate, *, timeout: float = 1.0) -> None:
    async def wait():
        while not predicate():
            await asyncio.sleep(0)
    await asyncio.wait_for(wait(), timeout=timeout)


def answer_events(messages: list[dict]) -> list[dict]:
    return [message for message in messages if message["type"].startswith("answer_")]


async def _populate_answer_store(runtime, stream):
    from app.services.openai_realtime import _emit_answer_delta, _set_answer_text
    async for raw in stream:
        event = json.loads(raw)
        kind = event["type"]
        response = event.get("response", {})
        rid = event.get("response_id") or response.get("id")
        if kind == "response.created":
            await _begin_response(runtime, rid)
        elif kind == "response.output_text.delta":
            await _emit_answer_delta(runtime, rid, event["delta"])
        elif kind == "response.output_text.done":
            await _set_answer_text(runtime, rid, event["text"])
        elif kind == "response.done":
            text = ''.join(part.get("text", "") for item in response.get("output", []) for part in item.get("content", [])) or None
            status = response.get("status")
            await _emit_terminal(runtime, response_id=rid, text=text, detail=(status + ": " + response["status_details"]["reason"]) if response.get("status_details", {}).get("reason") else status or "",
                event_type="answer_completed" if status=="completed" else "answer_interrupted" if status=="cancelled" else "answer_error")


class RealtimeProtocolTests(unittest.TestCase):

    def test_candidate_streaming_transcription_omits_unsupported_server_vad(self) -> None:
        upstream = FakeUpstream()
        with patch.dict(os.environ, {"OPENAI_REALTIME_TRANSCRIPTION_LANGUAGES": "en,zh", "OPENAI_REALTIME_TRANSCRIPTION_MODEL": "gpt-live-transcribe"}):
            asyncio.run(_send_transcription_session_update(upstream))  # type: ignore[arg-type]
        session = upstream.messages[0]["session"]
        self.assertEqual(session["type"], "transcription")
        self.assertEqual(session["audio"]["input"]["format"], {"type": "audio/pcm", "rate": 24000})
        self.assertIsNone(session["audio"]["input"]["turn_detection"])
        self.assertEqual(session["audio"]["input"]["transcription"],
                         {"model": "gpt-live-transcribe", "languages": ["en", "zh"], "delay": "low"})
        self.assertNotIn("language", session["audio"]["input"]["transcription"])

    def test_runtime_opens_exactly_two_upstreams_and_updates_each_once(self) -> None:
        async def run() -> tuple[list[dict], list[dict], list[str]]:
            runtime = make_runtime()
            main = FakeUpstream()
            candidate = FakeUpstream()
            connect = AsyncMock(side_effect=[candidate, main])
            with patch("app.services.openai_realtime._connect_openai_realtime", new=connect):
                self.assertIs(await runtime.ensure_candidate(), await runtime.ensure_candidate())
                self.assertIsNone(runtime.main_upstream)
                self.assertIs(await runtime.ensure_main(), await runtime.ensure_main())
                kinds = [call.kwargs["kind"] for call in connect.await_args_list]
            await runtime.close()
            return main.messages, candidate.messages, kinds

        main_messages, candidate_messages, kinds = asyncio.run(run())
        self.assertEqual(kinds, ["candidate", "main"])
        self.assertEqual([item["type"] for item in main_messages], ["session.update"])
        self.assertEqual([item["type"] for item in candidate_messages], ["session.update"])





    def test_idle_capture_audio_does_not_open_upstream(self) -> None:
        async def run() -> tuple[AsyncMock, AsyncMock]:
            runtime = make_runtime("idle-audio")
            interviewer = FakeClientWebSocket(
                {},
                controls=[
                    {"type": "websocket.receive", "bytes": b"audio"},
                    {"type": "websocket.disconnect"},
                ],
            )
            candidate = FakeClientWebSocket(
                {},
                controls=[
                    {"type": "websocket.receive", "bytes": b"audio"},
                    {"type": "websocket.disconnect"},
                ],
            )
            ensure_main = AsyncMock(return_value=FakeUpstream())
            ensure_candidate = AsyncMock(return_value=FakeUpstream())
            with (
                patch.object(runtime, "ensure_main", new=ensure_main),
                patch.object(runtime, "ensure_candidate", new=ensure_candidate),
            ):
                await _forward_capture_controls(
                    runtime, interviewer, "interviewer"  # type: ignore[arg-type]
                )
                await _forward_capture_controls(
                    runtime, candidate, "candidate"  # type: ignore[arg-type]
                )
            return ensure_main, ensure_candidate

        ensure_main, ensure_candidate = asyncio.run(run())
        ensure_main.assert_not_awaited()
        ensure_candidate.assert_not_awaited()

    def test_start_requires_both_capture_channels_ready_and_opens_no_upstream(self) -> None:
        async def run() -> tuple[InterviewRuntime, FakeSocket, FakeSocket, FakeSocket, AsyncMock, AsyncMock]:
            runtime = make_runtime("start-gate")
            ui = FakeSocket()
            interviewer = FakeSocket()
            candidate = FakeSocket()
            attach_ui(runtime, ui)
            ensure_main = AsyncMock(return_value=FakeUpstream())
            ensure_candidate = AsyncMock(return_value=FakeUpstream())
            with (
                patch.object(runtime, "ensure_main", new=ensure_main),
                patch.object(runtime, "ensure_candidate", new=ensure_candidate),
            ):
                await runtime.start_transcription(ui)  # type: ignore[arg-type]
                attach_capture(runtime, interviewer, "interviewer")
                attach_capture(runtime, candidate, "candidate")
                await runtime.mark_capture_ready("interviewer", interviewer)  # type: ignore[arg-type]
                await runtime.start_transcription(ui)  # type: ignore[arg-type]
                await runtime.mark_capture_ready("candidate", candidate)  # type: ignore[arg-type]
                await runtime.start_transcription(ui)  # type: ignore[arg-type]
            return runtime, ui, interviewer, candidate, ensure_main, ensure_candidate

        runtime, ui, interviewer, candidate, ensure_main, ensure_candidate = asyncio.run(run())
        self.assertTrue(runtime.active)
        self.assertEqual(interviewer.messages[-1], {"type": "capture_start"})
        self.assertEqual(candidate.messages[-1], {"type": "capture_start"})
        self.assertTrue(any(message.get("type") == "error" for message in ui.messages))
        self.assertIn({"type": "prepare_capture", "mode": "assist"}, interviewer.messages)
        self.assertTrue(any(all(message.get(k) == v for k, v in {"type": "interview_state", "active": True, "mode": "assist"}.items()) for message in ui.messages))
        ensure_main.assert_not_awaited()
        ensure_candidate.assert_not_awaited()

    def test_two_ui_clients_receive_same_answer_and_one_failure_does_not_stop_other(self) -> None:
        async def run() -> tuple[list[dict], list[dict], InterviewRuntime]:
            runtime = make_runtime("fanout")
            first = FakeSocket()
            second = FakeSocket()
            attach_ui(runtime, FailingSocket(), "failed")
            attach_ui(runtime, first, "first")
            attach_ui(runtime, second, "second")
            await _populate_answer_store(
                runtime,
                FakeEventStream(
                    [
                        {"type": "response.created", "response": {"id": "resp_1"}},
                        {"type": "response.output_text.delta", "response_id": "resp_1", "delta": "One"},
                        {
                            "type": "response.done",
                            "response": {
                                "id": "resp_1",
                                "status": "completed",
                                "output": [{"content": [{"type": "output_text", "text": "One"}]}],
                            },
                        },
                    ]
                ),  # type: ignore[arg-type]
            )
            runtime._ui_clients.pop("first")
            runtime._ready_ui_clients.discard("first")
            await _populate_answer_store(
                runtime,
                FakeEventStream(
                    [
                        {"type": "response.created", "response": {"id": "resp_2"}},
                        {
                            "type": "response.done",
                            "response": {"id": "resp_2", "status": "completed", "output": []},
                        },
                    ]
                ),  # type: ignore[arg-type]
            )
            return first.messages, second.messages, runtime

        first_messages, second_messages, runtime = asyncio.run(run())
        self.assertEqual(
            [message["type"] for message in answer_events(first_messages)],
            ["answer_started", "answer_delta", "answer_completed"],
        )
        self.assertEqual(answer_events(second_messages), answer_events(first_messages))
        self.assertFalse(any(message.get("response_id") == "resp_2" for message in answer_events(second_messages)))
        self.assertNotIn("failed", runtime._ui_clients)
        self.assertIsNone(runtime.main_upstream)

    def test_slow_ui_sender_cannot_block_healthy_client_or_event_lock(self) -> None:
        async def run() -> None:
            class SlowSocket(FakeSocket):
                def __init__(self):
                    super().__init__()
                    self.started = asyncio.Event()
                    self.release = asyncio.Event()

                async def send_json(self, payload: dict) -> None:
                    self.started.set()
                    await self.release.wait()
                    await super().send_json(payload)

            runtime = make_runtime("slow-ui")
            slow, healthy = SlowSocket(), FakeSocket()
            runtime._ui_clients["slow"] = slow  # type: ignore[assignment]
            runtime._ready_ui_clients.add("slow")
            queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=2)
            runtime._ui_queues["slow"] = queue
            runtime._ui_senders["slow"] = asyncio.create_task(runtime._send_ui_events("slow", slow, queue))
            attach_ui(runtime, healthy, "healthy")
            await asyncio.wait_for(runtime.broadcast_to_clients({"type": "first"}), .2)
            await slow.started.wait()
            await asyncio.wait_for(runtime.broadcast_to_clients({"type": "second"}), .2)
            await asyncio.wait_for(runtime.broadcast_to_clients({"type": "third"}), .2)
            await asyncio.wait_for(runtime.broadcast_to_clients({"type": "fourth"}), .2)
            self.assertEqual([event["type"] for event in healthy.messages], ["first", "second", "third", "fourth"])
            self.assertFalse(runtime._event_lock.locked())
            self.assertNotIn("slow", runtime._ui_clients)
            slow.release.set()
            await runtime.close()

        asyncio.run(run())



    def test_invalid_first_frame_never_registers_client_or_connects_upstream(self) -> None:
        async def run() -> tuple[FakeClientWebSocket, AsyncMock, InterviewRuntime]:
            runtime = make_runtime("auth")
            websocket = FakeClientWebSocket({"type": "authenticate", "token": "wrong"})
            ensure_main = AsyncMock(return_value=object())
            with patch.object(runtime, "ensure_main", new=ensure_main):
                await runtime.serve(websocket, "client")
            return websocket, ensure_main, runtime

        websocket, ensure_main, runtime = asyncio.run(run())
        self.assertTrue(websocket.accepted)
        self.assertEqual(websocket.closed_codes, [1008])
        self.assertEqual(websocket.messages, [])
        ensure_main.assert_not_awaited()
        self.assertEqual(runtime._ui_clients, {})

    def test_reconnect_replays_partial_and_terminal_answer_snapshots(self) -> None:
        async def run() -> tuple[list[dict], list[dict], InterviewRuntime]:
            runtime = make_runtime("reconnect")
            await _populate_answer_store(
                runtime,
                FakeEventStream(
                    [
                        {"type": "response.created", "response": {"id": "resp_partial"}},
                        {
                            "type": "response.output_text.delta",
                            "response_id": "resp_partial",
                            "delta": "Still streaming",
                        },
                        {"type": "response.created", "response": {"id": "resp_done"}},
                        {"type": "response.output_text.delta", "response_id": "resp_done", "delta": "Final"},
                        {
                            "type": "response.done",
                            "response": {
                                "id": "resp_done",
                                "status": "completed",
                                "output": [{"content": [{"type": "output_text", "text": "Final answer"}]}],
                            },
                        },
                        {"type": "response.created", "response": {"id": "resp_interrupted"}},
                        {
                            "type": "response.output_text.delta",
                            "response_id": "resp_interrupted",
                            "delta": "Interrupted partial",
                        },
                        {
                            "type": "response.done",
                            "response": {
                                "id": "resp_interrupted",
                                "status": "cancelled",
                                "status_details": {"reason": "turn_detected"},
                            },
                        },
                    ]
                ),  # type: ignore[arg-type]
            )
            first = FakeClientWebSocket(
                {"type": "authenticate", "token": runtime.session_token}
            )
            second = FakeClientWebSocket(
                {"type": "authenticate", "token": runtime.session_token}
            )
            ensure_main = AsyncMock(return_value=object())
            with patch.object(runtime, "ensure_main", new=ensure_main):
                await runtime.serve(first, "client")
                await runtime.serve(second, "client")
            return first.messages, second.messages, runtime

        first_messages, second_messages, runtime = asyncio.run(run())
        first_snapshots = [item for item in first_messages if item["type"] == "answer_snapshot"]
        second_snapshots = [item for item in second_messages if item["type"] == "answer_snapshot"]
        expected = [
            {
                "type": "answer_snapshot",
                "response_id": "resp_partial",
                "text": "Still streaming",
                "status": "streaming",
            },
            {
                "type": "answer_snapshot",
                "response_id": "resp_done",
                "text": "Final answer",
                "status": "completed",
            },
            {
                "type": "answer_snapshot",
                "response_id": "resp_interrupted",
                "text": "Interrupted partial",
                "status": "interrupted",
                "detail": "cancelled: turn_detected",
            },
        ]
        expected = [{**snapshot, "question_id": "", "operation_id": ""} for snapshot in expected]
        self.assertEqual(first_snapshots, [{**item, "activities": []} for item in expected])
        self.assertEqual(second_snapshots, [{**item, "activities": []} for item in expected])
        self.assertEqual(
            runtime.response_order,
            ["resp_partial", "resp_done", "resp_interrupted"],
        )

    def test_join_snapshot_is_followed_by_live_events_without_gap(self) -> None:
        async def run() -> list[dict]:
            runtime = make_runtime("join-live")
            await runtime.emit_transcript_final("interviewer", "Existing question")
            await _populate_answer_store(
                runtime,
                FakeEventStream(
                    [
                        {"type": "response.created", "response": {"id": "old"}},
                        {
                            "type": "response.done",
                            "response": {
                                "id": "old",
                                "status": "completed",
                                "output": [{"content": [{"type": "output_text", "text": "Old answer"}]}],
                            },
                        },
                    ]
                ),  # type: ignore[arg-type]
            )
            websocket = StreamingClientWebSocket(
                {"type": "authenticate", "token": runtime.session_token}
            )
            serve_task = asyncio.create_task(runtime.serve(websocket, "client"))  # type: ignore[arg-type]
            await asyncio.wait_for(websocket.snapshot_sent.wait(), timeout=1.0)
            await _populate_answer_store(
                runtime,
                FakeEventStream(
                    [
                        {"type": "response.created", "response": {"id": "live"}},
                        {"type": "response.output_text.delta", "response_id": "live", "delta": "Live"},
                    ]
                ),  # type: ignore[arg-type]
            )
            await websocket.controls.put({"type": "websocket.disconnect"})
            await serve_task
            return websocket.messages

        messages = asyncio.run(run())
        self.assertEqual(
            [message["type"] for message in messages[:8]],
            [
                "session_ready",
                "conversation_info",
                "device_status",
                "interview_state",
                "context_status",
                "transcript_snapshot",
                "chat_snapshot",
                "answer_snapshot",
            ],
        )
        self.assertEqual(len(messages[5]["turns"]), 1)
        turn = messages[5]["turns"][0]
        self.assertEqual((turn["speaker"], turn["text"]), ("interviewer", "Existing question"))
        self.assertTrue(all(turn[key] for key in ("turn_id", "question_id", "created_at")))
        self.assertEqual([message["type"] for message in messages[8:]], ["answer_snapshot_done", "question_state", "code_state", "screen_collection", "operation_snapshot", "model_status", "session_metrics", "answer_started", "answer_delta"])
        self.assertEqual(messages[-2]["response_id"], "live")

    def test_terminal_state_survives_client_send_failure(self) -> None:
        async def run() -> InterviewRuntime:
            runtime = make_runtime("send-failure")
            attach_ui(runtime, FailingSocket())
            await _populate_answer_store(
                runtime,
                FakeEventStream(
                    [
                        {"type": "response.created", "response": {"id": "resp_failed_send"}},
                        {
                            "type": "response.done",
                            "response": {
                                "id": "resp_failed_send",
                                "status": "completed",
                                "output": [{"content": [{"type": "output_text", "text": "Preserved"}]}],
                            },
                        },
                    ]
                ),  # type: ignore[arg-type]
            )
            return runtime

        runtime = asyncio.run(run())
        self.assertEqual(runtime.response_buffers["resp_failed_send"], "Preserved")
        self.assertEqual(runtime.response_status["resp_failed_send"], "completed")
        self.assertIn("resp_failed_send", runtime.terminal_responses)






    def test_idle_ui_rejects_audio_manual_text_and_screen_without_upstream(self) -> None:
        async def run() -> tuple[list[dict], AsyncMock]:
            runtime = make_runtime("idle-ui")
            websocket = FakeClientWebSocket(
                {},
                controls=[
                    {"type": "websocket.receive", "bytes": b"audio"},
                    {
                        "type": "websocket.receive",
                        "text": json.dumps({"type": "manual_text", "text": "question"}),
                    },
                    {
                        "type": "websocket.receive",
                        "text": json.dumps({"type": "request_screen_capture"}),
                    },
                    {"type": "websocket.disconnect"},
                ],
            )
            attach_ui(runtime, websocket)
            ensure_main = AsyncMock(return_value=FakeUpstream())
            with patch.object(runtime, "ensure_main", new=ensure_main):
                await _forward_ui_controls(runtime, websocket)  # type: ignore[arg-type]
                await finish_operations(runtime)
            return websocket.messages, ensure_main

        messages, ensure_main = asyncio.run(run())
        self.assertEqual([message["type"] for message in messages].count("error"), 1)
        failed = [message for message in messages if message.get("status") == "failed"]
        self.assertEqual(len(failed), 2)
        self.assertEqual(messages[0]["detail"], "UI clients cannot send audio.")
        self.assertTrue(all(len(message.get("detail", "")) <= 500 for message in messages))
        ensure_main.assert_not_awaited()

    def test_close_notifies_ui_and_capture_before_socket_shutdown(self) -> None:
        async def run() -> tuple[list[dict], list[dict]]:
            runtime = make_runtime("ended")
            ui = FakeSocket()
            capture = FakeSocket()
            attach_ui(runtime, ui)
            attach_capture(runtime, capture)
            await runtime.close()
            return ui.messages, capture.messages

        ui_messages, capture_messages = asyncio.run(run())
        self.assertEqual(ui_messages[-1], {"type": "session_ended"})
        self.assertEqual(capture_messages[-1], {"type": "session_ended"})

    def test_invalid_manual_screen_capture_reports_bounded_error_and_keeps_control_loop_alive(self) -> None:
        async def run() -> FakeClientWebSocket:
            runtime = make_runtime("bad-screen")
            websocket = FakeClientWebSocket(
                {},
                controls=[
                    {
                        "type": "websocket.receive",
                        "text": json.dumps(
                            {
                                "type": "screen_capture",
                                "image_data": "data:image/png;base64,bm90LXBuZw==",
                                "request_answer": True,
                            }
                        ),
                    },
                    {"type": "websocket.receive", "text": json.dumps({"type": "close"})},
                ],
            )
            await _forward_capture_controls(
                runtime,
                websocket,  # type: ignore[arg-type]
                "interviewer",
            )
            return websocket

        websocket = asyncio.run(run())
        self.assertEqual(websocket.receive_count, 2)
        self.assertEqual(websocket.messages[0]["type"], "error")
        self.assertLessEqual(len(websocket.messages[0]["detail"]), 500)


class RealtimeToolTests(unittest.TestCase):
    def test_screen_request_cancelled_during_capture_send_does_not_leave_pending_image(self) -> None:
        async def run() -> None:
            runtime = make_runtime("cancel-screen")
            entered = asyncio.Event()

            async def delayed_send(*_args, **_kwargs):
                entered.set()
                await asyncio.Event().wait()

            with patch.object(runtime, "send_to_capture", new=delayed_send):
                task = asyncio.create_task(_request_current_screen(runtime, reason="Synthetic test"))
                await entered.wait()
                pending = tuple(runtime.pending_screen_requests.values())
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            self.assertFalse(runtime.pending_screen_requests)
            self.assertTrue(all(future.cancelled() for future in pending))

        asyncio.run(run())




    def test_screenshot_rejects_mime_signature_mismatch_and_size(self) -> None:
        invalid = "data:image/png;base64," + base64.b64encode(b"not-png").decode("ascii")
        with self.assertRaises(OpenAIRealtimeError):
            _validate_image_data_url(invalid)
        with self.assertRaises(OpenAIRealtimeError):
            _validate_image_data_url(PNG_DATA_URL, max_bytes=4)

    def test_chat_input_preserves_dialogue_without_injecting_server_documents(self) -> None:
        from tests.test_realtime_recovery import Upstream
        async def run(root: Path) -> str:
            runtime = make_runtime(context_store=ContextStore(root))
            runtime.active = True
            await runtime.emit_transcript_final("interviewer", "EARLY_FULL_QUESTION " + "x" * 3500 + " QUESTION_END")
            for index in range(45):
                await runtime.remember_dialogue("interviewer", f"Recorded turn {index}: " + "context " * 40)
            await runtime.remember_dialogue("candidate", "LATEST_CORRECTION_START " + "y" * 3500 + " LATEST_CORRECTION_END")
            runtime.history.add_screen("full-screen", PNG_DATA_URL, "SCREEN_START " + "s" * 1500 + " SCREEN_END", question_id=runtime.current_question_id)
            content, _ = runtime.chat.input({"action": "send", "text": "解释一下", "screens": []})
            await runtime.close()
            self.assertEqual(len(runtime.recent_dialogue), 47)
            return "\n".join(part.get("text", "") for item in content for part in item["content"] if isinstance(part, dict))
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            documents = {f"background-{index}.md": f"## Source {index}\n\nBEGIN_{index}\n" + "Full supplied facts.\n" * 450 + f"END_{index}" for index in range(8)}
            for source, text in documents.items():
                (root / source).write_text(text, encoding="utf-8", newline="")
            input_text = asyncio.run(run(root))
        for source, text in documents.items():
            self.assertNotIn(source, input_text)  # Codex reads local materials as needed.
        for marker in ("EARLY_FULL_QUESTION", "QUESTION_END", "Recorded turn 0:", "Recorded turn 44:", "LATEST_CORRECTION_START", "LATEST_CORRECTION_END"):
            self.assertIn(marker, input_text)


if __name__ == "__main__":
    unittest.main()

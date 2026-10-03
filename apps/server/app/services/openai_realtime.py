from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import sqlite3
import os
import secrets
import time
import uuid
from collections import deque
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx
import websockets
from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import ClientConnection

from app.config import REALTIME_PROTOCOL_VERSION, get_settings
from app.models import ConnectionRole, Speaker
from app.services.context_store import ContextStore
from app.services.browser_connection import BrowserConnection
from app.services.codex_chat import CodexChat
from app.services.realtime_history import InterviewHistory, observed_at
from app.services.chat_controls import run_ui_operation as _run_ui_operation
from app.services.code_workspace import CodeWorkspace, CodeWorkspaceError
from app.services.transcription import TranscriptRelay
from app.services.candidate_audio import CandidateAudioBoundary
from app.services.mock_interviewer import MockInterviewer
from app.services.upstream_errors import ProviderRequestError, provider_error


class OpenAIRealtimeError(RuntimeError):
    pass


AUDIO_INPUT_FORMAT: dict[str, Any] = {"type": "audio/pcm", "rate": 24000}
ALLOWED_SCREENSHOT_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}
AUTHENTICATION_TIMEOUT_SECONDS = 5.0
CLIENT_SEND_TIMEOUT_SECONDS = 2.0
CLIENT_SEND_BYTES_PER_SECOND = 64_000
CLIENT_SNAPSHOT_TIMEOUT_SECONDS = 5.0
CLIENT_UI_QUEUE_LIMIT = 256
TRANSCRIPTION_START_TIMEOUT_SECONDS = 15.0
MAX_AUDIO_FRAME_BYTES = 256 * 1024
# About half a second of PCM16 mono at 24 kHz, matching the capture client.
MAX_QUEUED_AUDIO_BYTES = 24_000
MAX_AUDIO_AGE_SECONDS = 0.5
OPERATION_TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


class InterviewRuntime:
    """All mutable state and both OpenAI sessions for one interview."""

    def __init__(
        self,
        *,
        interview_id: str,
        session_token: str,
        capture_token: str,
        expires_at: datetime,
        context_store: ContextStore | None = None,
        registry: InterviewRegistry | None = None,
    ) -> None:
        self.interview_id = interview_id
        self.conversation_id = interview_id
        from app.services.transcription_buffer import TranscriptionBuffer
        self.transcription = TranscriptionBuffer()
        self.session_token = session_token
        self.capture_token = capture_token
        self.expires_at = expires_at
        self.context_store = context_store or ContextStore()
        self.registry = registry
        self.device_name = "我的电脑"
        self.title = "新对话"
        self.updated_at = observed_at()
        self.journal = None
        self.switching = False
        self.browser_connection = BrowserConnection()
        self.browser_connection_host: WebSocket | None = None

        self.chat = CodexChat(self)
        self.main_upstream: ClientConnection | None = None
        self.candidate_upstream: ClientConnection | None = None
        self._candidate_boundary = CandidateAudioBoundary()
        self._main_boundary = CandidateAudioBoundary()
        self._main_reader_task: asyncio.Task[None] | None = None
        self._candidate_reader_task: asyncio.Task[None] | None = None
        self._upstream_locks = {kind: asyncio.Lock() for kind in ("main", "candidate")}
        self._event_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._answer_lock = asyncio.Lock()
        self._response_lock = asyncio.Lock()
        self._jobs: dict[str, asyncio.Task[None]] = {}
        self._audio_tasks: set[asyncio.Task] = set()
        self._audio_queues = {}
        self._capture_flush = {}
        self._audio_closed = set()
        self._transcription_drains = {}
        self.transcription_stopping = False
        self._transcription_stop_task = None
        self.operations: dict[str, dict[str, Any]] = {}
        self.code_workspace = CodeWorkspace()
        self.workspace_history = None
        self.workspace_history_lock = asyncio.Lock()
        self.workspace_history_error = ""
        self.saved_workspaces: list[dict[str, Any]] = []
        self.material_revision = 0
        self.collected_screens: list[str] = []
        self._independent_jobs: set[str] = set()
        self._response_metadata: dict[str, dict[str, Any]] = {}
        self.context_revision = 0
        self.current_question_id = ""
        self._main_retry_after = 0.0
        self._main_failures = 0
        self._candidate_retry_after = 0.0
        self._candidate_failures = 0
        self._connected_at = {kind: 0.0 for kind in ("main", "candidate")}
        self.candidate_context_revision = 0
        self._model_channels = {name: {"status": "idle", "detail": ""} for name in ("main", "candidate")}
        self._model_status: dict[str, Any] = {"type": "model_status", "status": "idle", "detail": "Models connect when active audio arrives."}
        self._channel_details: dict[str, dict[str, Any]] = {}
        self._screen_metadata: dict[str, dict[str, Any]] = {}
        self._question_started_at: dict[str, float] = {}
        self.metrics: dict[str, Any] = {
            "analysis_input_tokens": 0, "analysis_output_tokens": 0,
            "tool_calls": 0, "tool_failures": 0, "tool_rejections": 0, "reconnections": 0,
            "audio_gaps": 0, "first_content_latency_ms": [],
        }
        self._capture_clients: dict[Speaker, WebSocket] = {}
        self._capture_ready: set[Speaker] = set()
        self._ui_clients: dict[str, WebSocket] = {}
        self._ready_ui_clients: set[str] = set()
        self._ui_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._ui_senders: dict[str, asyncio.Task[None]] = {}
        self._closed = False
        self.active = False
        self._transcription_lock = asyncio.Lock()
        self.mode = "assist"
        self.capture_mode = "assist"
        self.mock = MockInterviewer(self)

        self._pending_ui: dict[str, list[dict[str, Any]]] = {}
        self.history = InterviewHistory()
        self.recent_dialogue = self.transcription.history.turns
        self.pending_screen_requests: dict[str, asyncio.Future[str]] = {}

        self.active_response_id = ""
        self.response_buffers: dict[str, str] = {}
        self.response_order: list[str] = []
        self.response_status: dict[str, Literal["streaming", "completed", "interrupted", "error"]] = {}
        self.response_details: dict[str, str] = {}
        self.started_responses: set[str] = set()
        self.terminal_responses: set[str] = set()

    @property
    def closed(self) -> bool:
        return self._closed

    def token_matches(self, token: str) -> bool:
        return bool(token) and hmac.compare_digest(self.session_token, token)

    def capture_token_matches(self, token: str) -> bool:
        return bool(token) and hmac.compare_digest(self.capture_token, token)

    def is_expired(self, now: datetime | None = None) -> bool:
        if self.active or self._capture_clients:
            return False
        return self.expires_at <= (now or datetime.now(timezone.utc))

    async def serve(self, websocket: WebSocket, role: ConnectionRole) -> None:
        await websocket.accept()
        if not await self._authenticate(websocket, role):
            return
        if role == "client":
            await self._serve_ui_client(websocket)
        elif role == "model":
            await self.chat.host.serve(websocket)
        else:
            await self._serve_capture_client(websocket, role)

    async def _serve_ui_client(self, websocket: WebSocket) -> None:
        client_id = secrets.token_urlsafe(12)
        registered = False
        try:
            async with self._event_lock:
                if self._closed or self.is_expired():
                    await _send_websocket_json(
                        websocket, {"type": "error", "detail": "Interview session expired."}
                    )
                    await websocket.close(code=1008)
                    return
                self._ui_clients[client_id] = websocket
                self._pending_ui[client_id] = []
                registered = True
                batch = self._ui_snapshot_payloads()
            # Snapshot first, outside the event lock. Events published meanwhile
            # queue behind it and then flow through this client's own sender.
            budget = CLIENT_SNAPSHOT_TIMEOUT_SECONDS + sum(
                len(json.dumps(payload, ensure_ascii=False)) for payload in batch) / CLIENT_SEND_BYTES_PER_SECOND
            async with asyncio.timeout(budget):
                for payload in batch:
                    await _send_websocket_json(websocket, payload)
            async with self._event_lock:
                if self._ui_clients.get(client_id) is not websocket:
                    return
                pending = self._pending_ui.pop(client_id, [])
                queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=CLIENT_UI_QUEUE_LIMIT)
                for payload in pending:
                    queue.put_nowait(payload)
                self._ui_queues[client_id] = queue
                self._ui_senders[client_id] = asyncio.create_task(self._send_ui_events(client_id, websocket, queue))
                self._ready_ui_clients.add(client_id)

            await _forward_ui_controls(self, websocket)
        finally:
            if registered:
                async with self._event_lock:
                    sender = self._drop_ui_client_locked(client_id)
                if sender is not None and sender is not asyncio.current_task():
                    sender.cancel()
                    await asyncio.gather(sender, return_exceptions=True)

    async def _send_ui_events(
        self, client_id: str, websocket: WebSocket, queue: asyncio.Queue[dict[str, Any]],
    ) -> None:
        try:
            while True:
                payload = await queue.get()
                try:
                    await _send_websocket_json(websocket, payload)
                finally:
                    queue.task_done()
        except asyncio.CancelledError:
            raise
        except Exception:
            async with self._event_lock:
                if self._ui_clients.get(client_id) is websocket:
                    self._drop_ui_client_locked(client_id)
            await _close_websocket(websocket, code=1013)

    def _drop_ui_client_locked(self, client_id: str) -> asyncio.Task[None] | None:
        self._ui_clients.pop(client_id, None)
        self._ready_ui_clients.discard(client_id)
        self._pending_ui.pop(client_id, None)
        self._ui_queues.pop(client_id, None)
        return self._ui_senders.pop(client_id, None)

    def _ui_snapshot_payloads(self) -> list[dict[str, Any]]:
        """Complete reconnect state, built synchronously while the event lock is held."""
        documents = self.context_store.documents()
        return [
            {"type": "session_ready", "realtime_protocol": REALTIME_PROTOCOL_VERSION,
             "mock_interview": True, "pinned_code": False, "chat": True, "mode": self.mode, "speaker": "client",
             "source": get_settings().openai_code_model, "interview_id": self.interview_id},
            {"type": "conversation_info", "conversation_id": self.conversation_id, "title": self.title,
             "persistent": bool(self.journal), "detail": self.journal.error if self.journal else "会话仅保存在本次服务中。"},
            self._device_status_payload(),
            self._interview_state_payload(),
            *([self.mock.snapshot()] if self.mode == "mock" else []),
            {"type": "context_status", "documents_count": len(documents),
             "characters_count": sum(len(doc.text) for doc in documents)},
            {"type": "transcript_snapshot", "turns": self.transcription.history.transcript_snapshot()},
            {"type": "chat_snapshot", "messages": [deepcopy(e) for e in self.history.entries if e["kind"] == "chat_request"]},
            *self._answer_snapshot_payloads(),
            {"type": "answer_snapshot_done"},
            self.question_state(),
            self.code_state(),
            self.screen_collection_state(),
            {"type": "operation_snapshot", "operations": [dict(operation) for operation in self.operations.values()]},
            self._model_status,
            {"type": "session_metrics", "metrics": dict(self.metrics)},
        ]

    async def _serve_capture_client(self, websocket: WebSocket, speaker: Speaker) -> None:
        registered = False
        try:
            async with self._event_lock:
                if self._closed or self.is_expired():
                    await _send_websocket_json(
                        websocket, {"type": "error", "detail": "Interview session expired."}
                    )
                    await websocket.close(code=1008)
                    return
                if speaker in self._capture_clients:
                    await _send_websocket_json(
                        websocket, {"type": "error", "detail": "旧采集连接尚未释放，正在重试恢复连接。"}
                    )
                    await websocket.close(code=1013)
                    return
                self._capture_clients[speaker] = websocket
                if speaker == "interviewer":
                    self.browser_connection_host = websocket if websocket.scope.get("browser_connections") else None
                registered = True
                source = f"{get_settings().openai_realtime_transcription_model}:context"
                await _send_websocket_json(
                    websocket,
                    {
                        "type": "session_ready",
                        "realtime_protocol": REALTIME_PROTOCOL_VERSION,
                        "mock_interview": True, "mode": self.mode,
                        "speaker": speaker,
                        "source": source,
                        "interview_id": self.interview_id,
                    },
                )
                await self._broadcast_clients_locked(self._device_status_payload())

            await _forward_capture_controls(self, websocket, speaker)
        finally:
            if registered:
                async with self._event_lock:
                    if self._capture_clients.get(speaker) is websocket:
                        self._capture_clients.pop(speaker, None)
                        if speaker == "interviewer":
                            self.browser_connection.clear()
                        self._capture_ready.discard(speaker)
                        self._channel_details[speaker] = {"phase": "interrupted", "detail": "Capture connection disconnected; restore this audio channel."}
                        await self._broadcast_clients_locked(self._device_status_payload())
                if self.mode == "mock":
                    await self.mock.stop("采集设备断开，请连接后恢复 AI 面试官。")
                # Closing the capture host must not leave paid upstreams alive.
                # Preserve the room/history so a returning host can reconnect.
                kind = "main" if speaker == "interviewer" else "candidate"
                upstream = self.main_upstream if kind == "main" else self.candidate_upstream
                if upstream is not None:
                    await self._release_upstream(kind, upstream, retry=False, without_capture=speaker)

    async def _authenticate(self, websocket: WebSocket, role: ConnectionRole) -> bool:
        try:
            payload = await asyncio.wait_for(
                websocket.receive_json(),
                timeout=AUTHENTICATION_TIMEOUT_SECONDS,
            )
        except (asyncio.TimeoutError, json.JSONDecodeError, TypeError, WebSocketDisconnect):
            await _close_websocket(websocket, code=1008)
            return False
        except Exception:
            await _close_websocket(websocket, code=1008)
            return False
        if not isinstance(payload, dict) or payload.get("type") != "authenticate":
            await _close_websocket(websocket, code=1008)
            return False
        token = str(payload.get("token") or "")
        authenticated = self.token_matches(token) if role == "client" else self.capture_token_matches(token)
        if not authenticated:
            await _close_websocket(websocket, code=1008)
            return False
        if role == "interviewer":
            websocket.scope["browser_connections"] = payload.get("browser_connections") is True
        return True

    def _answer_snapshot_payloads(self) -> list[dict[str, Any]]:
        payloads = []
        for response_id in self.response_order:
            payload: dict[str, Any] = {
                "type": "answer_snapshot",
                "response_id": response_id,
                "text": self.response_buffers.get(response_id, ""),
                "status": self.response_status.get(response_id, "streaming"),
            }
            payload.update(_answer_metadata(self, response_id))
            payload["activities"] = deepcopy(self._response_metadata.get(response_id, {}).get("activities", []))
            detail = self.response_details.get(response_id, "")
            if detail:
                payload["detail"] = detail
            payloads.append(payload)
        return payloads

    async def public_state(self) -> dict[str, Any]:
        async with self._event_lock:
            device = self._device_status_payload()
            interview = self._interview_state_payload()
            return {
                "interview_id": self.interview_id,
                "conversation_id": self.conversation_id,
                "session_token": self.session_token,
                "expires_at": self.expires_at.isoformat().replace("+00:00", "Z"),
                "device_status": {"status": device["status"], "channels": device["channels"], "channel_details": device["channel_details"]},
                "interview_state": {"active": interview["active"], "mode": self.mode},
            }

    def discoverable_device(self) -> dict[str, Any] | None:
        if self.closed or "interviewer" not in self._capture_clients:
            return None
        return {"device_id": self.interview_id, "name": self.device_name, "active": self.active}

    def _device_status_payload(self) -> dict[str, Any]:
        connected = set(self._capture_clients)
        channels = {
            "interviewer": "interviewer" in self._capture_ready,
            "candidate": "candidate" in self._capture_ready,
        }
        if all(channels.values()):
            status = "ready"
        elif connected:
            status = "initializing"
        else:
            status = "offline"
        return {"type": "device_status", "status": status, "channels": channels, "channel_details": dict(self._channel_details), "mode": self.capture_mode}

    def _interview_state_payload(self) -> dict[str, Any]:
        return {"type": "interview_state", "active": self.active, "stopping": self.transcription_stopping, "mode": self.mode, "transcription_id": self.transcription.identity}

    async def broadcast_to_clients(self, payload: dict[str, Any]) -> None:
        async with self._event_lock:
            await self._broadcast_clients_locked(payload)

    async def update_model_status(self, channel: str, status: str, detail: str = "") -> None:
        self._model_channels[channel] = {"status": status, "detail": detail}
        pending = [state for state in self._model_channels.values() if state["status"] in {"connecting", "recovering"}]
        pending_status = "recovering" if any(state["status"] == "recovering" for state in pending) else "connecting"
        self._model_status = {
            "type": "model_status", "status": pending_status if pending else "ready",
            "detail": " ".join(state["detail"] for state in pending) if pending else detail,
        }
        await self.broadcast_to_clients(self._model_status)

    async def _broadcast_clients_locked(self, payload: dict[str, Any]) -> None:
        if self.journal and payload.get("type") in {
            "chat_message", "transcript_delta", "transcript_final", "transcript_snapshot",
            "answer_started", "answer_delta", "answer_activity", "answer_completed", "answer_interrupted", "answer_error",
            "code_state", "screen_collection", "operation_status", "conversation_info",
        }:
            self.journal.changed()
        # Each production client has its own bounded sender. A slow phone must
        # never hold the event lock needed by transcription and other clients.
        for client_id, pending in tuple(self._pending_ui.items()):
            if len(pending) >= CLIENT_UI_QUEUE_LIMIT:
                self._disconnect_ui_client_locked(client_id)
            else:
                pending.append(payload)  # Delivered after that client's snapshot.
        peers = []
        for client_id in tuple(self._ready_ui_clients):
            websocket = self._ui_clients.get(client_id)
            queue = self._ui_queues.get(client_id)
            if websocket is None:
                self._drop_ui_client_locked(client_id)
            elif queue is not None:
                try:
                    queue.put_nowait(payload)
                except asyncio.QueueFull:
                    self._disconnect_ui_client_locked(client_id)
            else:
                # Legacy in-process test peers do not run a sender task.
                peers.append((client_id, websocket))

        async def send_one(client_id: str, websocket: WebSocket | None) -> str | None:
            if websocket is None:
                return client_id
            try:
                await _send_websocket_json(websocket, payload)
                return None
            except Exception:
                return client_id

        failed = [
            client_id
            for client_id in await asyncio.gather(*(send_one(*peer) for peer in peers))
            if client_id is not None
        ]
        for client_id in failed:
            self._disconnect_ui_client_locked(client_id)

    def _disconnect_ui_client_locked(self, client_id: str) -> None:
        websocket = self._ui_clients.get(client_id)
        sender = self._drop_ui_client_locked(client_id)
        if sender is not None:
            sender.cancel()
        if websocket is not None:
            asyncio.create_task(_close_websocket(websocket, code=1013))

    async def send_to_ui_client(self, websocket: WebSocket, payload: dict[str, Any]) -> bool:
        async with self._event_lock:
            client_id = next((key for key, client in self._ui_clients.items() if client is websocket), None)
            if client_id is None:
                return False
            queue = self._ui_queues.get(client_id)
            if queue is not None:
                try:
                    queue.put_nowait(payload)
                    return True
                except asyncio.QueueFull:
                    self._disconnect_ui_client_locked(client_id)
                    return False
            pending = self._pending_ui.get(client_id)
            if pending is not None:
                if len(pending) >= CLIENT_UI_QUEUE_LIMIT:
                    self._disconnect_ui_client_locked(client_id)
                    return False
                pending.append(payload)
                return True
            try:
                await _send_websocket_json(websocket, payload)
                return True
            except Exception:
                self._disconnect_ui_client_locked(client_id)
                return False

    async def send_to_capture(self, speaker: Speaker, payload: dict[str, Any]) -> bool:
        async with self._event_lock:
            return await self._send_to_capture_locked(speaker, payload)

    async def _send_to_capture_locked(self, speaker: Speaker, payload: dict[str, Any]) -> bool:
        websocket = self._capture_clients.get(speaker)
        if websocket is None:
            return False
        try:
            await _send_websocket_json(websocket, payload)
            return True
        except Exception:
            if self._capture_clients.get(speaker) is websocket:
                self._capture_clients.pop(speaker, None)
                self._capture_ready.discard(speaker)
                self._channel_details[speaker] = {"phase": "interrupted", "detail": "Capture connection disconnected; restore this audio channel."}
                await self._broadcast_clients_locked(self._device_status_payload())
                await _close_websocket(websocket, code=1013)
            return False

    async def mark_capture_ready(self, speaker: Speaker, websocket: WebSocket) -> None:
        async with self._event_lock:
            if self._capture_clients.get(speaker) is not websocket:
                return
            self._capture_ready.add(speaker)
            self._channel_details[speaker] = {"phase": "ready", "detail": ""}
            if self.active:
                await self._send_to_capture_locked(speaker, {"type": "capture_start"})
            await self._broadcast_clients_locked(self._device_status_payload())

    async def start_transcription(self, requester: WebSocket, mode: str = "assist") -> None:
        if self.registry is not None:
            async with self.registry._lock:
                if self.registry.draining:
                    await self.send_to_ui_client(requester, {"type": "error", "detail": "Server deployment is in progress. Try again shortly."})
                    return
                async with self._transcription_lock:
                    await self._start_transcription_locked(requester, mode)
        else:
            async with self._transcription_lock:
                await self._start_transcription_locked(requester, mode)

    async def _start_transcription_locked(self, requester: WebSocket, mode: str = "assist") -> None:
        if self.transcription_stopping:
            await self.send_to_ui_client(requester, {"type": "error", "detail": "正在收尾转录，请稍后开始。"})
            return
        async with self._event_lock:
            if self.closed or requester not in self._ui_clients.values():
                return
            if mode not in {"assist", "mock"} or (self.active and mode != self.mode):
                await _send_websocket_json(requester, {"type": "error", "detail": "请停止转录后切换模式。"})
                return
            if mode != self.capture_mode or self._capture_ready != {"interviewer", "candidate"}:
                sent = await self._send_to_capture_locked("interviewer", {"type": "prepare_capture", "mode": mode})
                if not sent:
                    await self._broadcast_clients_locked({"type": "error", "detail": "请先连接桌面端再开始转录。"})
                    await self._broadcast_clients_locked(self._interview_state_payload())
                return
            if not self.active:
                self._audio_closed.clear()
                interviewer_started = await self._send_to_capture_locked(
                    "interviewer", {"type": "capture_start"}
                )
                candidate_started = await self._send_to_capture_locked(
                    "candidate", {"type": "capture_start"}
                )
                if not interviewer_started or not candidate_started:
                    if interviewer_started:
                        await self._send_to_capture_locked("interviewer", {"type": "capture_stop"})
                    if candidate_started:
                        await self._send_to_capture_locked("candidate", {"type": "capture_stop"})
                    self.active = False
                    await _send_websocket_json(
                        requester, {"type": "error", "detail": "Capture device disconnected."}
                    )
                    await self._broadcast_clients_locked(self._interview_state_payload())
                    return
                self.active = True
                self.mode = mode
            await self._broadcast_clients_locked(self._interview_state_payload())
        if mode == "mock":
            self.mock.start()

    async def new_transcription(self, operation_id):
        from app.services.transcription_buffer import TranscriptionBuffer
        # Serialize against capture start, chat switching and other admissions.
        gate = self.registry._lock if self.registry else self._response_lock
        async with gate, self._transcription_lock:
            if self.active or self.transcription_stopping:
                raise OpenAIRealtimeError("请先停止转录，再开始新一场。旧转录会保留。")
            if any(key != operation_id and not job.done() for key, job in self._jobs.items()):
                raise OpenAIRealtimeError("请等待当前操作完成，再开始新一场转录。")
            previous = self.transcription.export()
            fresh = TranscriptionBuffer()
            if self.journal:
                await self.journal.flush()
                if self.journal.error:
                    raise OpenAIRealtimeError(self.journal.error)
                await asyncio.to_thread(self.journal.store.save_transcription, fresh.export())
            else:
                self.transcription_archives = getattr(self, "transcription_archives", []) + [previous]
            self.transcription = fresh
            # Old draft screenshots remain in persisted chat history, but are
            # no longer represented as attachments on the new shared timeline.
            self.collected_screens.clear()
            self.recent_dialogue = fresh.history.turns
            self.current_question_id = ""
            await self.broadcast_to_clients({"type": "transcript_snapshot", "turns": []})
            await self.broadcast_to_clients(self._interview_state_payload())
            await self.broadcast_to_clients(self.question_state())
            await self.broadcast_to_clients(self.screen_collection_state())

    async def stop_transcription(self) -> None:
        await asyncio.shield(self.request_transcription_stop())

    def request_transcription_stop(self):
        if self._transcription_stop_task is None or self._transcription_stop_task.done():
            self._transcription_stop_task = asyncio.create_task(self._stop_transcription())
            self._transcription_stop_task.add_done_callback(_consume_task_result)
        return self._transcription_stop_task

    async def _stop_transcription(self) -> None:
        """Release audio and upstreams without cancelling chat or clearing context."""
        async with self._transcription_lock:
            if self.transcription_stopping:
                return
            was_active = self.active
            self.transcription_stopping = True
        try:
            await self.broadcast_to_clients(self._interview_state_payload())
            # Do not hold admission/event locks while audio and ASR drain.
            if was_active:
                await asyncio.gather(*(self._finish_transcription_channel(speaker) for speaker in ('interviewer', 'candidate')))
        finally:
            self.active = False
            try:
                await self.mock.stop()
                audio_tasks = list(self._audio_tasks)
                for task in audio_tasks:
                    task.cancel()
                if audio_tasks:
                    await asyncio.gather(*audio_tasks, return_exceptions=True)
                for kind in ("main", "candidate"):
                    upstream = getattr(self, f"{kind}_upstream")
                    if upstream is not None:
                        await self._release_upstream(kind, upstream, retry=False)
                    setattr(self, f"_{kind}_retry_after", 0)
                    setattr(self, f"_{kind}_failures", 0)
                    await self.update_model_status(kind, "idle", "转录已停止。")
            finally:
                self.transcription_stopping = False
                self._capture_flush.clear()
                await self.broadcast_to_clients(self._interview_state_payload())

    def transcription_drain(self, kind, upstream):
        from app.services.transcription import TranscriptionDrain
        current = self._transcription_drains.get(kind)
        if not current or current[0] is not upstream:
            current = (upstream, TranscriptionDrain())
            self._transcription_drains[kind] = current
        return current[1]

    async def _commit_transcription(self, kind, upstream):
        self.transcription_drain(kind, upstream).requested += 1
        await _send_json(upstream, {"type": "input_audio_buffer.commit"})

    async def _finish_transcription_channel(self, speaker):
        kind = 'main' if speaker == 'interviewer' else 'candidate'
        label = '系统音频' if speaker == 'interviewer' else '麦克风'
        socket = self._capture_clients.get(speaker)
        identity = str(uuid.uuid4())
        confirmed = asyncio.get_running_loop().create_future()
        self._capture_flush[speaker] = (socket, identity, confirmed)
        try:
            if socket:
                await self.send_to_capture(speaker, {'type': 'capture_stop', 'request_id': identity})
                try:
                    await asyncio.wait_for(asyncio.shield(confirmed), 2)
                except Exception:
                    await self.broadcast_to_clients({'type': 'error', 'detail': f'{label}停止采集未确认，最后一段可能不完整；请核对转录。'})
            self._audio_closed.add(speaker)
            queue = self._audio_queues.get(speaker)
            if queue:
                await asyncio.wait_for(queue.drain(), 3)
            upstream = getattr(self, f'{kind}_upstream')
            if upstream is not None:
                boundary = getattr(self, f'_{kind}_boundary', None)
                padding = boundary.finish() if boundary else None
                if padding is not None:
                    if padding:
                        await _send_audio_append(upstream, padding)
                    await self._commit_transcription(kind, upstream)
                await asyncio.wait_for(self.transcription_drain(kind, upstream).wait(), 6)
        except Exception:
            await self.broadcast_to_clients({'type': 'error', 'detail': f'{label}收尾未完成，已有文字已保留；请核对并补充最后一句。'})
        finally:
            self._capture_flush.pop(speaker, None)
            if not confirmed.done():
                confirmed.cancel()

    @property
    def in_use(self) -> bool:
        # An ongoing text conversation is just as important as an audio session.
        return not self.closed and bool(self.active or self.transcription_stopping or self._jobs or (self.chat.job and not self.chat.job.done()))

    async def emit_transcript_delta(self, speaker: Speaker, delta: str) -> None:
        if not delta:
            return
        async with self._event_lock:
            await self._broadcast_clients_locked(
                {"type": "transcript_delta", "speaker": speaker, "delta": delta}
            )

    async def update_transcript(self, speaker: str, turn_id: str, text: str, status: str, *, delta: str = "", corrected: bool = False) -> None:
        async with self._event_lock:
            async with self._state_lock:
                existing = self.transcription.history.by_id.get(turn_id)
                if existing and existing.get("corrected_by_user") and not corrected:
                    return
                self.material_revision += 1
                if speaker == "candidate":
                    self.candidate_context_revision += 1
                question_id = (existing or {}).get("question_id") or (
                    self.transcription.history.open_interviewer_question() if speaker == "interviewer" else self.current_question_id)
                turn = self.transcription.history.add_turn(speaker, text, turn_id=turn_id, question_id=question_id)
                turn.update(text=text, status=status)
                if corrected:
                    turn["corrected_by_user"] = True
                if speaker == "interviewer":
                    self.current_question_id = turn["question_id"]
                event = {"type": "transcript_delta" if status == "streaming" else "transcript_final",
                         **{key: value for key, value in turn.items() if key != "kind"}, "delta": delta}
            await self._broadcast_clients_locked(event)
            if speaker == "interviewer":
                await self._broadcast_clients_locked(self.question_state())

    async def emit_transcript_final(self, speaker: Speaker, text: str, *, turn_id: str = "", question_id: str = "", corrects_turn_id: str = "") -> None:
        normalized = text.strip()
        if not normalized:
            return
        async with self._event_lock:
            async with self._state_lock:
                self.material_revision += 1
                if speaker == "candidate":
                    self.candidate_context_revision += 1
                turn = self.transcription.history.add_turn(speaker, normalized, turn_id=turn_id, question_id=question_id, corrects_turn_id=corrects_turn_id)
                if speaker == "interviewer" and not self.current_question_id:
                    self.current_question_id = turn["question_id"]
            await self._broadcast_clients_locked(
                {"type": "transcript_final", **{key: value for key, value in turn.items() if key != "kind"}}
            )
            if speaker == "interviewer":
                await self._broadcast_clients_locked(self.question_state())

    async def ensure_main(self) -> ClientConnection:
        return await self._ensure_transcription("main")

    async def ensure_candidate(self) -> ClientConnection:
        return await self._ensure_transcription("candidate")

    async def _ensure_transcription(self, kind: str) -> ClientConnection:
        async with self._upstream_locks[kind]:
            self._ensure_open()
            upstream = getattr(self, f"{kind}_upstream")
            if upstream is not None:
                return upstream
            if time.monotonic() < getattr(self, f"_{kind}_retry_after"):
                raise OpenAIRealtimeError("语音转录正在恢复；缺失的音频请重说或在聊天中补充。")
            label = "系统音频" if kind == "main" else "麦克风"
            try:
                await self.update_model_status(kind, "connecting", f"正在连接{label}转录。")
                upstream = await _connect_openai_realtime(kind=kind)
                self._ensure_open()
                await _send_transcription_session_update(upstream)
                await _wait_transcription_ready(upstream)
                self._ensure_open()
            except BaseException as exc:
                if upstream is not None:
                    await _safe_close(upstream)
                self._defer_reconnect(kind)
                if not self.closed and self.active and isinstance(exc, Exception):
                    await self.update_model_status(kind, "recovering", _safe_error_detail(exc))
                raise
            setattr(self, f"{kind}_upstream", upstream)
            setattr(self, f"_{kind}_boundary", CandidateAudioBoundary())
            self._connected_at[kind] = time.monotonic()
            setattr(self, f"_{kind}_retry_after", 0)
            reader = self._run_main_reader if kind == "main" else self._run_candidate_reader
            setattr(self, f"_{kind}_reader_task", asyncio.create_task(reader(upstream)))
            await self.update_model_status(kind, "ready", f"{label}转录已连接。")
            return upstream

    async def send_transcription_audio(self, kind: str, upstream: ClientConnection, data: bytes) -> None:
        if upstream is not getattr(self, f"{kind}_upstream") or not self.active or self.closed:
            return
        boundary = getattr(self, f"_{kind}_boundary")
        await _send_audio_append(upstream, data)
        if self.active and not self.closed and upstream is getattr(self, f"{kind}_upstream") and boundary.feed(data):
            await self._commit_transcription(kind, upstream)

    async def remember_dialogue(self, speaker: Speaker, text: str) -> None:
        normalized = text.strip()
        if not normalized:
            return
        async with self._state_lock:
            turn = self.transcription.history.add_turn(speaker, normalized)
            if speaker == "interviewer":
                self.current_question_id = turn["question_id"]

    def question_state(self) -> dict[str, Any]:
        return {
            "type": "question_state", "current_question_id": self.current_question_id,
            "questions": self.transcription.history.questions(),
        }


    def question_text(self, question_id: str = "") -> str:
        target = question_id or self.current_question_id
        text = self.transcription.history.question_text(target) if target else ""
        if text:
            return text
        if question_id:
            raise OpenAIRealtimeError("The selected question is no longer available.")
        return next((str(turn["text"]) for turn in reversed(self.recent_dialogue) if turn["speaker"] == "interviewer"), "")

    def code_state(self) -> dict[str, Any]:
        workspace = self.code_workspace.snapshot(self.material_revision)
        workspace["saved_workspaces"] = self.saved_workspaces
        workspace["history_error"] = self.workspace_history_error
        return {"type": "code_state", "workspace": workspace}

    def screen_collection_state(self) -> dict[str, Any]:
        return {"type": "screen_collection", "screens": [
            {key: entry.get(key, "") for key in ("request_id", "question_id", "captured_at", "source_id", "image_url", "appshot")}
            for entry in self.history.entries if entry["kind"] == "screen" and entry["request_id"] in self.collected_screens
        ]}

    async def operation_status(self, operation_id: str, status: str, **details: Any) -> None:
        operation = self.operations.get(operation_id)
        if operation is None or operation.get("status") in OPERATION_TERMINAL_STATUSES:
            return
        operation.update(status=status, **details)
        await self.broadcast_to_clients({"type": "operation_status", **operation})

    async def start_operation(self, payload: dict[str, Any], websocket: WebSocket) -> None:
        if self.registry is not None:
            async with self.registry._lock:
                if self.registry.draining:
                    await self.send_to_ui_client(websocket, {"type": "error", "detail": "服务正在更新，请稍后重试。"})
                    return
                await self._start_operation_locked(payload, websocket)
        else:
            await self._start_operation_locked(payload, websocket)

    async def _start_operation_locked(self, payload: dict[str, Any], websocket: WebSocket) -> None:
        if self.closed:
            await self.send_to_ui_client(websocket, {"type": "error", "detail": "Interview session closed."})
            return
        if self.switching or (payload.get("conversation_id") and payload["conversation_id"] != self.conversation_id):
            await self.send_to_ui_client(websocket, {"type": "error", "detail": "聊天已切换，请在当前聊天重新操作。"})
            return
        requested_id = payload.get("operation_id")
        if requested_id is not None and (not isinstance(requested_id, str) or not requested_id or len(requested_id) > 128):
            await self.send_to_ui_client(websocket, {"type": "error", "detail": "Invalid operation id."})
            return
        operation_id = requested_id or f"operation-{uuid.uuid4()}"
        if operation_id in self.operations:
            await self.send_to_ui_client(websocket, {"type": "operation_status", **self.operations[operation_id]})
            return
        self.operations[operation_id] = {
            "operation_id": operation_id, "kind": payload["type"], "status": "accepted",
            "action": payload.get("action", ""), "created_at": observed_at(),
        }
        await self.broadcast_to_clients({"type": "operation_status", **self.operations[operation_id]})
        if self.closed:
            await self.operation_status(operation_id, "cancelled", detail="Interview session closed.")
            return

        async def run() -> None:
            try:
                await _run_ui_operation(self, websocket, payload, operation_id)
            except asyncio.CancelledError:
                await self.operation_status(operation_id, "cancelled", detail="Superseded or interview ended.")
                raise
            except Exception as exc:
                await self.operation_status(operation_id, "failed", detail=_safe_error_detail(exc))
            finally:
                self._jobs.pop(operation_id, None)
                self._independent_jobs.discard(operation_id)

        task = asyncio.create_task(run())
        self._jobs[operation_id] = task
        if payload["type"] in {"chat_send", "code_action"} or (payload["type"] == "request_screen_capture" and payload.get("collect_only") is True):
            self._independent_jobs.add(operation_id)
        task.add_done_callback(_consume_task_result)

    async def invalidate_work(self, *, question_id: str = "", except_operation: str = "") -> int:
        self.context_revision += 1
        if question_id:
            self.current_question_id = question_id
        for operation_id, task in tuple(self._jobs.items()):
            if not self.closed and operation_id in self._independent_jobs:
                continue
            if operation_id != except_operation and task is not asyncio.current_task() and not task.done():
                task.cancel()
        return self.context_revision

    def work_is_current(self, revision: int, upstream: ClientConnection | None = None) -> bool:
        return (
            not self._closed and revision == self.context_revision
            and (upstream is None or upstream is self.main_upstream)
        )

    async def reset_main(self, detail: str) -> None:
        upstream = self.main_upstream
        if upstream is not None:
            await self._release_upstream("main", upstream, retry=False)
        await self.update_model_status("main", "recovering", detail)


    async def accept_screen_snapshot(self, payload: dict[str, Any]) -> bool:
        request_id = str(payload.get("request_id") or "")
        async with self._state_lock:
            future = self.pending_screen_requests.get(request_id)
            if self._closed or future is None or future.done():
                return False
            if payload.get("error"):
                future.set_exception(OpenAIRealtimeError(str(payload["error"])[:500]))
                return True
            image_url = _validate_image_data_url(str(payload.get("image_data") or ""))
            self._screen_metadata.setdefault(request_id, {}).update({
                "source_id": str(payload.get("source_id") or "")[:256],
                "captured_at": str(payload.get("captured_at") or observed_at())[:64],
            })
            if "appshot" in payload:
                from app.services.appshot import validate_appshot
                self._screen_metadata[request_id]["appshot"] = validate_appshot(payload["appshot"])
            future.set_result(image_url)
            return True

    async def mark_capture_status(self, speaker: Speaker, websocket: WebSocket, payload: dict[str, Any]) -> None:
        phase = payload.get("phase")
        if phase not in {"ready", "muted", "error", "interrupted"}:
            return
        async with self._event_lock:
            if self._capture_clients.get(speaker) is not websocket:
                return
            was_ready = speaker in self._capture_ready
            if speaker == "interviewer":
                reported_mode = payload.get("mode", "assist")
                if reported_mode not in {"assist", "mock"} or (self.active and reported_mode != self.mode):
                    return
                self.capture_mode = reported_mode
            self._channel_details[speaker] = {"phase": phase, "detail": str(payload.get("detail") or "")[:500]}
            if phase in {"error", "interrupted"}:
                self._capture_ready.discard(speaker)
            elif phase in {"ready", "muted"}:
                self._capture_ready.add(speaker)
                if self.active and not was_ready:
                    await self._send_to_capture_locked(speaker, {"type": "capture_start"})
            if speaker == "interviewer" and phase in {"ready", "muted"}:
                await self._send_to_capture_locked(speaker, {"type": "capture_mode_ready", "mode": self.capture_mode})
            if payload.get("audio_gap") is True:
                self.metrics["audio_gaps"] += 1
            await self._broadcast_clients_locked(self._device_status_payload())

        if phase == "error":
            # Terminal media failure has no audio to process. Keep the capture
            # socket and room so replacing only this source can recover it.
            kind = "main" if speaker == "interviewer" else "candidate"
            upstream = self.main_upstream if kind == "main" else self.candidate_upstream
            if upstream is not None:
                await self._release_upstream(kind, upstream, retry=False)

        # "interrupted" is transient (UI jank, brief network backlog) and recovers
        # by itself; only a terminal media failure stops the practice interviewer.
        if self.mode == "mock" and phase == "error":
            await self.mock.stop("音频通道中断，请恢复音频后重连 AI 面试官。")

    async def close(self, *, websocket_code: int = 1000) -> None:
        if self._closed:
            return
        # Close admission synchronously, before awaiting cancellation cleanup.
        self._closed = True
        self.active = False

        stopping = self._transcription_stop_task
        if stopping is not None and stopping is not asyncio.current_task() and not stopping.done():
            stopping.cancel()
            await asyncio.gather(stopping, return_exceptions=True)
        await self.mock.stop()
        await self.invalidate_work()
        audio_tasks = list(self._audio_tasks)
        for task in audio_tasks:
            task.cancel()
        if audio_tasks:
            await asyncio.gather(*audio_tasks, return_exceptions=True)
        await self.chat.close()
        jobs = list(self._jobs.values())
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
        async with self._upstream_locks["main"], self._upstream_locks["candidate"]:
            upstreams = [self.main_upstream, self.candidate_upstream]
            self.main_upstream = None
            self.candidate_upstream = None
            reader_tasks = [self._main_reader_task, self._candidate_reader_task]
            self._main_reader_task = None
            self._candidate_reader_task = None
            futures = list(self.pending_screen_requests.values())
            self.pending_screen_requests.clear()

        async with self._event_lock:
            clients = list(self._ui_clients.values())
            capture_clients = list(self._capture_clients.values())
            senders = list(self._ui_senders.values())
            self._ui_clients.clear()
            self._ready_ui_clients.clear()
            self._pending_ui.clear()
            self._ui_queues.clear()
            self._ui_senders.clear()
            self._capture_clients.clear()
            self._capture_ready.clear()
            self.active = False

        for sender in senders:
            sender.cancel()
        if senders:
            await asyncio.gather(*senders, return_exceptions=True)
        await asyncio.gather(*(
            _send_websocket_json(websocket, {"type": "session_ended"})
            for websocket in clients + capture_clients
        ), return_exceptions=True)

        for future in futures:
            if not future.done():
                future.set_exception(OpenAIRealtimeError("Interview session closed."))
        for task in reader_tasks:
            if task is not None:
                task.cancel()
        for upstream in upstreams:
            if upstream is not None:
                await _safe_close(upstream)
        for task in reader_tasks:
            if task is not None:
                await asyncio.gather(task, return_exceptions=True)
        if self.journal:
            await self.journal.close()
        for websocket in clients + capture_clients:
            try:
                await _close_websocket(websocket, code=websocket_code)
            except Exception:
                pass

    async def _run_main_reader(self, upstream: ClientConnection) -> None:
        try:
            await _forward_main_events(self, upstream)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not self._closed:
                await self.broadcast_to_clients({"type": "error", "detail": _safe_error_detail(exc)})
        finally:
            await self._release_upstream("main", upstream)

    async def _run_candidate_reader(self, upstream: ClientConnection) -> None:
        try:
            await _forward_candidate_events(self, upstream)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not self._closed:
                await self.broadcast_to_clients({"type": "error", "detail": _safe_error_detail(exc)})
        finally:
            await self._release_upstream("candidate", upstream)

    def _defer_reconnect(self, kind: Literal["main", "candidate"]) -> None:
        now = time.monotonic()
        connected = self._connected_at[kind]
        # A brief successful handshake must not reset repeated failure backoff.
        failures = 0 if connected and now - connected >= 30 else getattr(self, f"_{kind}_failures")
        setattr(self, f"_{kind}_failures", failures + 1)
        setattr(self, f"_{kind}_retry_after", now + min(30, 2 ** min(failures, 5)))
        self._connected_at[kind] = 0.0

    async def _release_upstream(self, kind: Literal["main", "candidate"], upstream: ClientConnection, *, retry: bool = True, without_capture: Speaker | None = None) -> None:
        task = None
        async with self._upstream_locks[kind]:
            if without_capture is not None and without_capture in self._capture_clients:
                return  # A replacement capture connection already recovered.
            if kind == "main" and self.main_upstream is upstream:

                task = self._main_reader_task
                self._main_reader_task = None
                if task is not None and task is not asyncio.current_task():
                    task.cancel()
                # Close the old socket before a replacement can be admitted.
                await _safe_close(upstream)
                self.main_upstream = None
                if not self.closed and self.active:
                    if retry:
                        self._defer_reconnect("main")
                    self.metrics["reconnections"] += 1
                    await self.update_model_status("main", "recovering", "系统音频转录中断。已记录文字保留，缺失音频请重说或手动补充。")
            elif kind == "candidate" and self.candidate_upstream is upstream:
                task = self._candidate_reader_task
                self._candidate_reader_task = None
                if task is not None and task is not asyncio.current_task():
                    task.cancel()
                await _safe_close(upstream)
                self.candidate_upstream = None
                if not self.closed and self.active:
                    if retry:
                        self._defer_reconnect("candidate")
                    self.metrics["audio_gaps"] += 1
                    await self.update_model_status("candidate", "recovering", "Candidate transcription connection interrupted. Recorded text is retained; repeat any missing candidate context.")
            else:
                await _safe_close(upstream)
        if task is not None and task is not asyncio.current_task():
            await asyncio.gather(task, return_exceptions=True)

    def _ensure_open(self) -> None:
        if self._closed or self.is_expired():
            raise OpenAIRealtimeError("Interview session expired.")


class InterviewRegistry:
    def __init__(self) -> None:
        self.browser_secret = secrets.token_urlsafe(32)
        self._current: InterviewRuntime | None = None
        self._lock = asyncio.Lock()
        self._store = None
        self._records: dict[str, dict] = {}
        self.draining = os.getenv("INTERVIEW_START_DRAINED") == "1"

    async def deployment_state(self) -> dict[str, bool]:
        async with self._lock:
            return {"active": bool(self._current and self._current.in_use), "draining": self.draining}

    async def begin_deployment(self) -> bool:
        async with self._lock:
            if self._current and self._current.in_use:
                return False
            self.draining = True
            return True

    async def cancel_deployment(self) -> None:
        async with self._lock:
            self.draining = False

    async def create(self, *, device_name: str = "我的电脑") -> InterviewRuntime:
        now = datetime.now(timezone.utc)
        async with self._lock:
            if self.draining:
                raise OpenAIRealtimeError("Server deployment is in progress. Try again shortly.")
            if self._current is not None and not self._current.closed and not self._current.is_expired(now):
                return self._current
            if self._current:
                await self._current.close()
            await self._open_store()
            identity = await asyncio.to_thread(self._store.selected) if self._store else None
            record = await asyncio.to_thread(self._store.read, identity) if self._store and identity else None
            runtime = await self._make_runtime(identity if record else None, record)
            runtime.device_name = " ".join(device_name.split()) or "我的电脑"
            self._current = runtime
        return runtime

    async def _open_store(self):
        settings = get_settings()
        if self._store is None and settings.interview_workspace_history_dir:
            from app.services.conversation_store import ConversationStore
            try:
                self._store = await asyncio.to_thread(ConversationStore, settings.interview_workspace_history_dir,
                                                       settings.interview_access_token)
            except (OSError, sqlite3.Error) as exc:
                raise OpenAIRealtimeError("无法打开会话存储；未创建空白会话覆盖历史。") from exc

    async def _make_runtime(self, identity=None, record=None):
        from app.services.conversation_store import ConversationJournal, restore
        from app.services.workspace_history import WorkspaceHistory
        settings = get_settings()
        rt = InterviewRuntime(interview_id=identity or str(uuid.uuid4()), session_token=secrets.token_urlsafe(32),
                              capture_token=secrets.token_urlsafe(32), registry=self,
                              expires_at=datetime.now(timezone.utc) + timedelta(seconds=settings.interview_session_ttl_seconds))
        if record:
            restore(rt, record)
        from app.services.transcription_buffer import TranscriptionBuffer
        transcription = await asyncio.to_thread(self._store.read_transcription) if self._store else None
        rt.transcription = TranscriptionBuffer(transcription)
        if not transcription and record:
            rt.transcription.import_legacy(record)
        rt.recent_dialogue = rt.transcription.history.turns
        if self._store:
            rt.workspace_history = await asyncio.to_thread(WorkspaceHistory, settings.interview_workspace_history_dir,
                                                           settings.interview_access_token)
            rt.saved_workspaces = await asyncio.to_thread(rt.workspace_history.list, rt.interview_id)
            rt.journal = ConversationJournal(rt, self._store)
            await rt.journal.flush()
            if rt.journal.error:
                raise OpenAIRealtimeError(rt.journal.error)
            await asyncio.to_thread(self._store.select, rt.interview_id)
        return rt

    async def conversations(self):
        async with self._lock:
            await self._open_store()
            rows = await asyncio.to_thread(self._store.list) if self._store else [
                {"interview_id": key, "title": value["title"], "updated_at": value["updated_at"]}
                for key, value in self._records.items()]
            if self._current:
                rt = self._current
                rows = [row for row in rows if row["interview_id"] != rt.conversation_id]
                rows.append({"interview_id": rt.conversation_id, "title": rt.title, "updated_at": rt.updated_at})
            return sorted(rows, key=lambda row: row["updated_at"], reverse=True)

    async def switch(self, expected: str, identity: str | None, *, stop_active: bool = False):
        from app.services.conversation_store import snapshot, restore
        async with self._lock:
            rt = self._current
            if self.draining or not rt or rt.conversation_id != expected or rt.closed:
                raise OpenAIRealtimeError("当前会话已改变，请刷新后重试。")
            if identity == expected:
                return rt
            record = (await asyncio.to_thread(self._store.read, identity) if self._store else
                      deepcopy(self._records.get(identity))) if identity else None
            if identity and not record:
                raise OpenAIRealtimeError("会话不存在，当前会话未改变。")
            async with rt._response_lock:
                if (rt.chat.job and not rt.chat.job.done()) and not stop_active:
                    raise OpenAIRealtimeError("当前仍在生成，请确认停止回答后切换；转录会继续。")
                rt.switching = True
            try:
                await rt.chat.cancel()
                jobs = list(rt._jobs.values())
                for job in jobs:
                    job.cancel()
                if jobs:
                    await asyncio.gather(*jobs, return_exceptions=True)
                if rt.journal:
                    await rt.journal.flush()
                    if rt.journal.error:
                        raise OpenAIRealtimeError(rt.journal.error)
                else:
                    self._records[rt.conversation_id] = snapshot(rt)
                next_id = identity or str(uuid.uuid4())
                fresh = InterviewRuntime(interview_id=next_id, session_token="", capture_token="", expires_at=rt.expires_at)
                if record:
                    restore(fresh, record)
                if self._store:
                    await asyncio.to_thread(self._store.save, next_id, snapshot(fresh))
                    await asyncio.to_thread(self._store.select, next_id)
                # Keep capture/upstreams/UI sockets alive; replace chat state only.
                async with rt._event_lock:
                    host = rt.chat.host
                    for name in ("title", "updated_at", "history", "collected_screens", "code_workspace",
                                 "response_buffers", "response_order", "response_status", "response_details",
                                 "_response_metadata", "operations", "started_responses", "terminal_responses"):
                        setattr(rt, name, getattr(fresh, name))
                    rt.collected_screens = [identity for identity in rt.collected_screens
                                            if identity in rt.transcription.visible_images or (
                                                'screen:' + identity not in rt.transcription.history.by_id
                                                and rt.history.by_id.get('screen:' + identity, {}).get('created_at', '')
                                                >= rt.transcription.started_at)]
                    rt.context_revision += 1
                    rt.active_response_id = ""
                    rt.conversation_id = next_id
                    rt.chat = fresh.chat
                    rt.chat.runtime = rt
                    rt.chat.host = host
                    await rt._broadcast_clients_locked({"type": "conversation_reset", "conversation_id": next_id})
                    for payload in rt._ui_snapshot_payloads():
                        await rt._broadcast_clients_locked(payload)
                return rt
            finally:
                rt.switching = False

    async def rename(self, identity: str, title: str):
        async with self._lock:
            if not self._current or self._current.conversation_id != identity:
                raise OpenAIRealtimeError("请先打开该会话再重命名。")
            rt = self._current
            rt.title = title
            await rt.broadcast_to_clients({"type": "conversation_info", "title": title})
            if rt.journal:
                await rt.journal.flush()

    async def get(self, interview_id: str) -> InterviewRuntime | None:
        runtime = await self.current()
        if runtime is None or runtime.interview_id != interview_id:
            return None
        return runtime

    async def current(self) -> InterviewRuntime | None:
        expired: InterviewRuntime | None = None
        async with self._lock:
            runtime = self._current
            if runtime is not None and (runtime.closed or runtime.is_expired()):
                expired = runtime
                self._current = None
                runtime = None
        if expired is not None:
            await expired.close(websocket_code=1008)
        return runtime

    async def delete(self, interview_id: str) -> InterviewRuntime | None:
        async with self._lock:
            runtime = self._current
            if runtime is None or runtime.interview_id != interview_id:
                return None
            self._current = None
        if runtime is not None:
            await runtime.close()
        return runtime

    async def clear(self) -> None:
        async with self._lock:
            runtime = self._current
            self._current = None
        if runtime is not None:
            await runtime.close()


_registry = InterviewRegistry()


def get_interview_registry() -> InterviewRegistry:
    return _registry


class AudioSendQueue:
    """Ordered audio sender with a small bounded backlog, off the control loop.

    Normal network jitter is absorbed instead of dropping each frame that
    arrives while one send is in flight. Beyond the budget the oldest audio is
    dropped and stale audio is never replayed late; one contiguous loss is one
    reported gap, not one per frame.
    """

    def __init__(self, runtime: InterviewRuntime, *, connect: Any, send: Any, on_gap: Any,
                 on_failure: Any = None) -> None:
        self.runtime = runtime
        self.connect, self.send, self.on_gap, self.on_failure = connect, send, on_gap, on_failure
        self.frames: deque[tuple[bytes, float]] = deque()
        self.size = 0
        self.gap_open = False
        self.wakeup = asyncio.Event()
        self.idle = asyncio.Event()
        self.idle.set()
        self.task: asyncio.Task | None = None

    async def put(self, data: bytes) -> None:
        self.idle.clear()
        self.frames.append((data, time.monotonic()))
        self.size += len(data)
        dropped = False
        while self.size > MAX_QUEUED_AUDIO_BYTES and len(self.frames) > 1:
            self.size -= len(self.frames.popleft()[0])
            dropped = True
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())
            self.runtime._audio_tasks.add(self.task)
            self.task.add_done_callback(self.runtime._audio_tasks.discard)
        self.wakeup.set()
        if dropped:
            await self._gap("音频上游暂时跟不上，部分音频未发送；请补充遗漏内容。")

    async def close(self) -> None:
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def drain(self):
        await self.idle.wait()

    async def _gap(self, detail: str, exc: BaseException | None = None) -> None:
        if not self.gap_open:
            self.gap_open = True
            await self.on_gap(detail, exc)

    async def _run(self) -> None:
        try:
            await self._drain()
        finally:
            self.frames.clear()
            self.size = 0
            self.idle.set()

    async def _drain(self) -> None:
        while True:
            while not self.frames:
                self.idle.set()
                self.wakeup.clear()
                await self.wakeup.wait()
            data, received_at = self.frames.popleft()
            self.size -= len(data)
            upstream = None
            try:
                upstream = await self.connect()
                if upstream is None:
                    continue  # Inactive: idle audio is discarded, not a gap.
                if time.monotonic() - received_at > MAX_AUDIO_AGE_SECONDS:
                    await self._gap("模型连接期间的过期音频已跳过，请补充遗漏内容。")
                    continue
                await self.send(upstream, data)
                self.gap_open = False
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self.on_failure is not None:
                    await self.on_failure(upstream, exc)
                await self._gap(_safe_error_detail(exc), exc)


async def _forward_capture_controls(
    runtime: InterviewRuntime, websocket: WebSocket, speaker: Speaker,
) -> None:
    # Keep receiving controls while provider startup/sends wait on the network.
    last_gap_notice = 0.0
    kind: Literal["main", "candidate"] = "main" if speaker == "interviewer" else "candidate"

    async def connect() -> ClientConnection | None:
        if not runtime.active or runtime.closed:
            return None
        upstream = await (runtime.ensure_main() if kind == "main" else runtime.ensure_candidate())
        return upstream if runtime.active and not runtime.closed else None

    async def send(upstream: ClientConnection, data: bytes) -> None:
        await runtime.send_transcription_audio(kind, upstream, data)

    async def failure(upstream: ClientConnection | None, exc: BaseException) -> None:
        if upstream is not None:
            await runtime._release_upstream(kind, upstream)

    async def gap(detail: str, exc: BaseException | None) -> None:
        nonlocal last_gap_notice
        runtime.metrics["audio_gaps"] += 1
        if exc is not None:
            await runtime.update_model_status(kind, "recovering", detail)
        # The connecting banner already explains startup loss; avoid a second alarm.
        if runtime._model_channels[kind]["status"] != "connecting" and time.monotonic() - last_gap_notice > 5:
            last_gap_notice = time.monotonic()
            await runtime.broadcast_to_clients({"type": "error", "detail": detail})

    audio = AudioSendQueue(runtime, connect=connect, send=send, on_gap=gap, on_failure=failure)
    runtime._audio_queues[speaker] = audio
    try:
        await _receive_capture_controls(runtime, websocket, speaker, audio.put)
    finally:
        if runtime._audio_queues.get(speaker) is audio:
            runtime._audio_queues.pop(speaker, None)
        await audio.close()


async def _receive_capture_controls(
    runtime: InterviewRuntime,
    websocket: WebSocket,
    speaker: Speaker,
    submit_audio: Any,
) -> None:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return

        binary_payload = message.get("bytes")
        if binary_payload is not None:
            if len(binary_payload) > MAX_AUDIO_FRAME_BYTES:
                await _send_websocket_json(
                    websocket, {"type": "error", "detail": "Audio frame is too large."}
                )
                continue
            if runtime.active and speaker not in runtime._audio_closed and binary_payload:
                if speaker == "candidate" and runtime.mode == "mock":
                    await runtime.mock.feed(binary_payload)
                await submit_audio(binary_payload)
            continue

        text_payload = message.get("text")
        if not text_payload:
            continue
        try:
            payload = json.loads(text_payload)
        except json.JSONDecodeError:
            await _send_websocket_json(
                websocket, {"type": "error", "detail": "Invalid JSON control message."}
            )
            continue
        if not isinstance(payload, dict):
            continue
        payload_type = payload.get("type")

        if payload_type == "ping":
            await _send_websocket_json(websocket, {"type": "pong"})
            continue
        if payload_type == 'capture_stopped':
            pending = runtime._capture_flush.get(speaker)
            if pending and pending[0] is websocket and pending[1] == payload.get('request_id') and not pending[2].done():
                if payload.get('complete') is True:
                    pending[2].set_result(True)
                else:
                    pending[2].set_exception(RuntimeError('音频收尾未确认。'))
            continue
        if payload_type == "close":
            return
        if payload_type == "capture_ready":
            await runtime.mark_capture_ready(speaker, websocket)
            continue
        if payload_type == "browser_connection_decision" and speaker == "interviewer":
            if runtime._capture_clients.get(speaker) is websocket and type(payload.get("approved")) is bool:
                accepted = runtime.browser_connection.decide(str(payload.get("request_id", "")), payload["approved"])
                await _send_websocket_json(websocket, {"type": "browser_connection_result", "request_id": payload.get("request_id"), "ok": accepted})
            continue
        if payload_type == "capture_status":
            await runtime.mark_capture_status(speaker, websocket, payload)
            continue
        if payload_type == "mock_playback_error" and speaker == "interviewer" and runtime.mode == "mock":
            await runtime.mock.stop("面试官语音播放失败，请恢复音频后重连 AI 面试官。")
            continue
        if payload_type == "screen_snapshot" and speaker == "interviewer":
            await _resolve_screen_snapshot(runtime, payload)
            continue
        await _send_websocket_json(
            websocket, {"type": "error", "detail": "Unsupported capture control message."}
        )


async def _forward_ui_controls(runtime: InterviewRuntime, websocket: WebSocket) -> None:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        if message.get("bytes") is not None:
            await runtime.send_to_ui_client(
                websocket, {"type": "error", "detail": "UI clients cannot send audio."}
            )
            continue
        text_payload = message.get("text")
        if not text_payload:
            continue
        try:
            payload = json.loads(text_payload)
        except json.JSONDecodeError:
            await runtime.send_to_ui_client(
                websocket, {"type": "error", "detail": "Invalid JSON control message."}
            )
            continue
        if not isinstance(payload, dict):
            continue
        payload_type = payload.get("type")
        if payload_type == "ping":
            await runtime.send_to_ui_client(websocket, {"type": "pong"})
            continue
        if payload_type == "close":
            return
        if payload_type == "start_transcription":
            await runtime.start_transcription(websocket, str(payload.get("mode") or "assist"))
            continue
        if payload_type == "stop_transcription":
            runtime.request_transcription_stop()
            continue
        if payload_type == "mock_share_code":
            revision = payload.get("base_revision")
            ok = False
            if runtime.active and runtime.mode == "mock" and isinstance(revision, int) and not isinstance(revision, bool):
                ok = await runtime.mock.share_code(str(payload.get("document_id") or ""), revision)
            await runtime.send_to_ui_client(websocket, {"type": "mock_code_shared", "ok": ok,
                "revision": revision, "detail": "已将已保存代码交给面试官。" if ok else "代码已变化或面试官未就绪，请重试。"})
            continue
        if payload_type == "mock_restart":
            if runtime.active and runtime.mode == "mock" and runtime._capture_ready == {"interviewer", "candidate"}:
                runtime.mock.start()
            else:
                await runtime.send_to_ui_client(websocket, {"type": "error", "detail": "请先恢复模拟面试音频通道。"})
            continue
        if payload_type in {"new_transcription", "chat_send", "chat_stop", "manual_text", "request_screen_capture", "code_action", "clear_screens"}:
            await runtime.start_operation(payload, websocket)
            continue
        await runtime.send_to_ui_client(websocket, {"type": "error", "detail": "Unsupported UI control message."})


def _consume_task_result(task: asyncio.Task[None]) -> None:
    try:
        task.result()
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


async def _resolve_screen_snapshot(runtime: InterviewRuntime, payload: dict[str, Any]) -> None:
    # Only lightweight failures travel on the audio WebSocket.
    if payload.get("image_data"):
        raise OpenAIRealtimeError("Send screenshot images through the capture HTTP endpoint.")
    request_id = str(payload.get("request_id") or "")
    future = runtime.pending_screen_requests.get(request_id)
    if future is None or future.done():
        return
    error = str(payload.get("error") or "").strip()
    if error:
        future.set_exception(OpenAIRealtimeError(error))
        return
    try:
        image_url = _validate_image_data_url(str(payload.get("image_data") or ""))
    except OpenAIRealtimeError as exc:
        future.set_exception(exc)
    else:
        future.set_result(image_url)


async def _forward_main_events(runtime: InterviewRuntime, upstream: ClientConnection) -> None:
    await _forward_transcription_events(runtime, upstream, "interviewer")


async def _forward_candidate_events(runtime: InterviewRuntime, upstream: ClientConnection) -> None:
    await _forward_transcription_events(runtime, upstream, "candidate")


async def _forward_transcription_events(runtime: InterviewRuntime, upstream: ClientConnection, speaker: str) -> None:
    relay = TranscriptRelay(runtime, speaker)
    drain = runtime.transcription_drain('main' if speaker == 'interviewer' else 'candidate', upstream)
    try:
        async for raw_message in upstream:
            if isinstance(raw_message, bytes):
                continue
            payload = json.loads(raw_message)
            if payload.get("type") == "error":
                raise provider_error(payload, fallback="语音转录连接失败；已记录文字保留。")
            if payload.get("type") == "conversation.item.input_audio_transcription.failed":
                raise OpenAIRealtimeError("语音识别失败，部分文字保留，请重说或补充。")
            await relay.handle(payload)
            drain.handle(payload)
    finally:
        drain.close()
        await relay.close()


async def _begin_response(runtime: InterviewRuntime, response_id: str, metadata: dict[str, Any] | None = None) -> None:
    async with runtime._event_lock:
        async with runtime._answer_lock:
            if response_id in runtime.terminal_responses:
                return
            runtime._response_metadata[response_id] = {
                "question_id": runtime.current_question_id, "revision": runtime.context_revision, **(metadata or {}),
            }
            runtime.active_response_id = response_id
            runtime.response_buffers.setdefault(response_id, "")


async def _emit_answer_started_locked(runtime: InterviewRuntime, response_id: str) -> None:
    if response_id in runtime.started_responses:
        return
    runtime.started_responses.add(response_id)
    runtime.response_order.append(response_id)
    runtime.response_buffers.setdefault(response_id, "")
    runtime.response_status[response_id] = "streaming"
    question_id = runtime._response_metadata.get(response_id, {}).get("question_id", runtime.current_question_id)
    runtime.history.add_answer(response_id, question_id)
    started_at = runtime._question_started_at.get(question_id)
    if started_at is not None:
        runtime.metrics["first_content_latency_ms"].append(round((time.monotonic() - started_at) * 1000))
    await runtime._broadcast_clients_locked({"type": "answer_started", "response_id": response_id, **_answer_metadata(runtime, response_id)})


async def _emit_answer_delta(runtime: InterviewRuntime, response_id: str, delta: str) -> None:
    async with runtime._event_lock:
        async with runtime._answer_lock:
            if response_id in runtime.terminal_responses:
                return
            await _emit_answer_started_locked(runtime, response_id)
            runtime.response_buffers[response_id] = runtime.response_buffers.get(response_id, "") + delta
            await runtime._broadcast_clients_locked(
                {"type": "answer_delta", "response_id": response_id, "delta": delta, **_answer_metadata(runtime, response_id)}
            )


async def _set_answer_text(runtime: InterviewRuntime, response_id: str, text: str) -> None:
    async with runtime._event_lock:
        async with runtime._answer_lock:
            if response_id in runtime.terminal_responses:
                return
            await _emit_answer_started_locked(runtime, response_id)
            runtime.response_buffers[response_id] = text


async def _emit_terminal(
    runtime: InterviewRuntime,
    *,
    response_id: str,
    event_type: Literal["answer_completed", "answer_interrupted", "answer_error"],
    text: str | None,
    detail: str,
    has_result: bool = False,
) -> None:
    async with runtime._event_lock:
        async with runtime._answer_lock:
            if response_id in runtime.terminal_responses:
                return
            final_text = runtime.response_buffers.get(response_id, "") if text is None else text
            if final_text:
                await _emit_answer_started_locked(runtime, response_id)
            runtime.response_buffers[response_id] = final_text
            runtime.terminal_responses.add(response_id)
            status_by_event: dict[str, Literal["completed", "interrupted", "error"]] = {
                "answer_completed": "completed",
                "answer_interrupted": "interrupted",
                "answer_error": "error",
            }
            runtime.response_status[response_id] = status_by_event[event_type]
            from app.services.chat_activity import finish_activities
            metadata = runtime._response_metadata.get(response_id, {})
            finish_activities(metadata)
            if event_type != "answer_completed" or detail not in {"", "completed"}:
                runtime.response_details[response_id] = detail
            else:
                runtime.response_details.pop(response_id, None)
            payload: dict[str, Any] = {"type": event_type, "response_id": response_id, "text": final_text, **_answer_metadata(runtime, response_id)}
            payload["activities"] = deepcopy(metadata.get("activities", []))
            if event_type != "answer_completed" or detail not in {"", "completed"}:
                payload["detail"] = detail
            if final_text or response_id in runtime.started_responses:
                await runtime._broadcast_clients_locked(payload)
            if runtime.active_response_id == response_id:
                runtime.active_response_id = ""
    operation_id = runtime._response_metadata.get(response_id, {}).get("operation_id")
    if operation_id:
        if event_type != "answer_completed":
            await runtime.operation_status(operation_id, "cancelled" if event_type == "answer_interrupted" else "failed", detail=detail)
        else:
            complete = bool(final_text) or has_result
            await runtime.operation_status(operation_id, "completed" if complete else "failed", detail="Answer completed." if complete else "The model returned no answer text.")
    await runtime.broadcast_to_clients({"type": "session_metrics", "metrics": dict(runtime.metrics)})


def _answer_metadata(runtime: InterviewRuntime, response_id: str) -> dict[str, str | bool]:
    metadata = runtime._response_metadata.get(response_id, {})
    result: dict[str, str | bool] = {
        key: str(metadata.get(key) or "") for key in ("question_id", "operation_id")
    }
    return result


async def _record_screen(runtime: InterviewRuntime, upstream: ClientConnection | None, request_id: str, image_url: str, question_id: str) -> None:
    metadata = runtime._screen_metadata.pop(request_id, {})
    summary = f"Screen observed for question {question_id or 'current'}. Source and time identify this discrete frame; earlier frames may be outdated."
    entry = runtime.history.add_screen(request_id, image_url, summary, question_id=question_id, **metadata)
    runtime.transcription.history.add_screen(request_id, image_url, summary, question_id=question_id, **metadata)
    runtime.transcription.visible_images.add(request_id)
    runtime.material_revision += 1


async def _request_current_screen(
    runtime: InterviewRuntime,
    *,
    reason: str,
) -> tuple[str, str]:
    request_id = f"{runtime.interview_id}:{uuid.uuid4()}"
    future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    runtime.pending_screen_requests[request_id] = future
    runtime._screen_metadata[request_id] = {}
    received = False
    try:
        sent = await runtime.send_to_capture(
            "interviewer",
            {"type": "screen_capture_request", "request_id": request_id, "reason": reason, "conversation_id": runtime.conversation_id},
        )
        if not sent:
            raise OpenAIRealtimeError("Interviewer capture device is not connected.")
        image_url = await asyncio.wait_for(future, timeout=30.0)
        received = True
        return request_id, _validate_image_data_url(image_url)
    finally:
        runtime.pending_screen_requests.pop(request_id, None)
        if not future.done():
            future.cancel()
        if not received:
            runtime._screen_metadata.pop(request_id, None)


async def _connect_openai_realtime(*, kind: Literal["main", "candidate", "mock"]) -> ClientConnection:
    settings = get_settings()
    if not settings.openai_api_key:
        raise OpenAIRealtimeError("OPENAI_API_KEY is not configured.")
    endpoint = "/live/sessions" if kind == "mock" else "/realtime?intent=transcription"
    base_url = settings.openai_base_url
    if base_url.startswith("https://"):
        ws_base = f"wss://{base_url[len('https://') :]}"
    elif base_url.startswith("http://"):
        ws_base = f"ws://{base_url[len('http://') :]}"
    else:
        ws_base = base_url
    return await websockets.connect(
        f"{ws_base}{endpoint}",
        additional_headers={"Authorization": f"Bearer {settings.openai_api_key}"},
        ping_interval=10,
        ping_timeout=20,
        open_timeout=10,
        close_timeout=2,
        max_size=None,
    )


async def _send_transcription_session_update(upstream: ClientConnection) -> None:
    settings = get_settings()
    transcription: dict[str, Any] = {"model": settings.openai_realtime_transcription_model, "delay": "low"}
    if settings.openai_realtime_transcription_languages:
        transcription["languages"] = list(settings.openai_realtime_transcription_languages)
    await _send_json(
        upstream,
        {
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": {"input": {"format": AUDIO_INPUT_FORMAT, "transcription": transcription,
                                    "turn_detection": None}},
            },
        },
    )


async def _wait_transcription_ready(upstream: ClientConnection) -> None:
    async with asyncio.timeout(TRANSCRIPTION_START_TIMEOUT_SECONDS):
        async for raw in upstream:
            if not isinstance(raw, str):
                continue
            event = json.loads(raw)
            if event.get("type") == "session.updated":
                return
            if event.get("type") in {"error", "session.closed"}:
                raise OpenAIRealtimeError(str(provider_error(event,
                    fallback="Candidate transcription configuration was not accepted; check model access and configuration.")))
    raise OpenAIRealtimeError("Candidate transcription configuration was not accepted; check model access and configuration.")


async def _send_audio_append(upstream: ClientConnection, audio_bytes: bytes, *, live: bool = False) -> None:
    await _send_json(
        upstream,
        {"type": "session.input_audio.append" if live else "input_audio_buffer.append", "audio": base64.b64encode(audio_bytes).decode("ascii")},
    )






def _validate_image_data_url(image_url: str, *, max_bytes: int | None = None) -> str:
    if not image_url.startswith("data:") or ";base64," not in image_url:
        raise OpenAIRealtimeError("Screenshot must be a base64 data URL.")
    header, encoded = image_url.split(",", 1)
    mime_type = header[5:].split(";", 1)[0].lower()
    if mime_type not in ALLOWED_SCREENSHOT_MIME_TYPES:
        raise OpenAIRealtimeError("Screenshot MIME type must be PNG, JPEG, or WebP.")
    size_limit = max_bytes if max_bytes is not None else get_settings().interview_screenshot_max_bytes
    estimated_size = (len(encoded) * 3) // 4
    if estimated_size > size_limit:
        raise OpenAIRealtimeError("Screenshot exceeds the configured size limit.")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise OpenAIRealtimeError("Screenshot base64 is invalid.") from exc
    if not decoded or len(decoded) > size_limit:
        raise OpenAIRealtimeError("Screenshot is empty or too large.")
    valid_signature = (
        mime_type == "image/png" and decoded.startswith(b"\x89PNG\r\n\x1a\n")
        or mime_type == "image/jpeg" and decoded.startswith(b"\xff\xd8\xff")
        or mime_type == "image/webp" and len(decoded) >= 12 and decoded[:4] == b"RIFF" and decoded[8:12] == b"WEBP"
    )
    if not valid_signature:
        raise OpenAIRealtimeError("Screenshot bytes do not match the declared MIME type.")
    return image_url


async def _send_json(upstream: ClientConnection, payload: dict[str, Any]) -> None:
    from app.services.live_session import send
    await send(upstream, payload)


async def _safe_close(upstream: ClientConnection) -> None:
    try:
        async with asyncio.timeout(3):
            await upstream.close()
    except Exception:
        transport = getattr(upstream, "transport", None)
        if transport is not None:
            transport.abort()


async def _send_websocket_json(websocket: WebSocket, payload: dict[str, Any]) -> None:
    # Large snapshots (full code, long answers) get time on slower phone links.
    size = len(json.dumps(payload, ensure_ascii=False))
    await asyncio.wait_for(websocket.send_json(payload),
                           timeout=CLIENT_SEND_TIMEOUT_SECONDS + size / CLIENT_SEND_BYTES_PER_SECOND)


async def _close_websocket(websocket: WebSocket, *, code: int) -> None:
    try:
        async with asyncio.timeout(CLIENT_SEND_TIMEOUT_SECONDS):
            await websocket.close(code=code)
    except Exception:
        pass


def _extract_error(payload: dict[str, Any]) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return str(error or "OpenAI Realtime error")


def _safe_error_detail(exc: BaseException) -> str:
    if isinstance(exc, (OpenAIRealtimeError, CodeWorkspaceError, ProviderRequestError)):
        return str(exc)[:500]
    if isinstance(exc, httpx.HTTPStatusError):
        return f"OpenAI request failed with HTTP {exc.response.status_code}."
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)):
        return "The model request timed out. Retry or continue with the current main model."
    return f"Request failed ({type(exc).__name__}); retry after checking the connection."


def _extract_response_text(response: dict[str, Any]) -> str:
    output = response.get("output")
    if not isinstance(output, list):
        return ""
    parts = [_extract_response_item_text(item) for item in output]
    return "\n\n".join(part for part in parts if part).strip()


def _extract_response_item_text(item: Any) -> str:
    if not isinstance(item, dict):
        return ""
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    parts = [_extract_content_part_text(part) for part in content]
    return "\n".join(part for part in parts if part).strip()


def _extract_content_part_text(part: Any) -> str:
    if not isinstance(part, dict):
        return ""
    for key in ("text", "transcript"):
        value = part.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

"""Authenticated desktop transport. The server remains the code publication authority."""
from __future__ import annotations

import asyncio
import secrets
from contextlib import asynccontextmanager
from typing import Any

from app.services.code_workspace import CodeWorkspaceError
from app.config import REALTIME_PROTOCOL_VERSION


class CodexHost:
    def __init__(self):
        self.socket: Any = None
        self.pending: dict[str, asyncio.Queue] = {}
        self.cancellations: dict[str, asyncio.Future] = {}
        self.materials: dict[str, asyncio.Future] = {}
        self._send_lock = asyncio.Lock()

    def require_connected(self):
        if self.socket is None:
            raise CodeWorkspaceError("电脑上的 Codex 尚未连接，请打开新版 Sage 桌面端。")

    async def send(self, payload: dict):
        self.require_connected()
        async with self._send_lock:
            async with asyncio.timeout(5):
                await self.socket.send_json(payload)

    async def serve(self, socket):
        # Never replace an active host with a second desktop connection.
        if self.socket is not None:
            await socket.close(code=1013)
            return
        self.socket = socket
        try:
            await self.send({"type": "codex_ready", "realtime_protocol": REALTIME_PROTOCOL_VERSION})
            while True:
                event = await socket.receive_json()
                if not isinstance(event, dict):
                    raise ValueError("Invalid model host event")
                if event.get('type') == 'ping':
                    await self.send({'type': 'pong'})
                    continue
                identity = event.get("request_id")
                if event.get("type") == "materials_result" and identity in self.materials:
                    waiter = self.materials[identity]
                    if not waiter.done():
                        waiter.set_result(event)
                    continue
                if event.get("type") == "codex_cancelled":
                    waiter = self.cancellations.get(identity)
                    if waiter and not waiter.done():
                        waiter.set_result(event)
                elif event.get("type") == "codex_event" and identity in self.pending:
                    # Bounded separately from the audio/UI queues. Overflow fails the
                    # request rather than silently losing output or applying stale tools.
                    self.pending[identity].put_nowait(event)
        finally:
            if self.socket is socket:
                self.socket = None
            for queue in self.pending.values():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"kind": "error", "detail": "电脑连接中断，未自动重发请求。"})
            for waiter in self.cancellations.values():
                if not waiter.done():
                    waiter.set_result(False)
            for waiter in self.materials.values():
                if not waiter.done():
                    waiter.set_result({"error": "电脑连接中断，请重新打开 Sage。"})

    async def read_materials(self, action: str, arguments: dict):
        if action not in {"list_materials", "read_material"}:
            raise CodeWorkspaceError("不支持的资料操作。")
        if len(self.materials) >= 8:
            raise CodeWorkspaceError("资料读取繁忙，请稍后重试。")
        identity = secrets.token_urlsafe(18)
        waiter = asyncio.get_running_loop().create_future()
        self.materials[identity] = waiter
        try:
            await self.send({"type": "materials_request", "request_id": identity, "action": action, "arguments": arguments})
            event = await asyncio.wait_for(waiter, 12)
            if event.get("error"):
                raise CodeWorkspaceError(event["error"])
            return event["result"]
        except TimeoutError:
            raise CodeWorkspaceError("电脑资料读取超时，请打开新版 Sage。") from None
        finally:
            self.materials.pop(identity, None)

    @asynccontextmanager
    async def request(self, identity: str, payload: dict):
        self.require_connected()
        queue = asyncio.Queue(maxsize=512)
        self.pending[identity] = queue
        try:
            await self.send({"type": "codex_request", "request_id": identity, **payload})
            yield queue
        finally:
            self.pending.pop(identity, None)

    async def cancel(self, identity: str) -> dict | bool:
        waiter = asyncio.get_running_loop().create_future()
        self.cancellations[identity] = waiter
        try:
            await self.send({"type": "codex_cancel", "request_id": identity})
            return await asyncio.wait_for(waiter, 8)
        except (Exception, asyncio.CancelledError):
            return False
        finally:
            self.cancellations.pop(identity, None)

    async def close(self):
        if self.socket is not None:
            try:
                await self.send({"type": "codex_close"})
                await self.socket.close(code=1000)
            except Exception:
                pass

"""Small MCP 2.0 JSON transport adapter around the existing FastMCP tool registry.

The pinned Python SDK serves legacy clients; 2.0 discovery/events use the same
endpoint, OAuth grant and tool implementations. No parallel tool catalog.
"""
from __future__ import annotations

import json
import sqlite3
from urllib.parse import urlsplit

from mcp.types import CallToolRequest
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.services.plugin_auth import SCOPE
from app.services.plugin_events import EVENT_DEFINITION, PROTOCOL, EventError, principal_context


class EventProtocol:
    def __init__(self, legacy, server, auth, events):
        self.legacy, self.server, self.auth, self.events = legacy, server, auth, events
        self.routes = legacy.routes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/mcp" or scope["method"] != "POST":
            return await self.legacy(scope, receive, send)
        request = Request(scope, receive)
        if request.headers.get("host") != urlsplit(self.auth.origin).netloc or request.headers.get("origin") not in (None, self.auth.origin, "https://chatgpt.com"):
            return await Response(status_code=403)(scope, receive, send)
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        principal = await self.auth.record("access", token) if scheme.lower() == "bearer" and token else None
        if (not principal or principal.get("resource") != self.auth.resource or SCOPE not in principal.get("scopes", [])
                or not await self.auth.load_access_token(token)):
            return await JSONResponse({"error": "invalid_token"}, status_code=401, headers={
                "WWW-Authenticate": f'Bearer resource_metadata="{self.auth.origin}/.well-known/oauth-protected-resource/mcp"',
                "Cache-Control": "no-store"})(scope, receive, send)
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            return await Response(status_code=415)(scope, receive, send)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 65536:
                return await Response(status_code=413)(scope, receive, send)
        try:
            message = json.loads(body)
        except (ValueError, UnicodeError):
            message = None
        if (not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str)
                or ("id" in message and (isinstance(message["id"], bool) or not isinstance(message["id"], (int, str))))):
            return await JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}},
                                      status_code=400)(scope, receive, send)
        method = message["method"]
        version = request.headers.get("mcp-protocol-version")
        modern = version == PROTOCOL or method == "server/discover" or method.startswith("events/")
        context = principal_context.set(principal)
        try:
            if not modern:
                buffered = bytes(body)
                async def replay():
                    nonlocal buffered
                    if buffered is not None:
                        data, buffered = buffered, None
                        return {"type": "http.request", "body": data, "more_body": False}
                    return await receive()
                return await self.legacy(scope, replay, send)
            # A mutation without a request ID cannot be acknowledged; do not run it.
            if "id" not in message:
                return await Response(status_code=202)(scope, receive, send)
            reply = {"jsonrpc": "2.0", "id": message["id"]}
            try:
                if version not in (None, PROTOCOL):
                    raise EventError("Events requires MCP 2.0 (2026-07-28).")
                params = message.get("params", {})
                if not isinstance(params, dict):
                    raise EventError("Invalid params")
                result = await self.dispatch(method, params, principal)
                reply["result"] = {"resultType": "complete", **result}
            except EventError as exc:
                reply["error"] = {"code": exc.code, "message": str(exc)}
                if exc.reason:
                    reply["error"]["data"] = {"reason": exc.reason}
            except (OSError, sqlite3.Error):
                reply["error"] = {"code": -32603, "message": "插件存储暂不可用。"}
            await JSONResponse(reply, headers={"Cache-Control": "no-store", "MCP-Protocol-Version": PROTOCOL})(scope, receive, send)
        finally:
            principal_context.reset(context)

    async def dispatch(self, method, params, principal):
        if method == "server/discover":
            return {"supportedVersions": [PROTOCOL], "serverInfo": {"name": "Sage 面试材料", "version": "0.13.0"},
                    "instructions": self.server.instructions, "capabilities": {"tools": {}, "events": {}}}
        if method == "events/list":
            if params.get("cursor") is not None:
                raise EventError("Unknown catalog cursor")
            return {"events": [EVENT_DEFINITION]}
        if method == "events/subscribe":
            return await self.events.subscribe(principal, params)
        if method == "events/unsubscribe":
            return await self.events.unsubscribe(principal, params)
        if method == "tools/list":
            if params.get("cursor") is not None:
                raise EventError("Unknown catalog cursor")
            return {"tools": [tool.model_dump(mode="json", exclude_none=True) for tool in await self.server.list_tools()]}
        if method == "tools/call":
            try:
                request = CallToolRequest(method=method, params=params)
            except ValueError:
                raise EventError("Invalid tool request") from None
            result = await self.server._mcp_server.request_handlers[CallToolRequest](request)
            return result.root.model_dump(mode="json", exclude_none=True)
        if method == "ping":
            return {}
        raise EventError("Method not found", -32601)

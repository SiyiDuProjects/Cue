"""Authenticated capture-device controls; not MCP tools and never cookie-authenticated."""
import json
import sqlite3

from fastapi import HTTPException, Request, Response

from app.services.plugin_events import EventError


def install_event_routes(app, registry):
    async def authorized(interview_id, request):
        runtime = await registry.get(interview_id)
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if not runtime or scheme.lower() != "bearer" or not runtime.capture_token_matches(token):
            raise HTTPException(401, "请重新连接 Sage。")
        if runtime.closed:
            raise HTTPException(409, "会话已关闭，请重新连接。")
        return runtime

    async def execute(action):
        try:
            return await action
        except EventError as exc:
            raise HTTPException(409, str(exc)) from None
        except (OSError, sqlite3.Error):
            raise HTTPException(503, "订阅存储暂不可用，请稍后查询请求状态。") from None

    @app.get("/api/interviews/{interview_id}/chatgpt-events")
    async def subscriptions(interview_id: str, request: Request, response: Response):
        await authorized(interview_id, request)
        response.headers["Cache-Control"] = "no-store"
        return await execute(app.state.plugin_events.status())

    @app.post("/api/interviews/{interview_id}/chatgpt-events", status_code=202)
    async def trigger(interview_id: str, request: Request, response: Response):
        runtime = await authorized(interview_id, request)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 8192:
                raise HTTPException(413, "请求过大。")
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError):
            raise HTTPException(400, "请求无效。") from None
        if not isinstance(payload, dict) or set(payload) != {"request_id", "subscription_id", "conversation_id", "image_ids"}:
            raise HTTPException(400, "请求字段无效。")
        response.headers["Cache-Control"] = "no-store"
        return await execute(app.state.plugin_events.enqueue(runtime, payload))

    @app.get("/api/interviews/{interview_id}/chatgpt-events/{request_id}")
    async def receipt(interview_id: str, request_id: str, request: Request, response: Response):
        await authorized(interview_id, request)
        value = await execute(app.state.plugin_events.request(request_id))
        if not value:
            raise HTTPException(404, "没有找到这次请求，请核对后再操作。")
        response.headers["Cache-Control"] = "no-store"
        return app.state.plugin_events.receipt(value)

    @app.delete("/api/interviews/{interview_id}/chatgpt-events/{request_id}")
    async def cancel(interview_id: str, request_id: str, request: Request, response: Response):
        await authorized(interview_id, request)
        response.headers["Cache-Control"] = "no-store"
        return await execute(app.state.plugin_events.cancel(request_id))

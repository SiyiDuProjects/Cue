from __future__ import annotations

import asyncio
import hmac
import hashlib
import time
import ipaddress
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import NoReturn, cast

from fastapi import Cookie, FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import REALTIME_PROTOCOL_VERSION, get_settings
from app.models import BrowserLogin, CaptureDevice, ConnectionRole, ConversationSwitch, ConversationRename
from app.services.browser_connection import BrowserConnection, browser_label
from app.services.openai_realtime import OpenAIRealtimeError, get_interview_registry


API_VERSION = "0.12.0"
BROWSER_COOKIE_NAME = "interview_browser_session"
BROWSER_COOKIE_TTL_SECONDS = 3600
TRUSTED_BROWSER_COOKIE_NAME = "interview_trusted_browser"
TRUSTED_BROWSER_TTL_SECONDS = 30 * 24 * 3600
PAIRING_COOKIE_NAME = "interview_browser_pairing"
# Wrong access tokens are delayed and serialized (about one guess per second
# overall). Correct tokens never wait, so guessing cannot lock out the host.
AUTH_FAILURE_DELAY_SECONDS = 1.0
MAX_WAITING_AUTH_FAILURES = 20
_auth_failure_lock = asyncio.Lock()
_auth_failures_waiting = 0

from app.services.plugin_mcp import build_plugin, install_plugin_routes

class RegistryProxy:
    def __getattr__(self, name):
        return getattr(get_interview_registry(), name)


plugin_registry = RegistryProxy()
plugin_server, plugin_app, plugin_auth = build_plugin(plugin_registry)


@asynccontextmanager
async def lifespan(app):
    server, sdk_app, _ = build_plugin(plugin_registry, plugin_auth)
    app.state.plugin_app = sdk_app
    app.state.plugin_events = sdk_app.events
    async with server.session_manager.run():
        await sdk_app.events.start()
        try:
            yield
        finally:
            await sdk_app.events.close()
            await get_interview_registry().clear()


app = FastAPI(title="Interview Copilot API", version=API_VERSION, lifespan=lifespan)
app.state.plugin_events = plugin_app.events


app.add_middleware(
    CORSMiddleware,
    allow_origins=list(get_settings().interview_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, object]:
    settings = get_settings()
    payload = {
        "status": "ok",
        "version": API_VERSION,
        "realtime_protocol": REALTIME_PROTOCOL_VERSION,
        "pinned_code": False,
        "chat": True,
        "appshot": True,
        "answer_transport": "codex-app-server",
        "answer_providers": ["codex", "responses"],
        "responses_model": settings.openai_responses_model,
        "chatgpt_mcp": True,
        "chatgpt_events": True,
        "mock_live_model": settings.openai_live_model,
        "realtime_transcription_model": settings.openai_realtime_transcription_model,
        "code_reasoning_effort": settings.openai_code_reasoning_effort,
        "code_model": settings.openai_code_model,
    }
    release_id = os.getenv("INTERVIEW_RELEASE_ID", "").strip()
    if release_id:
        payload["release_id"] = release_id
    return payload


@app.post("/api/interviews", status_code=status.HTTP_201_CREATED)
async def create_interview(
    request: Request,
    response: Response,
    authorization: str | None = Header(default=None),
    payload: CaptureDevice | None = None,
) -> dict[str, str]:
    configured_token = get_settings().interview_access_token
    _require_configured_or_loopback(request, configured_token)
    if configured_token and not _token_matches(_bearer_token(authorization), configured_token):
        await _reject_access_token("Invalid interview access token.", bearer=True)
    response.headers["Cache-Control"] = "no-store"
    try:
        runtime = await get_interview_registry().create(device_name=payload.device_name if payload else "我的电脑")
    except OpenAIRealtimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from None
    return {
        "interview_id": runtime.interview_id,
        "session_token": runtime.session_token,
        "capture_token": runtime.capture_token,
        "conversation_id": runtime.conversation_id,
        "expires_at": runtime.expires_at.isoformat().replace("+00:00", "Z"),
    }


@app.post("/api/browser/login")
async def browser_login(payload: BrowserLogin, request: Request, response: Response) -> dict[str, bool]:
    configured_token = get_settings().interview_access_token
    _require_configured_or_loopback(request, configured_token)
    if configured_token and not _token_matches(payload.access_token, configured_token):
        await _reject_access_token("Invalid access token.")
    if configured_token:
        response.set_cookie(
            key=BROWSER_COOKIE_NAME,
            value=_make_browser_cookie(configured_token),
            max_age=BROWSER_COOKIE_TTL_SECONDS,
            httponly=True,
            secure=_request_uses_https(request),
            samesite="strict",
            path="/",
        )
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True}


async def _require_conversation_access(request: Request, authorization: str | None):
    # A connected client can operate the personal device's conversations. Never
    # expose capture credentials or permit unauthenticated history enumeration.
    registry = get_interview_registry()
    rt = await registry.current()
    secret = get_settings().interview_access_token
    token = _bearer_token(authorization)
    if rt and rt.token_matches(token):
        return
    if secret and (_token_matches(token, secret) or _trusted_browser(request, secret)
                   or _valid_browser_cookie(request.cookies.get(BROWSER_COOKIE_NAME, ""), secret)):
        return
    raise HTTPException(status_code=401, detail="会话授权已失效，请重新连接电脑。")


@app.get("/api/conversations")
async def list_conversations(request: Request, response: Response, authorization: str | None = Header(default=None)):
    await _require_conversation_access(request, authorization)
    response.headers["Cache-Control"] = "no-store"
    return {"conversations": await get_interview_registry().conversations()}


@app.post("/api/conversations/switch")
async def switch_conversation(payload: ConversationSwitch, request: Request, response: Response,
                              authorization: str | None = Header(default=None)):
    await _require_conversation_access(request, authorization)
    response.headers["Cache-Control"] = "no-store"
    try:
        rt = await get_interview_registry().switch(payload.current_id, payload.target_id, stop_active=payload.stop_active)
    except OpenAIRealtimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return await rt.public_state()


@app.patch("/api/conversations/{identity}")
async def rename_conversation(identity: str, payload: ConversationRename, request: Request, response: Response,
                              authorization: str | None = Header(default=None)):
    await _require_conversation_access(request, authorization)
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="名称不能为空。")
    try:
        await get_interview_registry().rename(identity, title)
    except OpenAIRealtimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True}


@app.get("/api/interviews/current", response_model=None)
async def current_interview(
    request: Request,
    response: Response,
    browser_session: str | None = Cookie(default=None, alias=BROWSER_COOKIE_NAME),
) -> dict[str, object] | Response:
    configured_token = get_settings().interview_access_token
    _require_configured_or_loopback(request, configured_token)
    if configured_token and not (_valid_browser_cookie(browser_session or "", configured_token) or _trusted_browser(request, configured_token)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Browser login required.")
    response.headers["Cache-Control"] = "no-store"
    runtime = await get_interview_registry().current()
    if runtime is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": "no-store"})
    return await runtime.public_state()


@app.get("/api/devices")
async def connected_devices(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    registry = get_interview_registry()
    runtime = await registry.current()
    device = runtime.discoverable_device() if runtime and not registry.draining else None
    return {"devices": [device] if device else []}


@app.post("/api/devices/{device_id}/connect")
async def connect_browser_device(device_id: str, request: Request, response: Response) -> dict:
    _require_browser_origin(request)
    secret = get_settings().interview_access_token
    _require_configured_or_loopback(request, secret)
    registry = get_interview_registry()
    runtime = await registry.get(device_id)
    if registry.draining or not runtime or not runtime.discoverable_device():
        raise HTTPException(status_code=409, detail="这台电脑已离线，请重新选择。")
    response.headers["Cache-Control"] = "no-store"
    if _trusted_browser(request, secret or registry.browser_secret):
        return {"status": "connected", "session": await runtime.public_state()}
    if runtime.browser_connection_host is not runtime._capture_clients.get("interviewer"):
        raise HTTPException(status_code=409, detail="请重新打开电脑端 Sage，再连接。")
    previous = request.cookies.get(PAIRING_COOKIE_NAME, "").partition(".")
    token = previous[2] if previous[0] == device_id else ""
    try:
        pending, created = runtime.browser_connection.request(browser_label(request.headers.get("user-agent", "")), token)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    if created:
        sent = await runtime.send_to_capture("interviewer", {
            "type": "browser_connection_request", "request_id": pending["request_id"],
            "text": pending["name"], "expires_in": BrowserConnection.TTL_SECONDS,
        })
        if not sent:
            runtime.browser_connection.clear()
            raise HTTPException(status_code=409, detail="电脑连接已断开，请稍后重试。")
    response.set_cookie(PAIRING_COOKIE_NAME, device_id + "." + pending["token"],
                        max_age=BrowserConnection.TTL_SECONDS, httponly=True,
                        secure=_request_uses_https(request), samesite="strict", path="/")
    response.status_code = 202
    return {"status": "pending"}


@app.get("/api/browser/connection")
async def browser_connection_status(request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    device_id, _, token = request.cookies.get(PAIRING_COOKIE_NAME, "").partition(".")
    runtime = await get_interview_registry().get(device_id)
    pending = runtime.browser_connection.status(token) if runtime and runtime.discoverable_device() else None
    if not pending:
        raise HTTPException(status_code=410, detail="连接请求已失效，请重新选择电脑。")
    if pending["status"] == "approved":
        secret = get_settings().interview_access_token or get_interview_registry().browser_secret
        response.set_cookie(TRUSTED_BROWSER_COOKIE_NAME, _make_browser_cookie(secret, scope="trusted"),
                            max_age=TRUSTED_BROWSER_TTL_SECONDS, httponly=True,
                            secure=_request_uses_https(request), samesite="strict", path="/")
        return {"status": "connected", "session": await runtime.public_state()}
    return {"status": pending["status"]}


@app.delete("/api/browser/connection")
async def cancel_browser_connection(request: Request, response: Response) -> dict:
    _require_browser_origin(request)
    device_id, _, token = request.cookies.get(PAIRING_COOKIE_NAME, "").partition(".")
    runtime = await get_interview_registry().get(device_id)
    pending = runtime.browser_connection.status(token) if runtime else None
    if pending:
        runtime.browser_connection.decide(pending["request_id"], False)
        await runtime.send_to_capture("interviewer", {"type": "browser_connection_result", "request_id": pending["request_id"], "ok": False})
    response.delete_cookie(PAIRING_COOKIE_NAME, path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True}


@app.delete("/api/interviews/{interview_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_interview(
    interview_id: str,
    authorization: str | None = Header(default=None),
) -> Response:
    registry = get_interview_registry()
    runtime = await registry.get(interview_id)
    if runtime is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview session not found.")
    if not runtime.token_matches(_bearer_token(authorization)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid interview session token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    await registry.delete(interview_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/interviews/{interview_id}/screenshots")
async def upload_interview_screenshot(
    interview_id: str,
    request: Request,
    response: Response,
    authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    runtime = await get_interview_registry().get(interview_id)
    if runtime is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview session not found.")
    if not runtime.capture_token_matches(_bearer_token(authorization)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid capture token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if runtime.closed:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation has ended.")

    # Authenticate before reading a potentially large image. Bound streamed/chunked
    # bodies too: Content-Length alone is not a trustworthy size limit.
    body_limit = ((get_settings().interview_screenshot_max_bytes + 2) // 3) * 4 + 1_250_000
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > body_limit:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Screenshot upload is too large.")
        body.extend(chunk)
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid screenshot JSON.") from None
    if not isinstance(payload, dict) or any(
        not isinstance(payload.get(field), str) or not payload[field]
        for field in ("request_id", "image_data")
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="request_id and image_data are required strings.")
    for field, limit in (("request_id", 256), ("source_id", 512), ("captured_at", 80)):
        if field in payload and (not isinstance(payload[field], str) or len(payload[field]) > limit):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid screenshot {field}.")
    if "appshot" in payload:
        from app.services.appshot import validate_appshot
        try:
            payload["appshot"] = validate_appshot(payload["appshot"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
    # HTTP success must mean a real pending request received a valid image, not
    # that a client-supplied error or arbitrary stale frame was accepted.
    payload = {key: payload[key] for key in ("request_id", "image_data", "source_id", "captured_at", "appshot") if key in payload}
    try:
        accepted = await runtime.accept_screen_snapshot(payload)
    except OpenAIRealtimeError as exc:
        code = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE if "size limit" in str(exc) or "too large" in str(exc) else status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=code, detail=str(exc)) from None
    if not accepted:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Screenshot request is no longer pending.")
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True}


async def _require_deployment_access(request: Request, authorization: str | None) -> None:
    configured_token = get_settings().interview_access_token
    _require_configured_or_loopback(request, configured_token)
    if configured_token and not _token_matches(_bearer_token(authorization), configured_token):
        await _reject_access_token("Invalid deployment access token.", bearer=True)


async def _reject_access_token(detail: str, *, bearer: bool = False) -> NoReturn:
    global _auth_failures_waiting
    if _auth_failures_waiting >= MAX_WAITING_AUTH_FAILURES:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many failed access attempts.")
    _auth_failures_waiting += 1
    try:
        async with _auth_failure_lock:
            await asyncio.sleep(AUTH_FAILURE_DELAY_SECONDS)
    finally:
        _auth_failures_waiting -= 1
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail,
                        headers={"WWW-Authenticate": "Bearer"} if bearer else None)


@app.get("/api/deployment")
async def deployment_state(
    request: Request, response: Response, authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    await _require_deployment_access(request, authorization)
    response.headers["Cache-Control"] = "no-store"
    state = await get_interview_registry().deployment_state()
    state["active"] = state["active"] or await app.state.plugin_events.has_pending()
    return state


@app.post("/api/deployment")
async def begin_deployment(
    request: Request, response: Response, authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    await _require_deployment_access(request, authorization)
    registry = get_interview_registry()
    async with app.state.plugin_events.request_lock:
        if await app.state.plugin_events.has_pending() or not await registry.begin_deployment():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An interview or event delivery is active. Deployment was not started.")
    response.headers["Cache-Control"] = "no-store"
    return await registry.deployment_state()


@app.delete("/api/deployment")
async def cancel_deployment(
    request: Request, response: Response, authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    await _require_deployment_access(request, authorization)
    registry = get_interview_registry()
    await registry.cancel_deployment()
    response.headers["Cache-Control"] = "no-store"
    return await registry.deployment_state()


@app.websocket("/ws/interviews/{interview_id}/{speaker}")
async def interview_stream(websocket: WebSocket, interview_id: str, speaker: str) -> None:
    if speaker not in {"interviewer", "candidate", "client", "model"}:
        await websocket.close(code=1008)
        return
    if not _websocket_origin_allowed(websocket):
        await websocket.close(code=1008)
        return
    runtime = await get_interview_registry().get(interview_id)
    if runtime is None:
        # Closing before the upgrade becomes HTTP 403 / browser code 1006,
        # hiding the expired-session signal and retrying stale credentials
        # forever after a server restart. Accept only to send the close frame;
        # no session, data, media or provider connection is admitted.
        await websocket.accept()
        await websocket.close(code=1008)
        return
    try:
        await runtime.serve(websocket, cast(ConnectionRole, speaker))
    except WebSocketDisconnect:
        return
    except OpenAIRealtimeError as exc:
        await _send_socket_error(websocket, str(exc))
    except Exception:
        await _send_socket_error(websocket, "The interview connection failed. Reconnect to restore the session.")


async def _send_socket_error(websocket: WebSocket, detail: str) -> None:
    try:
        async with asyncio.timeout(2):
            await websocket.send_json({"type": "error", "detail": detail})
    except Exception:
        pass
    try:
        async with asyncio.timeout(2):
            await websocket.close(code=1011)
    except Exception:
        pass


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        return ""
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer":
        return ""
    return token.strip()


def _token_matches(provided: str, expected: str) -> bool:
    return bool(provided) and hmac.compare_digest(provided, expected)


def _make_browser_cookie(secret: str, *, issued_at: int | None = None, scope: str = "browser") -> str:
    issued = int(time.time()) if issued_at is None else issued_at
    signature = hmac.new(
        hashlib.sha256(secret.encode("utf-8")).digest(),
        f"{scope}:{issued}".encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return f"{issued}.{signature}"


def _valid_browser_cookie(value: str, secret: str, *, now: int | None = None, scope: str = "browser", ttl: int = BROWSER_COOKIE_TTL_SECONDS) -> bool:
    issued_text, separator, signature = value.partition(".")
    if not separator or not issued_text.isdigit() or not signature:
        return False
    issued = int(issued_text)
    current = int(time.time()) if now is None else now
    if issued > current + 60 or current - issued > ttl:
        return False
    expected = _make_browser_cookie(secret, issued_at=issued, scope=scope)
    return hmac.compare_digest(value, expected)


def _trusted_browser(request: Request, secret: str) -> bool:
    return bool(secret) and _valid_browser_cookie(request.cookies.get(TRUSTED_BROWSER_COOKIE_NAME, ""), secret,
                                                 scope="trusted", ttl=TRUSTED_BROWSER_TTL_SECONDS)


def _require_browser_origin(request: Request) -> None:
    origin = request.headers.get("origin", "").rstrip("/")
    scheme = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip() or request.url.scheme
    host = request.headers.get("host", "")
    if request.headers.get("sec-fetch-site") == "cross-site" or not origin or (
        origin != f"{scheme}://{host}" and origin not in get_settings().interview_allowed_origins
    ):
        raise HTTPException(status_code=403, detail="请从 Sage 页面发起连接。")


def _request_uses_https(request: Request) -> bool:
    forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https" or not _is_loopback_request(request)


def _require_configured_or_loopback(request: Request, configured_token: str) -> None:
    if not configured_token and not _is_loopback_request(request):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="INTERVIEW_ACCESS_TOKEN is required for remote access.",
        )


def _is_loopback_request(request: Request) -> bool:
    host = (request.url.hostname or "").strip("[]").lower()
    client_host = (request.client.host if request.client else "").strip("[]").lower()
    return _is_loopback_host(host) and _is_loopback_host(client_host)


def _is_loopback_host(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _websocket_origin_allowed(websocket: WebSocket) -> bool:
    raw_origin = (websocket.headers.get("origin") or "").strip()
    if not raw_origin or raw_origin in {"null", "file:", "file://"}:
        return True
    origin = raw_origin.rstrip("/")
    if origin in get_settings().interview_allowed_origins:
        return True
    forwarded_proto = websocket.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    scheme = forwarded_proto or ("https" if websocket.url.scheme == "wss" else "http")
    host = (
        websocket.headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
        or websocket.headers.get("host", "").strip()
    )
    return bool(host) and origin == f"{scheme}://{host}".rstrip("/")


class InterviewStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict) -> Response:
        response = await super().get_response(path, scope)
        # Stable URLs must revalidate after a release, including conditional 304s.
        # Otherwise an old HTML entry point can reference removed hashed assets.
        if path in {".", "index.html", "pcm-worklet.js"}:
            response.headers["Cache-Control"] = "no-cache"
        return response


def _mount_web_app() -> None:
    server_root = Path(__file__).resolve().parents[1]
    candidates = (server_root / "web", server_root.parent / "desktop" / "dist")
    for candidate in candidates:
        if (candidate / "index.html").is_file():
            app.mount("/", InterviewStaticFiles(directory=candidate, html=True), name="web")
            return


from app.services.plugin_event_routes import install_event_routes
install_event_routes(app, plugin_registry)


@app.api_route(
    "/api/{unmatched_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def unmatched_api(unmatched_path: str) -> None:
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API route not found.")


@app.websocket("/ws/{unmatched_path:path}")
async def unmatched_websocket(websocket: WebSocket, unmatched_path: str) -> None:
    await websocket.close(code=1008)


install_plugin_routes(app, plugin_app, plugin_auth, plugin_registry)
_mount_web_app()

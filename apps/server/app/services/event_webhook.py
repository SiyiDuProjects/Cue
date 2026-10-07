"""Bounded Standard Webhooks delivery, with DNS validation at the socket boundary."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import socket
import time
from urllib.parse import urlsplit

import httpcore


class CallbackError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__("ChatGPT 回调验证或投递失败。")


def callback_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 33 for c in value):
        raise CallbackError("invalid_url")
    try:
        url = urlsplit(value)
        if (url.scheme != "https" or not url.hostname or url.username is not None or
                url.password is not None or url.fragment or url.port not in (None, 443)):
            raise ValueError()
        url.hostname.encode("ascii")
    except (ValueError, UnicodeError):
        raise CallbackError("invalid_url") from None
    return value


def signing_key(secret):
    try:
        if not isinstance(secret, str) or not secret.startswith("whsec_") or len(secret) > 100:
            raise ValueError()
        key = base64.b64decode(secret[6:], validate=True)
        if not 24 <= len(key) <= 64:
            raise ValueError()
        return key
    except ValueError:
        raise CallbackError("invalid_secret") from None


def signed_headers(subscription, event_id, body, now=None):
    timestamp = str(int(time.time() if now is None else now))
    message = event_id.encode() + b"." + timestamp.encode() + b"." + body
    secrets = [subscription["secret"]]
    if subscription.get("old_secret") and subscription.get("rotate_until", 0) > int(timestamp):
        secrets.append(subscription["old_secret"])
    signatures = ["v1," + base64.b64encode(hmac.digest(signing_key(secret), message, hashlib.sha256)).decode()
                  for secret in secrets]
    return {"Content-Type": "application/json", "webhook-id": event_id,
            "webhook-timestamp": timestamp, "webhook-signature": " ".join(signatures),
            "X-MCP-Subscription-Id": subscription["id"]}


class PublicNetworkBackend(httpcore.AsyncNetworkBackend):
    def __init__(self):
        self.backend = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        # Resolve once, validate every result, then connect to that literal IP.
        # httpcore subsequently passes the ORIGINAL hostname to start_tls (SNI
        # and certificate verification), preventing DNS rebinding/TOCTOU.
        addresses = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        ips = list(dict.fromkeys(item[4][0] for item in addresses))
        if not ips or any(not self.public_ip(ip) for ip in ips):
            raise CallbackError("blocked_address")
        last_error = None
        for ip in ips:
            try:
                return await self.backend.connect_tcp(ip, port, timeout, local_address, socket_options)
            except (OSError, httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        raise last_error or CallbackError("connection_failed")

    @staticmethod
    def public_ip(value):
        try:
            ip = ipaddress.ip_address(value)
            if isinstance(ip, ipaddress.IPv6Address) and (ip.ipv4_mapped or ip.sixtofour or ip.teredo):
                return False
            return ip.is_global and not ip.is_multicast and not ip.is_reserved
        except ValueError:
            return False


async def post_webhook(url, headers, body):
    callback_url(url)
    if len(body) > 262144:
        raise CallbackError("payload_too_large")
    try:
        async with asyncio.timeout(10):
            # No proxy environment, redirects, cookies, or shared connection pool.
            async with httpcore.AsyncConnectionPool(network_backend=PublicNetworkBackend(), retries=0) as pool:
                async with pool.stream("POST", url, headers=headers, content=body) as response:
                    content = bytearray()
                    async for chunk in response.aiter_stream():
                        content.extend(chunk)
                        if len(content) > 8192:
                            raise CallbackError("response_too_large")
                    return response.status, bytes(content)
    except (TimeoutError, httpcore.TimeoutException):
        raise CallbackError("timeout") from None
    except (OSError, httpcore.NetworkError, httpcore.ProtocolError):
        raise CallbackError("connection_failed") from None


def body_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()

"""One bounded, expiring browser approval request per capture host."""
from __future__ import annotations

import hmac
import secrets
import time


class BrowserConnection:
    TTL_SECONDS = 120

    def __init__(self) -> None:
        self.pending: dict | None = None

    def current(self) -> dict | None:
        if self.pending and self.pending["deadline"] <= time.monotonic():
            self.pending = None
        return self.pending

    def request(self, name: str, token: str = "") -> tuple[dict, bool]:
        previous = self.current()
        if previous and previous["status"] != "denied" and token and hmac.compare_digest(previous["token"], token):
            return previous, False
        if previous and previous["status"] == "pending":
            raise ValueError("电脑正在确认另一个连接，请稍后再试。")
        self.pending = {
            "request_id": secrets.token_urlsafe(18), "token": secrets.token_urlsafe(32),
            "name": name, "deadline": time.monotonic() + self.TTL_SECONDS,
            "status": "pending",
        }
        return self.pending, True

    def status(self, token: str) -> dict | None:
        current = self.current()
        return current if current and token and hmac.compare_digest(current["token"], token) else None

    def decide(self, request_id: str, approved: bool) -> bool:
        current = self.current()
        if not current or current["request_id"] != request_id or current["status"] != "pending":
            return False
        current["status"] = "approved" if approved else "denied"
        return True

    def clear(self) -> None:
        self.pending = None


def browser_label(user_agent: str) -> str:
    # Only a short standard label leaves this endpoint; never forward raw UA.
    device = "iPhone" if "iPhone" in user_agent else "iPad" if "iPad" in user_agent else "Android" if "Android" in user_agent else "Mac" if "Macintosh" in user_agent else "Windows" if "Windows" in user_agent else "浏览器"
    browser = "Edge" if "Edg" in user_agent else "Chrome" if "Chrome" in user_agent or "CriOS" in user_agent else "Firefox" if "Firefox" in user_agent or "FxiOS" in user_agent else "Safari" if "Safari" in user_agent else ""
    return f"{device} · {browser}" if browser else device

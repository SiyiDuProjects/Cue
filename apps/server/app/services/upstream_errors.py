"""Actionable provider failures without echoing provider input or credentials."""
from __future__ import annotations

from typing import Any


class ProviderRequestError(RuntimeError):
    """Only constructed from an application-owned message, never raw API text."""


def provider_error(event: dict[str, Any], *, fallback: str) -> ProviderRequestError:
    error = event.get("error")
    code = error.get("code") if isinstance(error, dict) else None
    if code in {"context_length_exceeded", "context_window_exceeded"}:
        return ProviderRequestError("本场上下文超过模型容量，记录未被裁剪。请开始新面试，或换用更大上下文的模型。")
    if code == "credit_balance_exhausted":
        return ProviderRequestError(
            "OpenAI API 可用额度已耗尽。请检查当前后端 API key 所属账户的额度；恢复后重试，已有面试记录仍保留。"
        )
    if code == "insufficient_quota":
        return ProviderRequestError(
            "OpenAI API 配额不足。请检查当前后端 API key 所属项目的额度和用量限制；恢复后重试，已有面试记录仍保留。"
        )
    return ProviderRequestError(fallback)

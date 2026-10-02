"""Wire helpers for the optional speaking mock interviewer only."""
import asyncio
import json
from typing import Any

SEND_TIMEOUT_SECONDS = 10.0
SEND_BYTES_PER_SECOND = 64_000


async def send(socket: Any, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False)
    async with asyncio.timeout(SEND_TIMEOUT_SECONDS + len(data) / SEND_BYTES_PER_SECOND):
        await socket.send(data)


def text_chunks(text: str):
    # <= 400 UTF-8 bytes is a conservative bound below the 500-token append cap.
    # Preserve every character, including multibyte Chinese, without truncation.
    chunk, size = [], 0
    for character in text:
        width = len(character.encode("utf-8"))
        if size + width > 400:
            yield "".join(chunk)
            chunk, size = [], 0
        chunk.append(character)
        size += width
    if chunk:
        yield "".join(chunk)


async def append_context(socket: Any, text: str, *, instruction: bool = False) -> None:
    for chunk in text_chunks(text):
        await send(socket, {"type": "session.instructions.append" if instruction else "session.thinking.append",
                            "delegation_id": None, "content": chunk})


async def add_backend_text(socket: Any, text: str) -> None:
    await send(socket, {"type": "response.item.create", "item": {"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": text}]}})

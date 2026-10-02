"""Source-labelled realtime ASR. Speech updates context; it never starts an answer."""
from __future__ import annotations

import uuid
import asyncio
from typing import Any


class TranscriptionDrain:
    """Track submitted commits until their asynchronous final transcripts arrive."""
    def __init__(self):
        self.requested = 0
        self.completed = set()
        self.changed = asyncio.Event()
        self.closed = False

    async def wait(self):
        while len(self.completed) < self.requested:
            self.changed.clear()
            if self.closed:
                raise RuntimeError('转录连接已中断，最后一段可能未完成。')
            await self.changed.wait()

    def handle(self, event):
        if event.get('type') == 'conversation.item.input_audio_transcription.completed':
            self.completed.add(event.get('item_id'))
            self.changed.set()

    def close(self):
        self.closed = True
        self.changed.set()


class TranscriptRelay:
    def __init__(self, runtime: Any, speaker: str):
        self.runtime, self.speaker = runtime, speaker
        self.namespace = uuid.uuid4().hex
        self.items: dict[str, dict] = {}
        self.seen: set[str] = set()

    async def handle(self, event: dict) -> None:
        kind, identity = event.get("type"), event.get("item_id")
        if kind not in {"input_audio_buffer.speech_started", "input_audio_buffer.committed",
                        "conversation.item.input_audio_transcription.delta",
                        "conversation.item.input_audio_transcription.completed"}:
            return
        event_id = event.get("event_id")
        if event_id and event_id in self.seen:
            return
        if not identity:
            raise ValueError("Transcription is missing its native item_id.")
        if event_id:
            self.seen.add(event_id)
        item = self.items.setdefault(identity, {"turn_id": f"{self.speaker}:{self.namespace}:{identity}",
                                               "text": "", "status": "streaming"})
        delta = ""
        if kind.endswith(".completed"):
            item.update(text=str(event.get("transcript") or ""), status="completed")
        elif kind.endswith(".delta"):
            if item["status"] != "streaming":
                return
            delta = str(event.get("delta") or "")
            item["text"] += delta
        await self.runtime.update_transcript(self.speaker, **item, delta=delta)

    async def close(self) -> None:
        for item in self.items.values():
            if item["status"] == "streaming":
                item["status"] = "interrupted"
                await self.runtime.update_transcript(self.speaker, **item)

"""Application records only. Codex retains the model thread and its context."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import hashlib
import json
import sqlite3

from app.services.realtime_history import observed_at
from app.services.workspace_history import WorkspaceHistory


class ConversationStore(WorkspaceHistory):
    def __init__(self, directory: str, owner: str):
        super().__init__(directory, owner)
        self._image_refs = {}
        self._saved_images = set()
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS conversation_images (owner TEXT, id TEXT, body TEXT, PRIMARY KEY(owner,id))")
            db.execute("CREATE TABLE IF NOT EXISTS conversations (owner TEXT, id TEXT, title TEXT, "
                       "updated TEXT, body TEXT, PRIMARY KEY(owner,id))")
            db.execute("CREATE TABLE IF NOT EXISTS conversation_current (owner TEXT PRIMARY KEY, id TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS transcription_buffers (owner TEXT, id TEXT, body TEXT, PRIMARY KEY(owner,id))")
            db.execute("CREATE TABLE IF NOT EXISTS transcription_current (owner TEXT PRIMARY KEY, id TEXT)")

    def read_transcription(self):
        with self.connect() as db:
            row = db.execute("SELECT b.body FROM transcription_buffers b JOIN transcription_current c "
                             "ON b.owner=c.owner AND b.id=c.id WHERE b.owner=?", (self.owner,)).fetchone()
            return self._decode(db, row[0]) if row else None

    def read_transcription_by_id(self, identity):
        with self.connect() as db:
            row = db.execute("SELECT body FROM transcription_buffers WHERE owner=? AND id=?", (self.owner, identity)).fetchone()
            return self._decode(db, row[0]) if row else None

    def _encode(self, record):
        """Store immutable image payloads once, outside frequently saved JSON."""
        images = {}

        def visit(value):
            if isinstance(value, list):
                return [visit(item) for item in value]
            if not isinstance(value, dict):
                return value
            result = {}
            for key, item in value.items():
                if key == 'image_url' and isinstance(item, str) and item.startswith('data:image/'):
                    identity = self._image_refs.get(item)
                    if identity is None:
                        identity = hashlib.sha256(item.encode()).hexdigest()
                        self._image_refs[item] = identity
                        if len(self._image_refs) > 64:
                            self._image_refs.pop(next(iter(self._image_refs)))
                    if identity not in self._saved_images:
                        images[identity] = item
                    result[key] = {'$sage_image': identity}
                else:
                    result[key] = visit(item)
            return result

        return json.dumps(visit(record), ensure_ascii=False), images

    def _write_images(self, db, images):
        db.executemany("INSERT OR IGNORE INTO conversation_images VALUES (?,?,?)",
                       ((self.owner, identity, image) for identity, image in images.items()))

    def _decode(self, db, body):
        images = {}

        def visit(value):
            if isinstance(value, list):
                return [visit(item) for item in value]
            if not isinstance(value, dict):
                return value
            if set(value) == {'$sage_image'}:
                identity = value['$sage_image']
                if identity not in images:
                    row = db.execute("SELECT body FROM conversation_images WHERE owner=? AND id=?",
                                     (self.owner, identity)).fetchone()
                    if not row:
                        raise sqlite3.DatabaseError('Saved screenshot is missing; original records were not changed.')
                    images[identity] = row[0]
                return images[identity]
            return {key: visit(item) for key, item in value.items()}

        # Legacy inline-image records remain readable and migrate on their next save.
        return visit(json.loads(body))

    def save_transcription(self, record):
        body, images = self._encode(record)
        with self.connect() as db:
            self._write_images(db, images)
            db.execute("INSERT INTO transcription_buffers VALUES (?,?,?) ON CONFLICT(owner,id) DO UPDATE SET body=excluded.body",
                       (self.owner, record['id'], body))
            db.execute("INSERT INTO transcription_current VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET id=excluded.id",
                       (self.owner, record['id']))
        self._saved_images.update(images)

    def save(self, identity: str, record: dict):
        body, images = self._encode(record)
        with self.connect() as db:
            self._write_images(db, images)
            db.execute("INSERT INTO conversations VALUES (?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET "
                       "title=excluded.title,updated=excluded.updated,body=excluded.body",
                       (self.owner, identity, record["title"], record["updated_at"], body))
        self._saved_images.update(images)

    def select(self, identity: str):
        with self.connect() as db:
            db.execute("INSERT INTO conversation_current VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET id=excluded.id",
                       (self.owner, identity))

    def selected(self):
        with self.connect() as db:
            row = db.execute("SELECT id FROM conversation_current WHERE owner=?", (self.owner,)).fetchone()
        return row[0] if row else None

    def list(self):
        with self.connect() as db:
            return [{"interview_id": row[0], "title": row[1], "updated_at": row[2]}
                    for row in db.execute("SELECT id,title,updated FROM conversations WHERE owner=? ORDER BY updated DESC,id",
                                          (self.owner,))]

    def read(self, identity: str):
        with self.connect() as db:
            row = db.execute("SELECT body FROM conversations WHERE owner=? AND id=?", (self.owner, identity)).fetchone()
            return self._decode(db, row[0]) if row else None


def snapshot(rt):
    return deepcopy({
        "format": 1, "title": rt.title, "updated_at": rt.updated_at, "device_name": rt.device_name,
        "entries": rt.history.entries, "screens": rt.collected_screens, "mode": rt.mode,
        "question_id": rt.current_question_id, "context_revision": rt.context_revision,
        "code": rt.code_workspace.export_problem(), "code_revision": rt.code_workspace.revision,
        "answers": rt.response_buffers, "answer_order": rt.response_order,
        "answer_status": rt.response_status, "answer_details": rt.response_details,
        "answer_metadata": rt._response_metadata, "operations": rt.operations,
        "codex": {"thread_id": rt.chat.session_id, "sent_turns": rt.chat.sent_turns, "sent_messages": rt.chat.sent_messages},
        "responses": {"previous_id": rt.chat.responses.previous_id, "sent_turns": rt.chat.responses.sent_turns,
                      "sent_messages": rt.chat.responses.sent_messages,
                      "materials_catalog_revision": rt.chat.responses.materials_catalog_revision},
    })


def restore(rt, record):
    if record.get("format") != 1:
        raise ValueError("会话记录版本不兼容，原文件未修改。")
    rt.title, rt.updated_at = record["title"], record["updated_at"]
    rt.device_name, rt.mode = record.get("device_name", "我的电脑"), record.get("mode", "assist")
    rt.capture_mode = rt.mode
    rt.current_question_id = record.get("question_id", "")
    rt.context_revision = record.get("context_revision", 0) + 1
    rt.history.entries = deepcopy(record["entries"])
    for entry in rt.history.entries:
        kind = entry["kind"]
        identity = entry.get("turn_id", "") if kind == "transcript" else (
            "chat:" + entry["message_id"] if kind == "chat_request" else
            f"{kind}:{entry.get('response_id') or entry.get('request_id') or entry.get('analysis_id', '')}")
        rt.history.by_id[identity] = entry
        if kind == "transcript":
            if entry.get("status") == "streaming":
                entry["status"] = "interrupted"
            rt.history.turns.append(entry)
    rt.collected_screens = record.get("screens", [])
    code = record["code"]
    rt.code_workspace.workspace_id = code["problem_id"]
    rt.code_workspace.current, rt.code_workspace.versions = code["current"], code["versions"]
    rt.code_workspace.revision = record["code_revision"]
    rt.response_buffers, rt.response_order = record["answers"], record["answer_order"]
    rt.response_status, rt.response_details = record["answer_status"], record["answer_details"]
    rt._response_metadata, rt.operations = record["answer_metadata"], record["operations"]
    from app.services.chat_activity import finish_activities
    for metadata in rt._response_metadata.values():
        finish_activities(metadata)
    for identity, status in rt.response_status.items():
        if status == "streaming":
            rt.response_status[identity] = "interrupted"
            rt.response_details[identity] = "上次连接中断，已显示内容保留；未自动重新生成。"
    rt.started_responses.update(rt.response_order)
    rt.terminal_responses.update(rt.response_order)
    for op in rt.operations.values():
        if op["status"] not in {"completed", "failed", "cancelled"}:
            op.update(status="cancelled", detail="上次连接中断，未自动重发。")
    codex = record.get("codex", {})
    rt.chat.session_id = codex.get("thread_id")
    rt.chat.sent_turns = codex.get("sent_turns", {})
    rt.chat.sent_messages = codex.get("sent_messages")
    rt.chat.resume_missing = not rt.chat.session_id and any(e["kind"] == "chat_request" and e.get("provider", "codex") == "codex" for e in rt.history.entries)
    responses = record.get("responses", {})
    rt.chat.responses.previous_id = responses.get("previous_id")
    rt.chat.responses.sent_turns = responses.get("sent_turns", {})
    rt.chat.responses.sent_messages = responses.get("sent_messages", [])
    rt.chat.responses.materials_catalog_revision = responses.get("materials_catalog_revision")


class ConversationJournal:
    """Coalesce streaming checkpoints; terminal events and switches flush explicitly."""
    def __init__(self, runtime, store):
        self.runtime, self.store = runtime, store
        self.lock = asyncio.Lock()
        self.task = None
        self.dirty = False
        self.error = ""

    def changed(self):
        self.runtime.updated_at = observed_at()
        self.dirty = True
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._later())

    async def _later(self):
        await asyncio.sleep(0.5)
        await self.flush()

    async def flush(self):
        async with self.lock:
            record = snapshot(self.runtime)
            self.dirty = False
            try:
                identity = self.runtime.conversation_id
                transcription = self.runtime.transcription.export()
                await asyncio.to_thread(self.store.save_transcription, transcription)
                await asyncio.to_thread(self.store.save, identity, record)
                self.error = ""
            except (OSError, sqlite3.Error):
                self.error = "会话未能保存到磁盘，请勿关闭或切换；本场内容仍在内存中。"
                self.dirty = True
                await self.runtime.broadcast_to_clients({"type": "persistence_error", "detail": self.error})
        if self.dirty and not self.error:
            self.task = asyncio.create_task(self._later())

    async def close(self):
        if self.task and self.task is not asyncio.current_task() and not self.task.done():
            # A worker-thread SQLite commit cannot be cancelled. Let the pending
            # checkpoint finish before writing the final state.
            await asyncio.gather(self.task, return_exceptions=True)
        await self.flush()

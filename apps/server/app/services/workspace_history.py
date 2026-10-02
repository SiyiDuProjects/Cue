"""Private, local workspace archives. No credentials, audio or Live state are stored."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path


class WorkspaceHistory:
    def __init__(self, directory: str, owner: str):
        self.path = Path(directory).expanduser() / "workspaces.sqlite3"
        self.owner = hashlib.sha256((owner or "local-personal-workspace").encode()).hexdigest()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS workspace (owner TEXT, interview TEXT, problem TEXT, "
                       "updated TEXT, title TEXT, body TEXT, PRIMARY KEY(owner, interview, problem))")
        # On Windows permissions inherit from the private server data directory.
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def save(self, interview: str, record: dict):
        if not record.get("current") and not record.get("proposal") and not record.get("question_context") and not any(f.get("code") for f in record.get("files", [])):
            return
        with self.connect() as db:
            db.execute("INSERT INTO workspace VALUES (?, ?, ?, ?, ?, ?) "
                       "ON CONFLICT(owner, interview, problem) DO UPDATE SET updated=excluded.updated, "
                       "title=excluded.title, body=excluded.body WHERE excluded.updated>=workspace.updated",
                       (self.owner, interview, record["problem_id"], record["updated_at"],
                        record.get("title", "题目记录"), json.dumps(record, ensure_ascii=False)))

    def list(self, exclude_interview: str):
        with self.connect() as db:
            return [{"interview_id": row[0], "problem_id": row[1], "updated_at": row[2], "title": row[3]}
                    for row in db.execute("SELECT interview, problem, updated, title FROM workspace "
                                          "WHERE owner=? AND interview<>? ORDER BY updated DESC",
                                          (self.owner, exclude_interview))]

    def read(self, interview: str, problem: str):
        with self.connect() as db:
            row = db.execute("SELECT body FROM workspace WHERE owner=? AND interview=? AND problem=?",
                             (self.owner, interview, problem)).fetchone()
        return json.loads(row[0]) if row else None


async def persist_workspace(runtime, record=None):
    """Serialize before yielding, so later changes cannot corrupt this saved version."""
    import asyncio
    store = getattr(runtime, "workspace_history", None)
    if store is None:
        return
    record = record if record is not None else runtime.code_workspace.export_problem()
    try:
        # Serialize disk writes per runtime; older saves cannot finish after newer saves.
        async with runtime.workspace_history_lock:
            await asyncio.to_thread(store.save, runtime.interview_id, record)
        runtime.workspace_history_error = ""
    except (OSError, sqlite3.Error):
        runtime.workspace_history_error = "历史暂未保存到磁盘，本场记录仍可查看。"

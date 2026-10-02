"""A pinned code answer and immutable versions; no editor mirror or task phases."""
from __future__ import annotations
from copy import deepcopy
from typing import Any
import uuid
from app.services.realtime_history import observed_at

MAX_CODE_CHARS = 80_000

class CodeWorkspaceError(ValueError):
    pass

def validate_filename(filename: Any) -> None:
    if (not isinstance(filename, str) or not filename.strip() or len(filename) > 200
            or filename.startswith(("/", "\\")) or ":" in filename
            or any(p in {"", ".", ".."} for p in filename.replace("\\", "/").split("/"))):
        raise CodeWorkspaceError("请填写有效的相对文件名。")

def validate_document(code: Any, language: Any) -> None:
    if not isinstance(code, str) or len(code) > MAX_CODE_CHARS:
        raise CodeWorkspaceError("代码内容无效或超过单次传输上限。")
    if not isinstance(language, str) or not language.strip() or len(language) > 64:
        raise CodeWorkspaceError("请填写有效的代码语言。")

class CodeWorkspace:
    def __init__(self) -> None:
        self.workspace_id = str(uuid.uuid4())
        self.revision = 0
        self.current: dict | None = None
        self.versions: list[dict] = []
        self.run_id = ""

    def publish(self, result: dict) -> dict:
        self.revision += 1
        version = {**deepcopy(result), "id": str(uuid.uuid4()), "revision": self.revision,
                   "created_at": observed_at()}
        self.current = version
        self.versions.append(deepcopy(version))
        return deepcopy(version)

    def version(self, identity: str) -> dict:
        for version in self.versions:
            if version["id"] == identity:
                return deepcopy(version)
        raise CodeWorkspaceError("这个代码版本已经不可用。")

    def snapshot(self, _context_version: int = 0) -> dict:
        return {"workspace_id": self.workspace_id, "revision": self.revision, "current": deepcopy(self.current),
                "versions": [version_summary(v) for v in reversed(self.versions)], "run_id": self.run_id,
                "reveal_id": self.current["id"] if self.current else ""}

    def export_problem(self) -> dict:
        # Retain the existing private SQLite key so old archives remain readable.
        return {"format": 2, "problem_id": self.workspace_id, "current": deepcopy(self.current),
                "versions": deepcopy(self.versions), "title": (self.current or {}).get("title", "代码记录"),
                "updated_at": observed_at()}

    def context(self) -> dict | None:
        if not self.current:
            return None
        return {"title": self.current["title"], "revision": self.revision,
                "files": [{k: f[k] for k in ("filename", "language", "code")} for f in self.current["files"]]}

def version_summary(version: dict) -> dict:
    return {k: version.get(k) for k in ("id", "revision", "title", "created_at")}

def archive_versions(record: dict) -> list[dict]:
    """Read-only conversion; never migrate or overwrite the original archive."""
    if record.get("format") == 2:
        return deepcopy(record.get("versions", []))
    versions = []
    for plan in record.get("versions") or ([record["proposal"]] if record.get("proposal") else []):
        files = {f.get("filename", "main.py"): deepcopy(f) for f in plan.get("base_files", record.get("files", []))}
        steps = plan.get("steps") or [{"changes": plan.get("changes", [plan])}]
        for step in steps:
            for change in step.get("changes", []):
                if isinstance(change.get("code"), str):
                    files[change.get("filename", "main.py")] = change
        versions.append({"id": plan.get("proposal_id", "legacy"), "revision": plan.get("version", len(versions) + 1),
            "created_at": plan.get("created_at", record.get("updated_at", "")), "title": plan.get("summary") or record.get("title", "历史代码"),
            "complexity": steps[-1].get("complexity") if steps else None,
            "files": [{"filename": name, "language": f.get("language", "text"), "code": f.get("code", ""),
                       "comparison": None} for name, f in files.items()]})
    if not versions and any(f.get("code") for f in record.get("files", [])):
        versions.append({"id": "legacy", "revision": 0, "title": record.get("title", "历史代码"),
            "created_at": record.get("updated_at", ""), "complexity": None,
            "files": [{"filename": f.get("filename", "main.py"), "language": f.get("language", "text"),
                       "code": f.get("code", ""), "comparison": None} for f in record["files"]]})
    return versions

async def run_code_operation(runtime: Any, payload: dict, operation_id: str) -> None:
    """Browsing is read-only; it never changes the current answer or model context."""
    import asyncio
    action = payload.get("action")
    if action == "load_history":
        version = runtime.code_workspace.version(payload.get("version_id"))
        entry = {"key": version["id"], "version": version}
    elif action == "load_archive":
        store = runtime.workspace_history
        interview, group = payload.get("archive_interview_id"), payload.get("archive_problem_id")
        if store is None or not isinstance(interview, str) or not isinstance(group, str):
            raise CodeWorkspaceError("历史记录不可用。")
        record = await asyncio.to_thread(store.read, interview, group)
        if not record:
            raise CodeWorkspaceError("历史记录不存在。")
        versions = archive_versions(record)
        identity = payload.get("version_id")
        version = next((v for v in versions if v["id"] == identity), None) if identity else (versions[-1] if versions else None)
        if not version:
            raise CodeWorkspaceError("历史代码版本不存在。")
        entry = {"key": f"{interview}:{group}:{identity or 'latest'}", "version": version,
                 "versions": [version_summary(v) for v in reversed(versions)],
                 "archive_interview_id": interview, "archive_problem_id": group}
    else:
        raise CodeWorkspaceError("此操作已移除；请在聊天里提出需要的修改。")
    await runtime.broadcast_to_clients({"type": "workspace_history", "entry": entry})
    await runtime.operation_status(operation_id, "completed", detail="历史代码已读取。")

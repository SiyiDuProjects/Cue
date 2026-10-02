"""Validate desktop file snapshots. SQLite is a display cache; files/Git own code."""
from copy import deepcopy
import re
from app.services.code_workspace import CodeWorkspaceError, validate_filename, validate_document


async def sync_code_files(rt, task, payload):
    if task is not rt.chat.task or task["epoch"] != rt.context_revision or rt.closed:
        raise CodeWorkspaceError("过期文件快照未同步。")
    doc = rt.code_workspace
    if doc.revision != task["code_revision"]:
        raise CodeWorkspaceError("代码视图版本已改变，文件快照未覆盖。")
    if not isinstance(payload, dict) or not re.fullmatch(r"[0-9a-f]{40,64}", str(payload.get("commit", ""))):
        raise CodeWorkspaceError("无效的 Git 文件版本。")
    commit = payload["commit"]
    if (doc.current or {}).get("git_commit") == commit:
        return
    files = payload.get("files")
    if not isinstance(files, list) or len(files) > 30:
        raise CodeWorkspaceError("文件数量超过上限。")
    names, prepared, total = set(), [], 0
    for file in files:
        if not isinstance(file, dict):
            raise CodeWorkspaceError("无效的代码文件。")
        name, code, language = (file.get(k) for k in ("filename", "code", "language"))
        validate_filename(name)
        validate_document(code, language)
        if name in names or any(part.startswith(".") for part in name.replace("\\", "/").split("/")):
            raise CodeWorkspaceError("重复或隐藏的代码文件。")
        names.add(name)
        comparison = file.get("comparison")
        if comparison is not None:
            if not isinstance(comparison, dict) or comparison.get("source") != "previous":
                raise CodeWorkspaceError("无效的文件比较版本。")
            validate_document(comparison.get("before"), language)
            comparison = {"source": "previous", "before": comparison["before"], "label": "相对上一版文件"}
        total += len(code) + len(comparison["before"] if comparison else "")
        prepared.append({"filename": name, "language": language, "code": code, "comparison": comparison})
    if total > 500000:
        raise CodeWorkspaceError("文件快照超过上限。")
    if not files and not doc.current:
        return
    title = payload.get("title", "代码文件")
    if not isinstance(title, str) or len(title) > 120:
        raise CodeWorkspaceError("文件版本标题无效。")
    version = doc.publish({"title": title, "files": prepared, "complexity": None,
                           "git_commit": commit, "interrupted": payload.get("interrupted") is True,
                           "active_file": payload.get("active_file") if payload.get("active_file") in names else None})
    task["code_revision"] = doc.revision
    task["published"] = True
    rt.history.entries.append({"kind": "code_answer", "version": deepcopy(version),
                               "response_id": "chat:" + task["operation_id"], "created_at": version["created_at"]})
    await rt.broadcast_to_clients(rt.code_state())
    from app.services.workspace_history import persist_workspace
    await persist_workspace(rt)

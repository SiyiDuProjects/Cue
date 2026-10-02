"""Bounded, resumable display of native Codex operations; no output or reasoning."""
from copy import deepcopy


async def record_activity(rt, response_id, incoming):
    from app.services.openai_realtime import _emit_answer_started_locked
    if (not isinstance(incoming, dict) or incoming.get("kind") not in
            {"command", "search", "image", "code", "file", "context"}
            or incoming.get("status") not in {"running", "completed", "failed"}
            or any(not isinstance(incoming.get(k), str) or not incoming[k]
                   or len(incoming[k]) > 180 for k in ("id", "label"))):
        return
    item = {k: incoming[k] for k in ("id", "kind", "label", "status")}
    async with rt._event_lock:
        async with rt._answer_lock:
            if response_id in rt.terminal_responses:
                return
            await _emit_answer_started_locked(rt, response_id)
            entries = rt._response_metadata.setdefault(response_id, {}).setdefault("activities", [])
            previous = next((a for a in entries if a["id"] == item["id"]), None)
            if previous:
                if previous["status"] != "running":
                    return
                previous.update(item)
            else:
                if len(entries) >= 80:
                    return
                entries.append(item)
            await rt._broadcast_clients_locked({"type": "answer_activity", "response_id": response_id,
                                               "activities": deepcopy(entries)})


def finish_activities(metadata):
    # A missing completion event is not evidence of tool success.
    for entry in metadata.get("activities", []):
        if entry["status"] == "running":
            entry["status"] = "interrupted"

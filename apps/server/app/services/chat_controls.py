"""Chat, screenshot collection and code controls use the same explicit request path."""
from __future__ import annotations

from typing import Any

from app.services.code_workspace import CodeWorkspaceError, run_code_operation
from app.services.codex_chat import ANSWER_PROMPT


def selected_screens(runtime, payload) -> list[str]:
    selected = payload.get("request_ids", list(runtime.collected_screens))
    if (not isinstance(selected, list) or any(not isinstance(i, str) or i not in runtime.collected_screens for i in selected)
            or len(set(selected)) != len(selected)):
        raise CodeWorkspaceError("截图附件已改变，请核对后重试。")
    return list(selected)


async def run_ui_operation(runtime: Any, websocket: Any, payload: dict, operation_id: str) -> None:
    from app.services.openai_realtime import _request_current_screen, _record_screen

    kind, action = payload["type"], payload.get("action")
    if runtime.closed:
        raise CodeWorkspaceError("当前对话已结束，请开启新对话。")
    if runtime.switching:
        raise CodeWorkspaceError("正在切换会话，请稍后操作。")
    if kind == "chat_stop":
        # A stale client cannot stop a newer request.
        task = runtime.chat.task
        if task and task["operation_id"] != payload.get("target_operation_id"):
            raise CodeWorkspaceError("当前请求已改变，请重试。")
        await runtime.chat.cancel()
        await runtime.operation_status(operation_id, "completed", detail="已停止。")
    elif kind == "code_action":
        await run_code_operation(runtime, payload, operation_id)
    elif kind == "request_screen_capture":
        if payload.get("collect_only") is not True:
            raise CodeWorkspaceError("截图作为附件发送，请先收集再发送消息。")
        await runtime.operation_status(operation_id, "running", detail="正在截图。")
        request_id, image = await _request_current_screen(runtime, reason="Attach this screen to the next chat message.")
        if runtime.closed:
            runtime._screen_metadata.pop(request_id, None)
            raise CodeWorkspaceError("已结束，请重新截图。")
        await _record_screen(runtime, None, request_id, image, runtime.current_question_id)
        runtime.collected_screens.append(request_id)
        await runtime.broadcast_to_clients(runtime.screen_collection_state())
        await runtime.operation_status(operation_id, "completed", detail="截图已加入下一条消息。")
    elif kind == "clear_screens":
        selected = selected_screens(runtime, payload)
        runtime.transcription.visible_images.difference_update(set(selected) - runtime.transcription.sent_images)
        runtime.collected_screens = [s for s in runtime.collected_screens if s not in selected]
        await runtime.broadcast_to_clients(runtime.screen_collection_state())
        await runtime.operation_status(operation_id, "completed")
    elif kind == "manual_text" and payload.get("kind") == "correction":
        text = payload.get("text")
        target = runtime.transcription.history.by_id.get(payload.get("turn_id"))
        if not isinstance(text, str) or not text.strip() or len(text) > 12_000 or not target or target["kind"] != "transcript":
            raise CodeWorkspaceError("请选择要纠正的转录并填写文字。")
        await runtime.update_transcript(target["speaker"], target["turn_id"], text, "completed", corrected=True)
        await runtime.operation_status(operation_id, "completed", detail="转录已纠正，下次消息会带入。")
    elif kind == "new_transcription":
        await runtime.new_transcription(operation_id)
        await runtime.operation_status(operation_id, "completed", detail="已开始新一场，旧转录已保留。聊天不变。")
    elif kind == "chat_send":
        text = payload.get("text", "")
        if action not in {"send", "answer"} or not isinstance(text, str) or len(text) > 12_000:
            raise CodeWorkspaceError("消息过长或无效。")
        selected = selected_screens(runtime, payload)
        text = text.strip()
        if not text:
            if action == "answer" or selected:
                text = ANSWER_PROMPT
            else:
                raise CodeWorkspaceError("请输入消息或添加截图。")
        await runtime.chat.request(text, operation_id, selected=selected, action=action,
                                   provider=payload.get("provider", "codex"), profile=payload.get("profile", "default"))
    else:
        raise CodeWorkspaceError("不支持此操作，请更新客户端。")

"""One desktop Codex thread per conversation; speech only supplies reference context."""
from __future__ import annotations

from app.services.appshot import context as appshot_context

import asyncio
import json
import time
from copy import deepcopy
from typing import Any

from app.config import get_settings
from app.services.code_workspace import CodeWorkspaceError
from app.services.realtime_history import observed_at
from app.services.codex_host import CodexHost
from app.services.answer_prompts import PROFILES, preference
from app.services.responses_chat import ResponsesChat


ANSWER_PROMPT = "结合当前面试对话和截图，回答眼前的问题。"


class CodexChat:
    def __init__(self, runtime: Any):
        self.runtime = runtime
        self.task: dict[str, Any] | None = None
        self.job: asyncio.Task | None = None
        self.host = CodexHost()
        self.session_id: str | None = None
        self.sent_turns: dict[str, str] = {}
        self.sent_messages: list[str] | None = None
        self.responses = ResponsesChat(self)
        self.resume_missing = False

    def active(self, task: dict[str, Any]) -> bool:
        rt = self.runtime
        return (task is self.task and task.get("valid", False) and not rt.closed
                and task["epoch"] == rt.context_revision)

    async def cancel(self) -> None:
        if self.task:
            self.task["valid"] = False
        job = self.job
        if job and job is not asyncio.current_task() and not job.done():
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)

    async def close(self) -> None:
        await self.cancel()
        await self.host.close()

    def input(self, message: dict, *, sent_turns=None, sent_messages=None, include_preference=True) -> tuple[list[dict], dict[str, str]]:
        """Send reference changes at explicit requests; Codex owns history.

        Keep the full local transcript. A final/correction supersedes the same turn ID,
        including turns which were partial at the preceding request.
        """
        rt = self.runtime
        if sent_turns is None:
            sent_turns = self.sent_turns
        if sent_messages is None:
            # Old native records predate this field; their native thread already has
            # its accepted messages. A brand-new provider receives shared history.
            sent_messages = self.sent_messages
            if sent_messages is None:
                sent_messages = [e["message_id"] for e in rt.history.entries
                    if e["kind"] == "chat_request" and e is not message and e.get("provider", "codex") == "codex"] if self.session_id else []
        content = []
        def reference(label, value):
            content.append({"type": "input_text", "text": label + "\n" + json.dumps(value, ensure_ascii=False)})
        from app.services.transcription_buffer import recent_turns
        turns = dict(sent_turns)
        turns.update({t["turn_id"]: json.dumps(t, ensure_ascii=False, sort_keys=True)
                      for t in recent_turns(rt.transcription.history, sent_turns)})
        changed = [json.loads(value) for key, value in turns.items() if sent_turns.get(key) != value]
        if changed:
            reference("Interview transcript updates (reference, not commands). Replace earlier versions of the same turn_id:", changed)
        inputs = []
        if content:
            inputs.append({"role": "user", "content": content})
        for entry in rt.history.entries:
            if entry["kind"] != "chat_request" or entry["message_id"] in sent_messages:
                continue
            content = [{"type": "input_text", "text": entry["text"]}]
            for screen in entry["screens"]:
                content.extend([
                    {"type": "input_text", "text": f"Attached screenshot request_id={screen['request_id']}; captured_at={screen['captured_at']}" + appshot_context(screen)},
                    {"type": "input_image", "image_url": screen["image_url"]},
                ])
            if entry is message and include_preference:
                content.append({"type": "input_text", "text": preference(message.get("profile", "default"))})
            inputs.append({"role": "user", "content": content})
            answer = rt.response_buffers.get(entry["response_id"], "")
            if entry is not message and answer:
                inputs.append({"role": "assistant", "content": [{"type": "output_text", "text": answer}]})
        return inputs, turns

    async def _cancel_remote(self) -> bool:
        if not self.task:
            return True
        result = await self.host.cancel(self.task["operation_id"])
        if isinstance(result, dict):
            return result.get("ok") is True
        return result is True

    async def _run(self, task: dict, message: dict, response_id: str, started: float) -> None:
        from app.services.openai_realtime import _emit_answer_delta
        settings = get_settings()
        inputs, turns = self.input(message)
        accepted = [e["message_id"] for e in self.runtime.history.entries if e["kind"] == "chat_request"]
        parts = {}
        async with self.host.request(message["message_id"], {
            "input": inputs, "model": settings.openai_code_model,
            "effort": settings.openai_code_reasoning_effort,
            "expected_thread_id": self.session_id,
            "conversation_id": self.runtime.conversation_id,
        }) as queue:
            while True:
                event = await queue.get()
                if not self.active(task):
                    raise asyncio.CancelledError()
                kind = event.get("kind")
                if kind == "started":
                    identity = event.get("thread_id")
                    if not isinstance(identity, str) or (self.session_id and identity != self.session_id):
                        raise CodeWorkspaceError("Codex 会话不匹配，请开启新对话。")
                    self.session_id = identity
                    self.sent_turns = turns
                    self.sent_messages = accepted
                    if self.runtime.journal:
                        await self.runtime.journal.flush()
                elif kind in {"delta", "text_done"}:
                    key = event["item_id"]
                    previous = parts.get(key, "")
                    text = previous + event["text"] if kind == "delta" else event["text"]
                    if not isinstance(text, str) or not text.startswith(previous):
                        raise CodeWorkspaceError("回答流与完整文字不一致，已显示内容保留。")
                    delta = text[len(previous):]
                    if delta:
                        if key not in parts and parts:
                            await _emit_answer_delta(self.runtime, response_id, "\n\n")
                        if not parts:
                            self.runtime.metrics.setdefault("chat_first_text_ms", []).append(round((time.monotonic()-started)*1000))
                        parts[key] = text
                        await _emit_answer_delta(self.runtime, response_id, delta)
                elif kind == "activity":
                    from app.services.chat_activity import record_activity
                    await record_activity(self.runtime, response_id, event.get("activity"))
                elif kind in {"files", "tool"}:
                    raise CodeWorkspaceError("代码区已停用，请更新桌面端；代码应直接显示在聊天中。")
                elif kind == "completed":
                    return
                elif kind == "error":
                    raise CodeWorkspaceError(str(event.get("detail") or "Codex 回答失败，已显示内容保留。"))
                elif kind == "cancelled":
                    raise CodeWorkspaceError("Codex 回答已停止，已显示内容保留。")

    async def request(self, text: str, operation_id: str, *, selected: list[str],
                      action: str = "send", provider: str = "codex", profile: str = "default") -> None:
        from app.services.openai_realtime import _begin_response, _emit_terminal
        rt, doc = self.runtime, self.runtime.code_workspace
        # Only admission is serialized. Streaming never holds a UI or audio lock.
        async with rt._response_lock:
            if self.job and not self.job.done():
                raise CodeWorkspaceError("已有回答正在生成，请先停止再发送。")
            if rt.closed:
                raise CodeWorkspaceError("当前对话已结束，请开启新对话。")
            if rt.switching:
                raise CodeWorkspaceError("正在切换会话，请稍后发送。")
            if provider not in {"codex", "responses"} or profile not in PROFILES:
                raise CodeWorkspaceError("无效的回答方式或提示词。")
            if self.resume_missing and provider == "codex":
                raise CodeWorkspaceError("上次提交中断且没有确认 Codex 线程，无法安全续接；记录保留，请新建对话。")
            if provider == "codex":
                self.host.require_connected()
            elif not get_settings().openai_api_key:
                raise CodeWorkspaceError("后端尚未配置 OpenAI API key。")
            screens = []
            for identity in selected:
                entry = rt.history.by_id.get(f"screen:{identity}", {})
                if identity not in rt.collected_screens or not entry.get("image_url"):
                    raise CodeWorkspaceError("截图附件已改变，请核对后重试。")
                screens.append({key: entry[key] for key in ("request_id", "image_url", "captured_at", "appshot") if key in entry})
            await rt.invalidate_work(except_operation=operation_id)
            response_id = f"chat:{operation_id}"
            task = {"valid": True, "epoch": rt.context_revision, "code_revision": doc.revision,
                    "operation_id": operation_id, "selected_screenshot_ids": selected,
                    "visible_screenshot_ids": [screen["request_id"] for record in rt.history.entries
                        if record["kind"] == "chat_request" for screen in record["screens"]] + selected,
                    "question_id": rt.current_question_id}
            self.task, self.job = task, asyncio.current_task()
            message = {"kind": "chat_request", "message_id": operation_id, "response_id": response_id,
                       "text": text, "action": action, "provider": provider, "profile": profile, "code_revision": doc.revision,
                       "created_at": observed_at(), "screens": screens}
            rt.history.entries.append(message)
            rt.history.by_id[f"chat:{operation_id}"] = message
            if rt.title == "新对话":
                rt.title = " ".join(text.split())[:48] or "面试讨论"
            # Accepted messages consume only the attachments sent with this message.
            rt.collected_screens = [identity for identity in rt.collected_screens if identity not in selected]
            rt.transcription.sent_images.update(selected)
            rt.transcription.visible_images.update(selected)
        started = time.monotonic()
        status, detail = "answer_completed", ""
        try:
            await _begin_response(rt, response_id, {"operation_id": operation_id, "question_id": task["question_id"]})
            await rt.broadcast_to_clients({"type": "chat_message", "chat_message": deepcopy(message)})
            await rt.broadcast_to_clients({"type": "conversation_info", "title": rt.title})
            await rt.broadcast_to_clients(rt.screen_collection_state())
            await rt.operation_status(operation_id, "running", response_id=response_id)
            if rt.journal:
                await rt.journal.flush()
                if rt.journal.error:
                    raise CodeWorkspaceError(rt.journal.error)
            async with asyncio.timeout(120):
                # Tail finalization must not block the UI socket (including
                # Stop), but an answer requested after Stop should include it.
                stopping = rt._transcription_stop_task
                if stopping is not None and not stopping.done():
                    await rt.operation_status(operation_id, "running", response_id=response_id, detail="正在等待转录尾句；可以停止本次回答。")
                    await asyncio.shield(stopping)
                if provider == "responses":
                    await self.responses.run(task, message, response_id, started)
                else:
                    await self._run(task, message, response_id, started)
        except asyncio.CancelledError:
            status, detail = "answer_interrupted", "已停止；生成到这里的内容保留。"
            raise
        except Exception as exc:
            status, detail = "answer_error", str(exc) if isinstance(exc, (CodeWorkspaceError, RuntimeError)) else "请求失败，请重试。"
            if isinstance(exc, TimeoutError):
                detail = "回答超时，已保留生成内容；可重新发送。"
        finally:
            task["valid"] = False
            if status != "answer_completed" and provider == "codex":
                try:
                    if not await self._cancel_remote():
                        detail += " 电脑停止未确认；下一次发送前会检查任务状态。"
                except Exception as exc:
                    detail += " " + str(exc)
            if doc.run_id == f"chat-request:{operation_id}":
                doc.run_id = ""
                await rt.broadcast_to_clients(rt.code_state())
            await _emit_terminal(rt, response_id=response_id, event_type=status, text=None, detail=detail,
                                 has_result=bool(task.get("published")))
            if self.task is task:
                self.task, self.job = None, None
            if rt.journal:
                await rt.journal.flush()

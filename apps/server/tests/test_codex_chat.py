import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from tests.codex_provider import CodexProvider

from app.config import Settings
from app.services.chat_controls import run_ui_operation
from app.services.context_store import ContextStore
from app.services.openai_realtime import InterviewRuntime
from app.services.transcription import TranscriptRelay


PNG = "data:image/png;base64,iVBORw0KGgo="


class CodexChatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        Path(self.folder.name, "profile.md").write_text("完整个人资料\n第二段事实", encoding="utf-8")
        self.rt = InterviewRuntime(interview_id="chat-test", session_token="private", capture_token="capture",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1), context_store=ContextStore(Path(self.folder.name)))
        self.events = []
        self.rt.broadcast_to_clients = AsyncMock(side_effect=lambda e: self.events.append(e))
        self.rt._broadcast_clients_locked = AsyncMock(side_effect=lambda e: self.events.append(e))
        self.rt.ensure_main = AsyncMock(side_effect=AssertionError("Chat must not open speech upstream"))
        self.settings = patch("app.services.codex_chat.get_settings", return_value=Settings(
            openai_api_key="", openai_base_url="http://127.0.0.1:1/v1", interview_workspace_history_dir=""))
        self.settings.start()
        self.persist = patch("app.services.workspace_history.persist_workspace", new=AsyncMock())
        self.persist.start()
        self.provider = CodexProvider()
        self.rt.chat.host = self.provider.host

    async def asyncTearDown(self):
        await self.rt.close()
        self.persist.stop()
        self.settings.stop()
        self.folder.cleanup()

    async def send(self, text="解释一下", *, action="send", selected=None, operation="op"):
        self.rt.operations[operation] = {"operation_id": operation, "kind": "chat_send", "status": "accepted"}
        await run_ui_operation(self.rt, None, {"type": "chat_send", "action": action, "text": text,
            "request_ids": selected or []}, operation)

    def screenshot(self, identity="image"):
        self.rt.history.add_screen(identity, PNG, "Editor", question_id="question")
        self.rt.collected_screens.append(identity)

    def code(self):
        return {"title": "遍历求解", "complexity": None, "files": [
            {"filename": "main.py", "language": "python", "code": "result = sum(values)", "comparison": None}]}

    async def test_initial_context_and_manual_attachment_work_without_audio(self):
        await self.rt.update_transcript("interviewer", "t1", "错误条件", "streaming")
        await self.rt.update_transcript("interviewer", "t1", "完整正确条件", "completed")
        self.screenshot(); self.screenshot("not-sent")
        await self.send(selected=["image"])
        supplied = json.dumps(self.provider.inputs[0], ensure_ascii=False)
        self.assertNotIn("完整个人资料", supplied)  # Local CLI reads relevant files on demand.
        self.assertIn("完整正确条件", supplied)
        self.assertNotIn("错误条件", supplied)
        self.assertNotIn("not-sent", supplied)
        self.assertEqual(supplied.count("代码题回答要求"), 1)
        self.assertEqual(supplied.count(PNG), 1)
        self.assertEqual(self.rt.response_buffers["chat:op"], "当前结论")
        self.assertEqual(self.rt.collected_screens, ["not-sent"])
        self.assertFalse(self.rt.active)
        body = self.provider.requests[0]
        self.assertEqual(body["model"], "gpt-6.1-sol")
        self.assertEqual(body["effort"], "xhigh")
        self.assertNotIn("tools", body)

    async def test_followup_reuses_session_and_sends_only_context_changes(self):
        await self.rt.update_transcript("candidate", "t1", "部分文字", "streaming")
        self.screenshot()
        await self.send(selected=["image"])
        await self.rt.update_transcript("candidate", "t1", "最终文字", "completed")
        self.screenshot("pending")
        await self.send("为什么", operation="followup")
        await self.send("再解释", operation="third")
        self.assertEqual(self.rt.chat.session_id, self.provider.thread_id)
        followup = json.dumps(self.provider.inputs[1], ensure_ascii=False)
        self.assertIn("最终文字", followup)
        self.assertNotIn("部分文字", followup)
        self.assertNotIn(PNG, followup)
        self.assertNotIn("完整个人资料", followup)
        self.assertNotIn("pending", followup)
        self.assertNotIn("最终文字", json.dumps(self.provider.inputs[2], ensure_ascii=False))
        self.assertEqual(len([e for e in self.rt.transcription.history.entries if e["kind"] == "transcript"]), 1)

    async def test_new_transcript_during_answer_waits_for_next_request(self):
        async def answer(inputs):
            await self.rt.update_transcript("interviewer", "later", "新条件", "completed")
            return {"text": "依据发送时的条件"}
        self.provider.answer = answer
        await self.send()
        self.assertEqual(self.rt.operations["op"]["status"], "completed")
        self.assertNotIn("新条件", json.dumps(self.provider.inputs[0], ensure_ascii=False))
        await self.send(operation="next")
        self.assertIn("新条件", json.dumps(self.provider.inputs[1], ensure_ascii=False))

    async def test_empty_final_retracts_partial_transcript_in_cloud_context(self):
        await self.rt.update_transcript("candidate", "t1", "误识别", "streaming")
        await self.send()
        await self.rt.update_transcript("candidate", "t1", "", "completed")
        await self.send(operation="next")
        context = next(c["text"] for c in self.provider.inputs[1][0]["content"] if "transcript updates" in c.get("text", ""))
        self.assertEqual(json.loads(context.split("\n", 1)[1])[0]["text"], "")

    async def test_stopping_transcription_preserves_running_chat_and_context(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def answer(inputs):
            entered.set(); await release.wait()
            return {"text": "转录停止后继续完成回答"}
        self.provider.answer = answer
        self.rt.active = True
        await self.rt.update_transcript("interviewer", "t1", "问题", "completed")
        job = asyncio.create_task(self.send())
        await entered.wait()
        await self.rt.stop_transcription()
        self.assertFalse(self.rt.active)
        self.assertFalse(job.done())
        self.assertEqual(self.provider.cancels, 0)
        self.assertTrue(self.rt.transcription.history.transcript_snapshot())
        release.set(); await job
        self.assertEqual(self.rt.operations["op"]["status"], "completed")

    async def test_partial_tool_item_never_publishes_and_disconnect_cancels_remote(self):
        async def answer(inputs): return {"files": self.code(), "incomplete": True}
        self.provider.answer = answer
        await self.send(action="send")
        self.assertIsNone(self.rt.code_workspace.current)
        self.assertEqual(self.rt.operations["op"]["status"], "failed")
        self.assertEqual(self.provider.cancels, 1)

    async def test_legacy_file_publication_is_rejected_without_modifying_history(self):
        async def answer(inputs): return {"files": self.code(), "duplicate": True, "text": ""}
        self.provider.answer = answer
        await self.send(action="send")
        self.assertEqual(self.rt.code_workspace.revision, 0)
        self.assertEqual(self.rt.operations["op"]["status"], "failed")
        self.assertIn("代码区已停用", self.rt.operations["op"]["detail"])
        self.assertEqual(self.rt.response_buffers["chat:op"], "")

    async def test_implementation_is_inline_chat_without_file_publication(self):
        async def answer(inputs): return {"text": "聊天中给你代码示例\n\n```python\nresult = sum(values)\n```"}
        self.provider.answer = answer
        await self.send("写个例子")
        self.assertIsNone(self.rt.code_workspace.current)
        self.assertEqual(self.rt.code_workspace.revision, 0)
        self.assertIn("```python\nresult = sum(values)", self.rt.response_buffers["chat:op"])

    async def test_stop_sends_provider_cancellation_preserves_chat_and_allows_next(self):
        entered = asyncio.Event()
        async def answer(inputs):
            entered.set()
            await asyncio.Event().wait()
        self.provider.answer = answer
        job = asyncio.create_task(self.send(action="send"))
        await entered.wait()
        await self.rt.chat.cancel()
        await asyncio.gather(job, return_exceptions=True)
        self.assertEqual(self.provider.cancels, 1)
        self.assertEqual(self.rt.operations["op"]["status"], "cancelled")
        self.assertIsNone(self.rt.code_workspace.current)
        self.provider.answer = self.provider.default_answer
        await self.send(operation="next")
        self.assertEqual(self.rt.operations["next"]["status"], "completed")
        self.assertIn("chat:op", self.rt.history.by_id)

    async def test_second_client_does_not_consume_attachments(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def answer(inputs):
            entered.set(); await release.wait()
            return {"text": "第一份回答"}
        self.provider.answer = answer
        job = asyncio.create_task(self.send())
        await entered.wait()
        self.screenshot()
        with self.assertRaisesRegex(ValueError, "已有回答"):
            await self.send(operation="other", selected=["image"])
        self.assertEqual(self.rt.collected_screens, ["image"])
        release.set(); await job
        self.assertEqual(len(self.provider.inputs), 1)

    async def test_long_transcript_full_local_record_and_single_initial_transfer(self):
        for i in range(60):
            await self.rt.update_transcript("interviewer", str(i), f"FULL_{i}_" + "完整内容"*300, "completed")
        await self.send()
        await self.send(operation="next")
        initial = json.dumps(self.provider.inputs[0], ensure_ascii=False)
        for i in range(60): self.assertEqual(initial.count(f"FULL_{i}_"), 1)
        self.assertNotIn("FULL_", json.dumps(self.provider.inputs[1]))
        self.assertEqual(len(self.rt.transcription.history.transcript_snapshot()), 60)

    async def test_context_limit_and_quota_errors_are_visible_without_retry(self):
        async def answer(inputs): return {"error": {"code": "context_length_exceeded"}}
        self.provider.answer = answer
        await self.send()
        self.assertIn("记录", self.rt.operations["op"]["detail"])
        self.assertEqual(len(self.provider.inputs), 1)
        self.assertIn("chat:op", self.rt.history.by_id)

    async def test_legacy_code_is_preserved_without_injecting_or_seeding_it(self):
        self.rt.code_workspace.publish({"title": "Pinned", "files": [
            {"filename": "main.py", "language": "python", "code": "PINNED_CODE = 42", "comparison": None}], "complexity": None})
        await self.send(); await self.send(operation="next")
        self.assertNotIn("PINNED_CODE", json.dumps(self.provider.inputs[0]))
        self.assertNotIn("code_seed", self.provider.requests[0])
        self.assertNotIn("PINNED_CODE", json.dumps(self.provider.requests[0]))
        self.assertNotIn("PINNED_CODE", json.dumps(self.provider.inputs[1]))
        self.assertEqual(self.rt.code_workspace.revision, 1)

    async def test_absent_desktop_rejects_before_consuming_attachments(self):
        self.rt.chat.host.socket = None
        self.screenshot()
        with self.assertRaisesRegex(ValueError, "Codex 尚未连接"):
            await self.send(selected=["image"])
        self.assertEqual(self.rt.collected_screens, ["image"])
        self.assertFalse(self.rt.response_order)

    async def test_end_releases_desktop(self):
        await self.send()
        await self.rt.close()
        self.assertTrue(self.provider.closed)

    async def test_interview_context_and_cloud_sessions_are_isolated(self):
        from tests.test_realtime import make_runtime
        second = make_runtime("other-interview")
        second.broadcast_to_clients = AsyncMock()
        other = CodexProvider()
        second.chat.host = other.host
        try:
            await self.rt.update_transcript("candidate", "private", "ONLY_THIS_INTERVIEW", "completed")
            await self.send()
            second.operations["other"] = {"operation_id": "other", "kind": "chat_send", "status": "accepted"}
            await second.chat.request("question", "other", selected=[])
            self.assertNotEqual(self.rt.chat.session_id, second.chat.session_id)
            self.assertNotIn("ONLY_THIS_INTERVIEW", json.dumps(other.inputs[0]))
        finally:
            await second.close()

    async def test_both_audio_sources_only_update_transcript_and_keep_native_order(self):
        interviewer = TranscriptRelay(self.rt, "interviewer")
        candidate = TranscriptRelay(self.rt, "candidate")
        await interviewer.handle({"type": "conversation.item.input_audio_transcription.delta", "item_id": "one", "delta": "题目"})
        await candidate.handle({"type": "conversation.item.input_audio_transcription.delta", "item_id": "one", "delta": "想法"})
        await interviewer.handle({"type": "conversation.item.input_audio_transcription.completed", "item_id": "one", "transcript": "完整题目"})
        await candidate.close()
        turns = self.rt.transcription.history.transcript_snapshot()
        self.assertEqual([t["speaker"] for t in turns], ["interviewer", "candidate"])
        self.assertEqual(turns[0]["text"], "完整题目")
        self.assertEqual(turns[1]["status"], "interrupted")
        self.assertFalse(self.rt.response_order)
        self.assertIsNone(self.rt.chat.task)


    async def test_out_of_order_finals_repeated_speech_and_manual_correction(self):
        relay = TranscriptRelay(self.rt, "candidate")
        for identity in ("one", "two"):
            await relay.handle({"type": "input_audio_buffer.committed", "item_id": identity})
            event = {"type": "conversation.item.input_audio_transcription.delta", "item_id": identity, "event_id": identity, "delta": "相同的话"}
            await relay.handle(event)
            await relay.handle(event)
        await relay.handle({"type": "conversation.item.input_audio_transcription.completed", "item_id": "two", "transcript": "第二段"})
        await relay.handle({"type": "conversation.item.input_audio_transcription.completed", "item_id": "one", "transcript": "第一段"})
        turns = self.rt.transcription.history.transcript_snapshot()
        self.assertEqual([t["text"] for t in turns], ["第一段", "第二段"])
        self.assertFalse(self.rt.response_order)
        await run_ui_operation(self.rt, None, {"type": "manual_text", "kind": "correction", "turn_id": turns[0]["turn_id"], "text": "手动纠正"}, "fix")
        await relay.handle({"type": "conversation.item.input_audio_transcription.completed", "item_id": "one", "transcript": "迟到的识别"})
        self.assertEqual(self.rt.transcription.history.transcript_snapshot()[0]["text"], "手动纠正")


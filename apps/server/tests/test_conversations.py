import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.main import app
from app.services.openai_realtime import InterviewRegistry, OpenAIRealtimeError
from app.services.conversation_store import ConversationStore
from app.services.code_workspace import CodeWorkspaceError


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
            "INTERVIEW_WORKSPACE_HISTORY_DIR": self.folder.name, "INTERVIEW_ACCESS_TOKEN": "owner"})
        self.env.start()
        self.registry = InterviewRegistry()

    async def asyncTearDown(self):
        await self.registry.clear()
        self.env.stop()
        self.folder.cleanup()

    async def test_switch_and_server_restart_restore_all_records_without_audio_or_credentials(self):
        a = await self.registry.create()
        a.title = "哈希表讨论"
        a.transcription.history.add_turn("interviewer", "解释复杂度", turn_id="voice-1")
        a.history.add_screen("image-1", "data:image/png;base64,fixture", "", question_id="")
        a.collected_screens = ["image-1"]
        a.history.entries.append({"kind": "chat_request", "message_id": "send-1", "response_id": "answer-1",
                                  "text": "为什么", "screens": [], "action": "send"})
        a.response_order = ["answer-1"]
        a.response_buffers = {"answer-1": "**完整回答**"}
        a.response_status = {"answer-1": "completed"}
        a.chat.session_id = "native-thread-1"
        a.chat.sent_turns = {"voice-1": "sent"}
        a.code_workspace.publish({"title": "初版", "files": [{"filename": "main.py", "code": "print(1)"}]})
        original_id = a.conversation_id
        old_tokens = (a.session_token, a.capture_token)
        b = await self.registry.switch(a.interview_id, None)
        self.assertFalse(b.history.entries)
        self.assertIsNone(b.code_workspace.current)
        self.assertIsNone(b.chat.session_id)
        restored = await self.registry.switch(b.conversation_id, original_id)
        self.assertEqual(restored.chat.session_id, "native-thread-1")
        self.assertEqual(restored.response_buffers["answer-1"], "**完整回答**")
        self.assertEqual(restored.transcription.history.by_id["voice-1"]["text"], "解释复杂度")
        self.assertEqual(restored.collected_screens, ["image-1"])
        self.assertEqual(restored.code_workspace.revision, 1)
        await self.registry.clear()
        self.registry = InterviewRegistry()
        restarted = await self.registry.create()
        self.assertEqual(restarted.interview_id, a.interview_id)
        self.assertEqual(restarted.title, "哈希表讨论")
        self.assertFalse(restarted.active)
        self.assertIsNone(restarted.chat.host.socket)
        self.assertNotIn(restarted.session_token, old_tokens)
        body = self.registry._store.read(a.interview_id)
        self.assertFalse(any(token in str(body) for token in old_tokens))
        other = ConversationStore(self.folder.name, "other-owner")
        self.assertEqual(other.list(), [])
        self.assertIsNone(other.read(a.interview_id))

    async def test_busy_switch_requires_confirmation_and_stale_switch_is_rejected(self):
        a = await self.registry.create()
        original_id = a.conversation_id
        a.active = True
        a.chat.job = asyncio.create_task(asyncio.sleep(30))
        with self.assertRaisesRegex(OpenAIRealtimeError, "确认停止"):
            await self.registry.switch(a.interview_id, None)
        b = await self.registry.switch(a.interview_id, None, stop_active=True)
        self.assertIs(a, b)
        self.assertFalse(a.closed)
        self.assertTrue(b.active)
        with self.assertRaisesRegex(OpenAIRealtimeError, "已改变"):
            await self.registry.switch(original_id, None)

    async def test_checkpoint_recovers_interrupted_text_without_running_tools_or_replaying_request(self):
        a = await self.registry.create()
        a.transcription.history.add_turn("candidate", "partial", turn_id="partial")["status"] = "streaming"
        a.response_order = ["partial-answer"]
        a.response_buffers = {"partial-answer": "保留这段"}
        a.response_status = {"partial-answer": "streaming"}
        a.operations = {"job": {"status": "running", "kind": "chat_send"}}
        a.chat.session_id = "native-thread"
        await a.journal.flush()
        # A separate registry reads a checkpoint just as a process after a crash would.
        new_registry = InterviewRegistry()
        b = await new_registry.create()
        self.assertEqual(b.response_status["partial-answer"], "interrupted")
        self.assertEqual(b.transcription.history.by_id["partial"]["status"], "interrupted")
        self.assertEqual(b.operations["job"]["status"], "cancelled")
        self.assertIsNone(b.chat.job)
        await new_registry.clear()

    async def test_storage_failure_does_not_discard_current_conversation(self):
        a = await self.registry.create()
        a.transcription.history.add_turn("candidate", "must survive")
        with patch.object(self.registry._store, "save", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OpenAIRealtimeError, "未能保存"):
                await self.registry.switch(a.interview_id, None)
        self.assertIs(self.registry._current, a)
        self.assertFalse(a.closed)
        self.assertFalse(a.switching)
        self.assertEqual(a.transcription.history.turns[0]["text"], "must survive")

    async def test_switch_blocks_second_client_request_during_checkpoint(self):
        a = await self.registry.create()
        entered, proceed = asyncio.Event(), asyncio.Event()
        original = a.journal.flush

        async def checkpoint():
            entered.set()
            await proceed.wait()
            await original()

        with patch.object(a.journal, "flush", checkpoint):
            switch = asyncio.create_task(self.registry.switch(a.interview_id, None))
            await entered.wait()
            try:
                with self.assertRaisesRegex(CodeWorkspaceError, "正在切换"):
                    await a.chat.request("late message", "late", selected=[])
                self.assertFalse(a.history.entries)
            finally:
                proceed.set()
                await switch


class ConversationApiTests(unittest.TestCase):
    def test_authenticated_list_switch_rename_and_old_tokens(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "OPENAI_API_KEY": "", "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
            "INTERVIEW_ACCESS_TOKEN": "owner", "INTERVIEW_WORKSPACE_HISTORY_DIR": folder,
        }), patch("app.services.openai_realtime._registry", InterviewRegistry()), TestClient(app) as client:
            self.assertEqual(client.get("/api/conversations").status_code, 401)
            a = client.post("/api/interviews", headers={"Authorization": "Bearer owner"}).json()
            headers = {"Authorization": "Bearer " + a["session_token"]}
            self.assertEqual(client.patch("/api/conversations/" + a["interview_id"], headers=headers,
                                          json={"title": "设计讨论"}).status_code, 200)
            rows = client.get("/api/conversations", headers=headers).json()["conversations"]
            self.assertEqual(rows[0]["title"], "设计讨论")
            self.assertNotIn("capture_token", str(rows))
            b = client.post("/api/conversations/switch", headers=headers,
                            json={"current_id": a["interview_id"]}).json()
            self.assertNotIn("capture_token", b)
            self.assertEqual(client.get("/api/conversations", headers=headers).status_code, 200)
            self.assertEqual(a["session_token"], b["session_token"])
            headers = {"Authorization": "Bearer " + b["session_token"]}
            restored = client.post("/api/conversations/switch", headers=headers,
                                  json={"current_id": b["conversation_id"], "target_id": a["interview_id"]}).json()
            self.assertEqual(restored["interview_id"], a["interview_id"])


if __name__ == "__main__":
    unittest.main()

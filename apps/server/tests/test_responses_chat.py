import asyncio
import json
import threading
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, patch

from app.config import Settings
from app.services.openai_realtime import InterviewRuntime
from app.services.conversation_store import snapshot, restore
from app.services.code_workspace import CodeWorkspaceError


class ResponsesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.reply = "fixture answer 中文"
        self.failure = None
        self.tool = False
        self.tool_output = None
        self.block = False
        self.release = threading.Event()
        test = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.requests.append(body)
                if test.failure:
                    self.send_response(429); self.send_header("Content-Type", "application/json"); self.end_headers()
                    self.wfile.write(json.dumps({"error": {"code": test.failure, "message": "fixture"}}).encode()); return
                events = []
                if test.tool and len(test.requests) == 1:
                    output = test.tool_output or [{"type": "function_call", "id": "fc1", "call_id": "call1", "name": "read_material", "arguments": '{"path":"profile.md"}'}]
                else:
                    output = [{"type": "message", "id": "msg1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": test.reply, "annotations": []}]}]
                    events.append({"type": "response.output_text.delta", "item_id": "msg1", "content_index": 0, "output_index": 0, "delta": test.reply, "sequence_number": 1})
                events.append({"type": "response.completed", "sequence_number": 2, "response": {"id": "resp"+str(len(test.requests)), "object": "response", "created_at": 1, "model": "fixture", "status": "completed", "output": output}})
                self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
                for event in events:
                    try:
                        self.wfile.write(("data: "+json.dumps(event)+"\n\n").encode()); self.wfile.flush()
                        if test.block and event["type"] == "response.output_text.delta":
                            test.release.wait(5)
                    except (BrokenPipeError, ConnectionError):
                        break
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.settings = Settings(openai_api_key="fixture-not-real", openai_base_url=f"http://127.0.0.1:{self.server.server_port}/v1", interview_workspace_history_dir="")
        self.patches = [patch("app.services."+m+".get_settings", return_value=self.settings) for m in ["codex_chat", "responses_chat"]]
        for p in self.patches: p.start()
        self.rt = InterviewRuntime(interview_id="api-test", session_token="s", capture_token="c", expires_at=datetime.now(timezone.utc)+timedelta(hours=1))
        self.rt.broadcast_to_clients = AsyncMock()
        self.catalog = {"files": [{"path": "profile.md", "bytes": 100, "revision": "a" * 64}], "next_offset": None}
        async def materials(action, args):
            if action == "list_materials":
                return self.catalog
            return {"path": args["path"], "text": "fixture background", "revision": "a" * 64, "next_offset": None}
        self.rt.chat.host.read_materials = AsyncMock(side_effect=materials)

    async def asyncTearDown(self):
        self.release.set()
        await self.rt.close()
        for p in self.patches: p.stop()
        await asyncio.to_thread(self.server.shutdown); self.server.server_close()

    async def send(self, text="解释当前题", identity="one", selected=None, profile="lc"):
        self.rt.operations[identity] = {"operation_id": identity, "kind": "chat_send", "status": "accepted"}
        await self.rt.chat.request(text, identity, selected=selected or [], provider="responses", profile=profile)

    async def test_native_sdk_stream_followup_and_restore(self):
        await self.rt.update_transcript("interviewer", "t1", "first condition", "completed")
        for image in ["one", "two", "unsent"]:
            self.rt.history.add_screen(image, "data:image/png;base64,iVBORw0KGgo=", "fixture", question_id="")
            self.rt.collected_screens.append(image)
        await self.send(selected=["one", "two"])
        self.assertEqual(self.rt.response_buffers["chat:one"], self.reply)
        first = self.requests[0]
        self.assertEqual(first["model"], "gpt-6.1-sol")
        self.assertEqual(first["text"]["verbosity"], "high")
        self.assertEqual(first["reasoning"]["effort"], "xhigh")
        self.assertIn("LeetCode", first["instructions"])
        self.assertNotIn("代码题回答要求", json.dumps(first["input"], ensure_ascii=False))
        self.assertEqual(json.dumps(first["input"]).count("input_image"), 2)
        self.assertNotIn("unsent", json.dumps(first["input"]))
        self.assertIn("profile.md", json.dumps(first["input"]))
        self.assertNotIn("fixture background", json.dumps(first["input"]))
        saved_catalog = self.rt.chat.responses.materials_catalog_revision
        self.assertIsNotNone(saved_catalog)
        restore(self.rt, snapshot(self.rt))
        self.assertEqual(self.rt.chat.responses.materials_catalog_revision, saved_catalog)
        await self.rt.update_transcript("interviewer", "t1", "corrected condition", "completed", corrected=True)
        await self.send("追问", "two", profile="ood")
        second = self.requests[1]
        self.assertEqual(second["previous_response_id"], "resp1")
        self.assertIn("corrected condition", json.dumps(second["input"]))
        self.assertNotIn("first condition", json.dumps(second["input"]))
        self.assertNotIn("input_image", json.dumps(second["input"]))
        self.assertIn("对象职责", second["instructions"])
        self.assertNotIn("profile.md", json.dumps(second["input"]))
        self.assertEqual(self.rt._response_metadata["chat:two"]["responses_timing"]["catalog"]["status"], "unchanged")

    async def test_material_tool_loop_uses_desktop_and_repeats_instructions(self):
        self.tool = True
        await self.send("用我的项目背景回答")
        self.assertEqual(len(self.requests), 2)
        self.rt.chat.host.read_materials.assert_any_await("list_materials", {})
        self.rt.chat.host.read_materials.assert_any_await("read_material", {"path": "profile.md"})
        self.assertEqual(self.rt.chat.host.read_materials.await_count, 2)
        self.assertEqual(self.requests[1]["previous_response_id"], "resp1")
        self.assertEqual(self.requests[1]["instructions"], self.requests[0]["instructions"])
        self.assertIn("fixture background", self.requests[1]["input"][0]["output"])
        timing = self.rt._response_metadata["chat:one"]["responses_timing"]
        self.assertEqual(len(timing["model_rounds"]), 2)
        self.assertTrue(all(item["completed"] and item["elapsed_ms"] >= 0 for item in timing["model_rounds"]))
        self.assertEqual(timing["material_batches"][0]["tools"][0]["tool"], "read_material")
        self.assertIn("first_text_ms", timing)

    async def test_quota_is_not_retried_and_keeps_accepted_message(self):
        self.failure = "credit_balance_exhausted"
        await self.send()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.rt.operations["one"]["status"], "failed")
        self.assertIn("耗尽", self.rt.response_details["chat:one"])
        self.assertIsNone(self.rt.chat.responses.previous_id)
        self.assertIsNone(self.rt.chat.responses.materials_catalog_revision)
        self.assertEqual(len([e for e in self.rt.history.entries if e["kind"] == "chat_request"]), 1)

    async def test_switch_from_native_seeds_messages_but_not_unsent_attachments(self):
        from tests.codex_provider import CodexProvider
        native = CodexProvider()
        native.host.read_materials = self.rt.chat.host.read_materials
        self.rt.chat.host = native.host
        self.rt.operations["native"] = {"operation_id": "native", "kind": "chat_send", "status": "accepted"}
        await self.rt.chat.request("Earlier native question", "native", selected=[])
        await self.send()
        body = json.dumps(self.requests[0]["input"], ensure_ascii=False)
        self.assertIn("Earlier native question", body)
        self.assertIn("当前结论", body)
        self.assertIsNotNone(self.rt.chat.session_id)

    async def test_stop_keeps_partial_and_closes_sdk_stream_without_retry(self):
        self.block = True
        job = asyncio.create_task(self.send())
        for _ in range(200):
            if self.rt.response_buffers.get("chat:one"):
                break
            await asyncio.sleep(.01)
        self.assertEqual(self.rt.response_buffers.get("chat:one"), self.reply)
        await self.rt.chat.cancel()
        await asyncio.gather(job, return_exceptions=True)
        self.assertEqual(self.rt.response_status["chat:one"], "interrupted")
        self.assertIsNone(self.rt.chat.responses.previous_id)
        self.assertIsNone(self.rt.chat.responses.materials_catalog_revision)
        self.assertEqual(len(self.requests), 1)
        self.block = False; self.release.set()
        await self.send("继续解释", "next")
        self.assertEqual(self.rt.operations["next"]["status"], "completed")
        self.assertEqual(len(self.requests), 2)
        self.assertIn(self.reply, json.dumps(self.requests[1]["input"], ensure_ascii=False))
        self.assertIn("profile.md", json.dumps(self.requests[1]["input"]))

    async def test_catalog_refreshes_versions_and_preserves_pagination_without_bodies(self):
        # Even an unexpected desktop field must not prefetch a document body.
        self.catalog["files"][0]["text"] = "private body must stay on desktop"
        self.catalog["next_offset"] = 100
        await self.send()
        body = json.dumps(self.requests[0]["input"], ensure_ascii=False)
        self.assertNotIn("private body", body)
        self.assertIn('next_offset', body)
        previous_catalog = self.rt.chat.responses.materials_catalog_revision
        self.catalog["files"][0]["revision"] = "b" * 64
        await self.send("跟进", "next")
        self.assertNotEqual(self.rt.chat.responses.materials_catalog_revision, previous_catalog)
        self.assertIn("b" * 64, json.dumps(self.requests[1]["input"]))

    async def test_older_snapshot_supplies_catalog_without_resetting_response_chain(self):
        await self.send()
        record = snapshot(self.rt)
        record["responses"].pop("materials_catalog_revision")
        restore(self.rt, record)
        await self.send("跟进", "next")
        self.assertEqual(self.requests[1]["previous_response_id"], "resp1")
        self.assertIn("profile.md", json.dumps(self.requests[1]["input"]))

    async def test_catalog_failure_does_not_block_or_forget_previous_catalog(self):
        await self.send()
        revision = self.rt.chat.responses.materials_catalog_revision
        self.rt.chat.host.read_materials.side_effect = CodeWorkspaceError("offline")
        await self.send("只问算法", "next")
        self.assertEqual(self.rt.operations["next"]["status"], "completed")
        self.assertEqual(self.rt.chat.responses.materials_catalog_revision, revision)
        self.assertIn("未取得", json.dumps(self.requests[1]["input"], ensure_ascii=False))
        self.assertEqual(self.rt._response_metadata["chat:next"]["responses_timing"]["catalog"]["status"], "unavailable")

    async def test_slow_catalog_is_cancelled_before_answer(self):
        cancelled = asyncio.Event()
        async def stalled(*_):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        self.rt.chat.host.read_materials.side_effect = stalled
        with patch("app.services.responses_chat.CATALOG_TIMEOUT_SECONDS", .02):
            await self.send()
        self.assertTrue(cancelled.is_set())
        self.assertEqual(self.rt.operations["one"]["status"], "completed")
        self.assertIsNone(self.rt.chat.responses.materials_catalog_revision)

    def material_calls(self, count):
        return [{"type": "function_call", "id": f"fc{i}", "call_id": f"call{i}", "name": "read_material",
                 "arguments": json.dumps({"path": f"file{i}.md"})} for i in range(count)]

    async def test_related_files_run_concurrently_bounded_and_keep_call_order_on_failure(self):
        self.tool, self.tool_output = True, self.material_calls(6)
        first_wave = asyncio.Event()
        active, peak = 0, 0
        async def read(action, args):
            nonlocal active, peak
            if action == "list_materials":
                return self.catalog
            active += 1
            peak = max(peak, active)
            if active == 4:
                first_wave.set()
            try:
                # Serial execution would never reach this barrier.
                await asyncio.wait_for(first_wave.wait(), 1)
                await asyncio.sleep(0)
                if args["path"] == "file1.md":
                    raise CodeWorkspaceError("fixture missing")
                return {"path": args["path"], "text": "fixture"}
            finally:
                active -= 1
        self.rt.chat.host.read_materials.side_effect = read
        await self.send()
        self.assertEqual(peak, 4)
        self.assertEqual(active, 0)
        self.assertEqual(self.rt.operations["one"]["status"], "completed")
        output = self.requests[1]["input"]
        self.assertEqual([item["call_id"] for item in output], [f"call{i}" for i in range(6)])
        self.assertIn("error", json.loads(output[1]["output"]))
        self.assertEqual(json.loads(output[5]["output"])["path"], "file5.md")
        activities = self.rt._response_metadata["chat:one"]["activities"]
        self.assertEqual(sum(item["status"] == "failed" for item in activities), 1)
        self.assertEqual(sum(item["status"] == "completed" for item in activities), 5)

    async def test_stopping_parallel_reads_cancels_all_without_advancing_chain(self):
        self.tool, self.tool_output = True, self.material_calls(2)
        both_started = asyncio.Event()
        active, finished = 0, 0
        async def read(action, args):
            nonlocal active, finished
            if action == "list_materials":
                return self.catalog
            active += 1
            if active == 2:
                both_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                active -= 1
                finished += 1
        self.rt.chat.host.read_materials.side_effect = read
        job = asyncio.create_task(self.send())
        await asyncio.wait_for(both_started.wait(), 2)
        await self.rt.chat.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(job, 2)
        self.assertEqual((active, finished), (0, 2))
        self.assertIsNone(self.rt.chat.responses.previous_id)
        self.assertIsNone(self.rt.chat.responses.materials_catalog_revision)
        self.assertEqual(self.rt.response_status["chat:one"], "interrupted")
        self.assertEqual(len(self.requests), 1)

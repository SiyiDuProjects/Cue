import asyncio
from copy import deepcopy
import tempfile
import unittest
from unittest.mock import AsyncMock
from app.services.code_workspace import CodeWorkspace, CodeWorkspaceError, archive_versions, run_code_operation
from app.services.code_file_sync import sync_code_files
import uuid
from app.services.workspace_history import WorkspaceHistory, persist_workspace
from tests.test_realtime import make_runtime

def answer(code="x = 1", comparison=None):
    return {"title": "示例", "complexity": None, "files": [
        {"filename": "main.py", "language": "python", "code": code, "comparison": comparison}]}

class PinnedCodeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rt = make_runtime("pinned")
        self.rt.broadcast_to_clients = AsyncMock()
        self.task = {"epoch": self.rt.context_revision, "code_revision": 0, "operation_id": "op"}
        self.rt.chat.task = self.task
        self.rt.history.add_screen("sent", "image", "screen", question_id="q")

    async def asyncTearDown(self):
        await self.rt.close()

    async def publish(self, args=None):
        return await sync_code_files(self.rt, self.task, {**(args or answer()), "commit": uuid.uuid4().hex + "0"*8})

    async def test_invalid_later_file_is_atomic(self):
        await self.publish()
        before = self.rt.code_workspace.snapshot()
        args = answer("new")
        args["files"].append({"filename": "../escape", "language": "python", "code": "bad", "comparison": None})
        with self.assertRaises(CodeWorkspaceError):
            await self.publish(args)
        self.assertEqual(before, self.rt.code_workspace.snapshot())

    async def test_previous_diff_uses_saved_code_and_versions_are_immutable(self):
        await self.publish()
        await self.publish(answer("x = 2", {"source": "previous", "before": "x = 1"}))
        current = self.rt.code_workspace.current
        self.assertEqual(current["files"][0]["comparison"]["before"], "x = 1")
        self.assertEqual(self.rt.code_workspace.versions[0]["files"][0]["code"], "x = 1")
        current["files"][0]["code"] = "mutated snapshot"
        self.assertEqual(self.rt.code_workspace.versions[-1]["files"][0]["code"], "x = 2")

    async def test_new_topic_needs_no_old_code_diff(self):
        await self.publish()
        await self.publish(answer("class Tree: pass"))
        self.assertIsNone(self.rt.code_workspace.current["files"][0]["comparison"])

    async def test_file_deletion_and_interrupted_commit_are_visible(self):
        await self.publish()
        await self.publish({"title":"移除", "files":[], "interrupted":True})
        self.assertEqual(self.rt.code_workspace.current["files"], [])
        self.assertTrue(self.rt.code_workspace.current["interrupted"])

    async def test_stop_keeps_partial_files_but_replaced_task_cannot_sync(self):
        self.task['valid'] = False
        await self.publish({**answer('partial'), 'interrupted':True})
        self.assertTrue(self.rt.code_workspace.current['interrupted'])
        self.rt.chat.task = dict(self.task)
        with self.assertRaises(CodeWorkspaceError):
            await self.publish(answer('late old write'))
        self.assertEqual(self.rt.code_workspace.current['files'][0]['code'],'partial')

    async def test_unattached_image_cannot_supply_comparison(self):
        with self.assertRaises(CodeWorkspaceError):
            await self.publish(answer(comparison={"source": "screenshot", "screenshot_id": "pending", "before": ""}))
        self.assertIsNone(self.rt.code_workspace.current)

    async def test_stopped_and_stale_requests_cannot_publish(self):
        self.task["epoch"] -= 1
        with self.assertRaises(CodeWorkspaceError):
            await self.publish()
        self.task["epoch"] += 1
        self.rt.code_workspace.publish(answer("another writer"))
        with self.assertRaises(CodeWorkspaceError):
            await self.publish()
        self.assertEqual(self.rt.code_workspace.current["files"][0]["code"], "another writer")

    async def test_duplicate_files_invalid_complexity_and_legacy_args_rejected(self):
        for args in [
            {**answer(), "files": answer()["files"] * 2},
            {**answer(), "files": [{"filename":".env", "language":"text", "code":"secret"}]},
            {**answer(), "files": [{"filename":"main.py", "language":"python", "code":42}]},
        ]:
            with self.assertRaises(CodeWorkspaceError):
                await self.publish(args)
        self.assertEqual(self.rt.code_workspace.revision, 0)

    async def test_history_browsing_never_changes_context(self):
        await self.publish()
        identity = self.rt.code_workspace.current["id"]
        await self.publish(answer("new answer"))
        before = deepcopy(self.rt.code_workspace.context())
        await run_code_operation(self.rt, {"action": "load_history", "version_id": identity}, "history")
        self.assertEqual(self.rt.code_workspace.context(), before)
        self.assertEqual(self.rt.broadcast_to_clients.call_args.args[0]["entry"]["version"]["files"][0]["code"], "x = 1")

    async def test_old_mutations_are_unavailable(self):
        for action in ("reset", "return_previous", "save", "undo", "generate", "apply"):
            with self.assertRaises(CodeWorkspaceError):
                await run_code_operation(self.rt, {"action": action}, action)

    async def test_private_history_roundtrip_and_owner_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            first = WorkspaceHistory(directory, "owner")
            second = WorkspaceHistory(directory, "other")
            await self.publish()
            record = self.rt.code_workspace.export_problem()
            first.save("session", record)
            restored = first.read("session", record["problem_id"])
            self.assertEqual(archive_versions(restored), self.rt.code_workspace.versions)
            self.assertIsNone(second.read("session", record["problem_id"]))
            self.assertEqual(second.list(""), [])

    async def test_disk_failure_preserves_memory_and_visible_code(self):
        self.rt.workspace_history = type("Broken", (), {"save": lambda *_: (_ for _ in ()).throw(OSError("disk"))})()
        await self.publish()
        self.assertEqual(self.rt.code_workspace.revision, 1)
        self.assertTrue(self.rt.workspace_history_error)
        self.assertTrue(self.rt.broadcast_to_clients.called)

    def test_legacy_archive_reads_final_code_without_writing_back(self):
        legacy = {"files": [{"filename": "main.py", "code": "base"}],
                  "versions": [{"proposal_id": "old", "version": 1, "summary": "Legacy",
                      "steps": [{"changes": [{"filename": "main.py", "code": "first"}]},
                                {"changes": [{"filename": "main.py", "code": "last"}]}]}]}
        before = deepcopy(legacy)
        self.assertEqual(archive_versions(legacy)[0]["files"][0]["code"], "last")
        self.assertEqual(legacy, before)


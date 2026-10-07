"""Real loopback WebSocket against the packaged Mac helper; no model or device access."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from app.services.codex_host import CodexHost


APP = Path(__file__).resolve().parents[2] / "macos/output/Sage.app/Contents"


@unittest.skipUnless((APP / "Resources/bridge/materials-host.cjs").exists(), "Build the Mac app first")
class MacMaterialsHostTests(unittest.IsolatedAsyncioTestCase):
    async def test_readonly_materials_over_existing_server_transport(self):
        host = CodexHost()
        authenticated = asyncio.Event()

        class SocketAdapter:
            def __init__(self, socket):
                self.socket = socket

            async def send_json(self, value):
                await self.socket.send(json.dumps(value))

            async def receive_json(self):
                return json.loads(await self.socket.recv())

            async def close(self, code=1000):
                await self.socket.close(code=code)

        async def handle(socket):
            auth = json.loads(await socket.recv())
            self.assertEqual(socket.request.path, "/ws/interviews/current/model")
            self.assertEqual(auth, {"type": "authenticate", "token": "fixture-capture"})
            authenticated.set()
            try:
                await host.serve(SocketAdapter(socket))
            except ConnectionClosed:
                pass

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "assistant-workspace"
            materials = workspace / "materials"
            materials.mkdir(parents=True)
            (materials / "resume.md").write_text("原始简历\nFixture experience", encoding="utf-8")
            old_state = workspace / ".runtime/codex/fixture.txt"
            old_state.parent.mkdir(parents=True)
            old_state.write_text("preserve existing state")
            async with serve(handle, "127.0.0.1", 0) as server:
                port = server.sockets[0].getsockname()[1]
                env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENAI_", "CODEX_", "INTERVIEW_"))}
                child = await asyncio.create_subprocess_exec(
                    str(APP / "MacOS/sage-node"), str(APP / "Resources/bridge/materials-host.cjs"),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE, env=env)
                try:
                    child.stdin.write((json.dumps({"apiBaseUrl": f"http://127.0.0.1:{port}", "interviewId": "current",
                                                 "captureToken": "fixture-capture", "dataRoot": directory}) + "\n").encode())
                    await child.stdin.drain()
                    await asyncio.wait_for(authenticated.wait(), 5)
                    catalog = await host.read_materials("list_materials", {})
                    self.assertEqual([f["path"] for f in catalog["files"]], ["resume.md"])
                    content = await host.read_materials("read_material", {"path": "resume.md"})
                    self.assertEqual(content["text"], "原始简历\nFixture experience")
                    with self.assertRaisesRegex(ValueError, "无法读取"):
                        await host.read_materials("read_material", {"path": "../.runtime/codex/fixture.txt"})
                    async with host.request("legacy-client", {"text": "must not generate"}) as queue:
                        result = await asyncio.wait_for(queue.get(), 5)
                        self.assertEqual(result["kind"], "error")
                        self.assertIn("云端回答", result["detail"])
                    self.assertTrue((await host.cancel("legacy-client"))["ok"])
                    self.assertEqual(old_state.read_text(), "preserve existing state")
                    self.assertFalse((workspace / "AGENTS.md").exists())
                    child.stdin.close()
                    self.assertEqual(await asyncio.wait_for(child.wait(), 5), 0)
                finally:
                    if child.returncode is None:
                        child.kill()
                        await child.wait()

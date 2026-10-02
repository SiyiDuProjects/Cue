"""Offline desktop fixture; exercises the production host queue and tool executor."""
import asyncio
import uuid

from app.services.codex_host import CodexHost


class CodexProvider:
    def __init__(self, answer=None):
        self.answer = answer or self.default_answer
        self.inputs, self.requests = [], []
        self.cancels = 0
        self.closed = False
        self.jobs = {}
        self.host = CodexHost()
        self.host.socket = self
        self.thread_id = "thread-" + uuid.uuid4().hex

    async def default_answer(self, inputs):
        return {"text": "当前结论"}

    def event(self, request, kind, **fields):
        queue = self.host.pending.get(request)
        if queue:
            queue.put_nowait({"request_id": request, "kind": kind, **fields})

    async def respond(self, message):
        identity = message["request_id"]
        self.event(identity, "started", thread_id=self.thread_id)
        result = await self.answer(message["input"])
        for activity in result.get('activities', []):
            self.event(identity, 'activity', activity=activity)
        if result.get("error"):
            self.event(identity, "error", detail="Codex quota/context error. 已保留记录。")
            return
        if result.get("files"):
            if result.get("incomplete"):
                self.event(identity, "error", detail="连接中断")
                return
            snapshot = {**result["files"], "commit": uuid.uuid4().hex + "0"*8}
            for _ in range(2 if result.get("duplicate") else 1):
                self.event(identity, "files", workspace=snapshot)
        text = result.get("text", "")
        size = result.get("chunk_size", 8)
        for start in range(0, len(text), size):
            self.event(identity, "delta", item_id="answer", text=text[start:start+size])
            await asyncio.sleep(result.get("chunk_delay", 0))
        self.event(identity, "text_done", item_id="answer", text=text)
        self.event(identity, "completed")

    async def send_json(self, message):
        kind, identity = message["type"], message.get("request_id")
        if kind == "codex_request":
            if message.get("expected_thread_id"):
                self.thread_id = message["expected_thread_id"]
            self.inputs.append(message["input"])
            self.requests.append(message)
            self.jobs[identity] = asyncio.create_task(self.respond(message))
        elif kind == "codex_cancel":
            self.cancels += 1
            job = self.jobs.get(identity)
            if job:
                job.cancel()
                await asyncio.gather(job, return_exceptions=True)
            self.host.cancellations[identity].set_result(True)
        elif kind == "codex_close":
            await self.close()

    async def close(self, **kwargs):
        self.closed = True
        for job in self.jobs.values():
            job.cancel()
        await asyncio.gather(*self.jobs.values(), return_exceptions=True)
        self.host.socket = None

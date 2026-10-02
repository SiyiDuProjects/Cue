"""Offline product UI -> real FastAPI/runtime -> synthetic desktop Codex events/tools."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = ROOT / "artifacts/simple-code"
CONTEXT = ARTIFACTS / "empty-context"
CONTEXT.mkdir(parents=True, exist_ok=True)
(CONTEXT / "fixture.md").write_text("Synthetic interview practice background only.\n", encoding="utf-8")
os.environ.update(OPENAI_API_KEY="offline", OPENAI_BASE_URL="http://127.0.0.1:1/v1",
                  INTERVIEW_ACCESS_TOKEN="", INTERVIEW_CONTEXT_DIR=str(CONTEXT),
                  INTERVIEW_WORKSPACE_HISTORY_DIR="")
sys.path.insert(0, str(ROOT / "apps/server"))
from tests.codex_provider import CodexProvider
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from app.main import app as production_app
from app.services import openai_realtime as rt, codex_chat

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7Z0AAAAASUVORK5CYII="
app = FastAPI()
runtime = None
requests = []
restart_store = tempfile.TemporaryDirectory(prefix='sage-restart-audit-')

async def forbidden(**kwargs):
    raise AssertionError("Real transcription/provider calls are forbidden in the UI audit")
rt._connect_openai_realtime = forbidden

async def provider(inputs):
    requests.append(inputs)
    latest = next(record for record in reversed(runtime.history.entries) if record["kind"] == "chat_request")
    if "慢回答" in latest["text"]:
        await asyncio.sleep(30)
    code = "实现" in latest["text"] or "修改代码" in latest["text"]
    result = {}
    code_text = "def solve(values):\n    # 只保留累加结果，不创建额外列表。\n    total = 0\n    for value in values:\n        total += value\n    return total\n"
    if "修改代码" in latest["text"]:
        code_text = "def solve(values):\n    return sum(values)\n"
    if "另一题" in latest["text"]:
        code_text = "def other():\n    return 42\n"
    answer = ("**一次遍历即可。**\n\n用 `total` 保存累加值，不修改输入。\n\n```python\n" + code_text + "```\n\n时间 `O(n)`，额外空间 `O(1)`。" if code
              else "**先明确需求，再确定实现。**\n\n1. 保留已经讨论的约束。\n2. 只补充当前问题需要的细节。\n\n输入和截图已经作为这轮上下文。")
    if "代码示例" in latest["text"]:
        answer += "\n\n```python\nprint('example')\n```"
    if "长回答" in latest["text"]:
        answer += "\n\n" + "\n\n".join(f"### 观察 {i}\n这是用于验证阅读位置的长回答段落。" for i in range(25))
    return {**result, "text": answer, "activities": [
        {"id":"read", "kind":"command", "label":"读取 coding.md", "status":"running"},
        {"id":"read", "kind":"command", "label":"读取 coding.md", "status":"completed"}],
        **({"chunk_delay": 0.15, "chunk_size": 50} if "长回答" in latest["text"] else {})}

class AuditChat(codex_chat.CodexChat):
    def __init__(self, runtime):
        super().__init__(runtime)
        self.fixture = CodexProvider(provider)
        self.host = self.fixture.host
        self.responses.run = self.api_reply

    async def api_reply(self, task, message, response_id, started):
        # UI contract only; test_responses_chat exercises the real SDK against a
        # loopback SSE server. This fixture cannot reach a paid provider.
        answer = await provider(self.input(message)[0])
        await rt._emit_answer_delta(self.runtime, response_id, answer["text"])
rt.CodexChat = AuditChat

class Capture:
    async def send_json(self, event):
        if event['type'] == 'capture_stop' and event.get('request_id'):
            for socket, identity, future in runtime._capture_flush.values():
                if socket is self and identity == event['request_id'] and not future.done():
                    future.set_result(True)
        if event["type"] == "browser_connection_request":
            runtime.browser_connection.decide(event["request_id"], True)
        if event["type"] == "screen_capture_request":
            future = runtime.pending_screen_requests.get(event["request_id"])
            if future and not future.done():
                future.set_result(PNG)
    async def close(self, **kwargs):
        pass

@app.on_event("startup")
async def setup():
    global runtime
    runtime = await rt.get_interview_registry().create()
    runtime._capture_clients = {"interviewer": Capture(), "candidate": Capture()}
    runtime.browser_connection_host = runtime._capture_clients["interviewer"]
    runtime._capture_ready = {"interviewer", "candidate"}
    runtime._channel_details = {key: {"phase": "ready"} for key in runtime._capture_ready}

@app.on_event("shutdown")
async def cleanup():
    if runtime:
        await runtime.close()

@app.get("/__audit/ui")
async def ui(request: Request):
    html = (ROOT / "apps/desktop/dist/index.html").read_text(encoding="utf-8")
    script = """<script>
window.auditEvents=[];window.auditControls=[];window.auditSockets=[];
const NativeSocket=window.WebSocket;
window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.auditSockets.push(this);this.addEventListener('message',e=>{try{window.auditEvents.push(JSON.parse(e.data))}catch{}})}send(data){if(typeof data==='string'){try{window.auditControls.push(JSON.parse(data))}catch{}}super.send(data)}};
navigator.mediaDevices.getUserMedia=()=>Promise.reject(Error('No real media in audit'));
navigator.mediaDevices.getDisplayMedia=()=>Promise.reject(Error('No real media in audit'));
</script>"""
    if request.query_params.get("desktop") == "1":
        script += """<script>
window.interviewDesktop={isElectron:true,captureHost:true,apiBaseUrl:location.origin,
  createInterview:async()=>{await new Promise(r=>setTimeout(r,150));return (await fetch('/__audit/desktop/session',{method:'POST'})).json()},
  endInterview:async(base,id,token)=>{await fetch('/api/interviews/'+id,{method:'DELETE',headers:{Authorization:'Bearer '+token}})},
  getWindowState:async()=>({}),
  requestCaptureInitialization:async()=>{throw Error('Media must not be initialized during chat startup')}
};
</script>"""
    return HTMLResponse(html.replace("<head>", '<head><base href="/">' + script))

@app.post("/__audit/desktop/session")
async def desktop_session():
    global runtime
    runtime = await rt.get_interview_registry().create()
    if isinstance(runtime._capture_clients.get("interviewer"), Capture):
        runtime._capture_clients.clear()
        runtime._capture_ready.clear()
    return {"interview_id": runtime.interview_id, "session_token": runtime.session_token,
            "capture_token": runtime.capture_token}

@app.post("/__audit/transcript")
async def transcript():
    await runtime.update_transcript("interviewer", "q1", "实现一个求和函数，额外空间 O(1)。", "completed")
    await runtime.update_transcript("candidate", "c1", "先用一次遍历。", "completed")
    return {"ok": True}

@app.get("/__audit/state")
async def state():
    global runtime
    runtime = await rt.get_interview_registry().current()
    return {"workspace": runtime.code_workspace.snapshot(runtime.material_revision), "requests": len(requests),
            "messages": [m for m in runtime.history.entries if m["kind"] == "chat_request"],
            "operations": list(runtime.operations.values()), "transcripts": runtime.transcription.history.transcript_snapshot(),
            "active": runtime.active, "conversation_id": runtime.conversation_id,
            "responses": runtime.response_buffers, "busy": runtime.chat.task is not None}

@app.post("/__audit/active")
async def synthetic_active():
    runtime.active = True
    await runtime.broadcast_to_clients(runtime._interview_state_payload())
    return {"ok": True}

@app.post("/__audit/restart")
async def restart_fixture():
    # Simulate process loss: persist records, remove in-memory runtime, and
    # close the actual sockets without the orderly session_ended notification.
    from app.services.conversation_store import ConversationStore, snapshot
    registry = rt.get_interview_registry()
    old = registry._current
    store = ConversationStore(restart_store.name, '')
    store.save(old.conversation_id, snapshot(old))
    store.select(old.conversation_id)
    store.save_transcription(old.transcription.export())
    registry._store = store
    registry._current = None
    sockets = list(old._ui_clients.values()) + list(old._capture_clients.values())
    await asyncio.gather(*(socket.close(code=1012) for socket in sockets), return_exceptions=True)
    await old.close()
    return {"ok": True}

app.mount("/", production_app)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["AUDIT_PORT"]), log_level="warning")

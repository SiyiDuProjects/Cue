"""Local UI audit: real FastAPI/WS/runtime/tools, deterministic model and capture substitutes.
Never imports a user's profile or opens a model/provider connection.
"""
from __future__ import annotations
from copy import deepcopy
import asyncio
import json
import os
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = ROOT / "artifacts" / "interview-audit-2026-09-26"
CONTEXT = ARTIFACTS / "fixture-context"
CONTEXT.mkdir(parents=True, exist_ok=True)
(CONTEXT / "background.md").write_text("Synthetic audit candidate. Built a toy parser. No real personal information.\n", encoding="utf-8")
os.environ.update(OPENAI_API_KEY="offline-audit-placeholder", OPENAI_BASE_URL="http://127.0.0.1:1/v1",
                  INTERVIEW_ACCESS_TOKEN="", INTERVIEW_CONTEXT_DIR=str(CONTEXT),
                  INTERVIEW_WORKSPACE_HISTORY_DIR=str(ARTIFACTS / ("workspace-history-" + os.environ.get("AUDIT_PORT", "8129"))))
sys.path.insert(0, str(ROOT / "apps" / "server"))
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from app.main import app as production_app
from app.services import openai_realtime as rt
from app.services.candidate_transcript import CandidateTranscriptRelay
from app.services.interview_tools import ToolContext, execute_tool
from app.services.code_workspace import CodeWorkspaceError
from tests.test_realtime import FakeUpstream, PNG_DATA_URL

app = FastAPI()
runtime = None
relay = None
providers = {}
commands = []
late_context = None
late_response = None
sequence = 0

class Provider(FakeUpstream):
    async def send(self, payload):
        await super().send(payload)
        event = json.loads(payload)
        if event["type"] == "response.create":
            response_id = "explicit-" + uuid.uuid4().hex
            task = runtime.live.requests.get(event["event_id"])
            if os.environ.get("PLAN_AUDIT") == "1" and task and task.get("code_run_id"):
                ctx = ToolContext(runtime, runtime.live.socket, task, response_id, uuid.uuid4().hex,
                                  runtime.live.active, runtime.live.workspace)
                await fixture_plan(ctx)
            for response_event in [
                {"type": "response.created", "response": {"id": response_id}},
                {"type": "response.output_text.delta", "response_id": response_id,
                 "delta": "已结合当前实际代码继续：保留你的变量名，先补眼前这个步骤。"},
                {"type": "response.completed", "response": {"id": response_id, "output": []}},
            ]:
                self.queue.put_nowait(json.dumps({"type": "response.event", "client_event_id": event["event_id"], "event": response_event}))
            self.queue.put_nowait(json.dumps({"type": "session.output_transcript.delta",
                "delta": "已结合当前实际代码继续：保留你的变量名，先补眼前这个步骤。"}))

async def connect(*, kind):
    provider = Provider()
    providers.setdefault(kind, []).append(provider)
    return provider
rt._connect_openai_realtime = connect

class Capture:
    """Synthetic ready capture host. No OS device is acquired."""
    async def send_json(self, payload):
        commands.append({"capture": payload["type"]})
        if payload["type"] == "browser_connection_request":
            # Deterministic approval for workspace tests; the separate device
            # smoke exercises the real desktop confirmation UI and capture WS.
            runtime.browser_connection.decide(payload["request_id"], True)
        if payload["type"] == "screen_capture_request":
            future = runtime.pending_screen_requests.get(payload.get("request_id"))
            if future and not future.done():
                future.set_result(PNG_DATA_URL)
    async def close(self, **kwargs):
        pass

@app.middleware("http")
async def local_only(request: Request, call_next):
    if request.client.host not in {"127.0.0.1", "::1"}:
        raise HTTPException(403)
    return await call_next(request)

@app.on_event("startup")
async def setup():
    global runtime, relay
    runtime = await rt.get_interview_registry().create()
    runtime._capture_clients = {"interviewer": Capture(), "candidate": Capture()}
    runtime.browser_connection_host = runtime._capture_clients["interviewer"]
    runtime._capture_ready = {"interviewer", "candidate"}
    runtime._channel_details = {name: {"phase": "ready", "detail": "Synthetic audit audio source"} for name in runtime._capture_ready}
    relay = CandidateTranscriptRelay(runtime)

@app.on_event("shutdown")
async def cleanup():
    if relay:
        await relay.close()
    if runtime:
        await runtime.close()

@app.get("/__audit/ui")
async def ui():
    html = (ROOT / "apps" / "desktop" / "dist" / "index.html").read_text(encoding="utf-8")
    guard = """<script>
window.auditEvents=[];window.auditControls=[];
const AuditWebSocket=window.WebSocket;window.auditSockets=[];
window.WebSocket=class extends AuditWebSocket { constructor(...args){super(...args);window.auditSockets.push(this);this.addEventListener('message',e=>{try{window.auditEvents.push(JSON.parse(e.data));}catch{}});}send(value){if(typeof value==='string')try{window.auditControls.push(JSON.parse(value));}catch{}return super.send(value);} };
if(navigator.mediaDevices){navigator.mediaDevices.getUserMedia=()=>{throw new Error('Unexpected ambient microphone');};navigator.mediaDevices.getDisplayMedia=()=>{throw new Error('Unexpected OS screen capture');};}
</script>"""
    return HTMLResponse(html.replace("<head>", '<head><base href="/">' + guard))

@app.get("/__audit/state")
async def state():
    return {"active": runtime.active, "workspace": runtime.code_state()["workspace"],
            "answers": [{"id": rid, "text": runtime.response_buffers[rid], "status": runtime.response_status.get(rid),
                         "question_id": runtime._response_metadata.get(rid, {}).get("question_id")} for rid in runtime.response_order],
            "turns": list(runtime.history.turns), "questions": runtime.history.questions(),
            "operations": list(runtime.operations.values()), "commands": commands,
            "provider_connections": {kind: len(items) for kind, items in providers.items()},
            "context_is_synthetic": all(doc.text.startswith("Synthetic audit candidate.") for doc in runtime.context_store.documents())}

async def ensure_live():
    if not runtime.active:
        raise HTTPException(409, "Start the real session through its UI first")
    await runtime.ensure_main()

async def question(text):
    await runtime.live.event({"type": "session.input_transcript.delta", "delta": text, "end_ms": 100})
    await runtime.live.flush_input()

async def answer(text, *, complete=True):
    live = runtime.live
    await live.event({"type": "session.output_transcript.delta", "event_id": str(uuid.uuid4()), "delta": text})
    response_id = live.caption_id
    if complete:
        await live.finish_caption()
    return response_id, ""

async def context():
    live = runtime.live
    task = live.snapshot()
    ctx = ToolContext(runtime, live.socket, task, "fixture-tool-" + uuid.uuid4().hex, uuid.uuid4().hex, live.active, live.workspace)
    await execute_tool("search_context", {}, ctx)
    return ctx

def change(code, *, file=None, **extra):
    file = file or runtime.code_workspace.selected
    return {"document_id": file.document_id, "filename": file.filename, "base_revision": file.revision,
            "code": code, "edits": None, "language": None, "complete_file": True, **extra}

async def update(changes, *, mode="propose", ctx=None, **extra):
    global sequence
    ctx = ctx or await context()
    screenshot = None
    if mode == "observe":
        sequence += 1
        screenshot = "fixture-screen-" + str(sequence)
        doc = runtime.code_workspace
        runtime.history.add_screen(screenshot, PNG_DATA_URL, "Synthetic external code editor", question_id=runtime.current_question_id,
            workspace_evidence={"problem_id": doc.problem_id, "manual_revision": doc.manual_revision,
                "sequence": sequence, "revisions": {file.document_id: file.revision for file in doc.files.values()}})
    arguments = {"mode": mode, "screenshot_request_id": screenshot,
        "context_version": runtime.material_revision, "explanation": "先完成当前一步，再根据实际代码继续。", "changes": changes, **extra}
    if mode == "propose":
        arguments.update(changes=[], analysis=None, steps=[{"title": "当前修改", "step_id": None,
            "explanation": "", "complexity": None, "changes": changes}])
    return await execute_tool("update_code", arguments, ctx)


def saved_change(item, code=None):
    return {"document_id": item["document_id"] if item["document_id"] in runtime.code_workspace.files else None,
            "filename": item["filename"], "base_revision": item["base_revision"], "code": item["code"] if code is None else code,
            "edits": None, "language": item["language"], "complete_file": item.get("completeness", "complete") == "complete"}

async def fixture_plan(ctx=None, *, clarification=False, long=False, analysis_only=False):
    ctx = ctx or await context()
    await execute_tool("search_context", {}, ctx)
    current = runtime.code_workspace.code
    request = ctx.task.get("workspace_request", {})
    intent = request.get("intent")
    summary, split_id = "遍历扫描", None
    steps = [] if clarification else [
        {"title": "建立扫描状态", "changes": [change(None, edits=[{"old": current, "new": current + "\nsegments = []"}]) if current else change("cursor = 0\nsegments = []")]},
        {"title": "定义缺失参数规则", "changes": [change("def missing_key(name):\n    return '%' + name + '%'", document_id=None, filename="policy.py", base_revision=0)]},
    ]
    if long:
        steps[0]["changes"] = [change("\n".join(f"# 扫描说明 {n}" for n in range(80)) + "\ncursor = 0\nsegments = []")]
    if intent == "split":
        target = request["target_step"]
        split_id = target["step_id"]
        first = target["changes"][0]
        steps = [{"title": "初始化位置", "changes": [saved_change(first, first["base_code"] + "\n# 准备此步骤")]},
                 {"title": "完成原步骤", "changes": [saved_change(c) for c in target["changes"]]}]
        summary = "拆分扫描步骤"
    elif intent == "revise":
        steps = deepcopy(runtime.code_workspace.proposal["steps"])
        for step in steps:
            step["changes"] = [saved_change(c) for c in step["changes"]]
            if step["step_id"] == request["target_step"]["step_id"]:
                step["title"] += "（调整）"
                step["explanation"] = "保留原步骤目标，补充边界说明。"
        summary = "补充边界说明"
    elif intent == "alternative":
        steps[0]["changes"] = [change(None, edits=[{"old": current, "new": "# 哈希索引避免重复扫描\nlookup = {}"}])] if current else [change("# 哈希索引避免重复扫描\nlookup = {}")]
        summary = "使用哈希表代替遍历"
    elif intent == "reuse":
        steps = deepcopy(request["reference_version"]["steps"])
        for step in steps:
            step["step_id"] = None
            step["changes"] = [saved_change(c) for c in step["changes"]]
            for c in step["changes"]:
                if c["document_id"] in runtime.code_workspace.files:
                    c["base_revision"] = runtime.code_workspace.files[c["document_id"]].revision
        summary = "重新沿用遍历扫描"
    for step in steps:
        step.setdefault("step_id", None)
        step.setdefault("explanation", "")
        step.setdefault("complexity", None)
    if steps and not split_id:
        steps[-1]["complexity"] = {"time": "O(n)", "space": "O(n)", "explanation": "n 是模板长度；这里描述完成所选步骤后的整个实现。"}
    if analysis_only:
        steps, summary = None, "补充扫描依据"
    return await execute_tool("update_code", {"mode": "propose", "screenshot_request_id": None,
        "context_version": runtime.material_revision, "explanation": "", "changes": [], "summary": summary,
        "split_step_id": split_id,
        "analysis": "先确认未知参数和嵌套引用，再实现扫描器。" if clarification else "## 思路\n按字符扫描模板，**保留未知参数**。\n\n- 维护扫描位置。\n- 确认边界条件。\n\n时间与模板长度成正比。",
        "steps": steps}, ctx)

@app.post("/__audit/scene")
async def scene(request: Request):
    global late_context, late_response
    name = (await request.json())["scene"]
    commands.append({"scene": name})
    await ensure_live()
    if name == "clarify":
        await question("Design a prompt formatter. What should we clarify before writing code?")
        await answer("先确认：未知参数如何处理？参数能否引用其他参数？暂时不写代码。")
        if os.environ.get("PLAN_AUDIT") == "1":
            await fixture_plan(clarification=True)
    elif name == "long_plan":
        await fixture_plan(long=True)
    elif name == "analysis_only":
        await fixture_plan(analysis_only=True)
    elif name == "seed_archive":
        record = runtime.code_workspace.export_problem()
        record["problem_id"] = "fixture-past-problem"
        record["title"] = "往场模板解析题"
        for proposal in [record["proposal"], *record["versions"]]:
            proposal["problem_id"] = record["problem_id"]
            proposal["proposal_id"] = "past-" + proposal["proposal_id"]
        runtime.workspace_history.save("fixture-past-interview", record)
        runtime.saved_workspaces = runtime.workspace_history.list(runtime.interview_id)
        await runtime.broadcast_to_clients(runtime.code_state())
    elif name == "same_question_more":
        await answer("还需要确认是否区分大小写，以及输入为空时的行为。")
    elif name == "candidate_partial":
        await relay.handle({"type": "input_audio_buffer.speech_started", "item_id": "candidate1"})
        await relay.handle({"type": "conversation.item.input_audio_transcription.delta", "item_id": "candidate1", "delta": "我先确认未知"})
    elif name == "candidate_final":
        await relay.handle({"type": "conversation.item.input_audio_transcription.completed", "item_id": "candidate1", "transcript": "我先确认未知参数保留原样，暂时不支持嵌套引用。"})
    elif name == "new_question":
        await question("Implement the first useful step, then explain the tradeoff.")
        await answer("我们先建立扫描位置和输出列表，再逐步处理占位符。")
        await update([change("position = 0\nparts = []")])
    elif name == "partial_typing":
        await update([change("cursor = 0", complete_file=False)], mode="observe")
    elif name == "renamed_next":
        await update([change(None, edits=[{"old": "cursor = 0", "new": "cursor = 0\nsegments = []"}], complete_file=False)])
        await answer("你使用 cursor 命名，我们沿用它。接下来只补 segments。")
    elif name == "multifile":
        await update([change(None, edits=[{"old": "cursor = 0", "new": "cursor = 0\nsegments = []"}], complete_file=False),
                      change("def missing_key(name):\n    return '%' + name + '%'", document_id=None, filename="policy.py", base_revision=0)])
        await answer("把未知参数规则单独放到 policy.py；扫描器继续使用已有变量。")
    elif name == "secondfile_actual":
        proposed = next(item for item in runtime.code_workspace.proposal["changes"] if item["filename"] == "policy.py")
        await update([{**proposed, "code": "def missing_key(name):\n    return '%' + name + '%'", "edits": None, "complete_file": True}], mode="observe")
    elif name == "partial_progress":
        await update([change(None, edits=[{"old": "cursor = 0", "new": "cursor = 1"}], complete_file=False)], mode="observe")
    elif name == "complete_file_observed":
        await update([change("cursor = 1\nsegments = []", complete_file=True)], mode="observe")
    elif name == "pending_old":
        late_context = await context()
        late_response = await answer("正在分析上一题的边界…", complete=False)
    elif name == "late_old":
        before = len(runtime.response_order)
        response_id, delegation_id = late_response
        await runtime.live.backend_event({"delegation_id": delegation_id, "event": {"type": "response.output_text.delta", "response_id": response_id, "delta": "SHOULD_NOT_APPEAR"}})
        blocked = False
        try:
            await update([change("SHOULD_NOT_COMMIT")], ctx=late_context)
        except CodeWorkspaceError:
            blocked = True
        return {"late_code_blocked": blocked, "late_text_blocked": "SHOULD_NOT_APPEAR" not in runtime.response_buffers.get(response_id, ""), "answer_count": before}
    elif name == "resume_round":
        await question("Tell me about a difficult tradeoff in your project.")
        await answer("先说明真实约束，再讲你比较过的方案和选择依据。不要补造项目数据。")
    elif name == "reconnect":
        for websocket in list(runtime._ui_clients.values()):
            await websocket.close(code=1012)
    else:
        raise HTTPException(400, "Unknown fixture scene")
    return await state()

app.mount("/", production_app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("AUDIT_PORT", "8129")), log_level="warning", access_log=False)

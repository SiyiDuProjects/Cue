// Real React + Electron, synthetic media/protocol only; external requests blocked.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const artifacts = path.resolve(__dirname, "../../../artifacts");
fs.mkdirSync(artifacts, { recursive: true });
app.setPath("userData", path.join(artifacts, "mock-ui-electron"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
function fixture() {
  const sockets = [], health = {}, sent = [];
  let mode = "assist", active = false;
  window.mockSmoke = { sent };
  const broadcast = (event) => sockets.filter(s => s.role === "client" && s.readyState === 1).forEach(s => s.message(event));
  window.mockSmoke.broadcast = broadcast;
  const devices = () => broadcast({ type: "device_status", mode,
    status: health.interviewer && health.candidate ? "ready" : "initializing",
    channels: { interviewer: !!health.interviewer, candidate: !!health.candidate } });
  class Socket extends EventTarget {
    static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      super(); this.role = new URL(url).pathname.split("/").at(-1); this.readyState = 0; this.bufferedAmount = 0;
      sockets.push(this); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0);
    }
    message(event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
    send(raw) {
      if (typeof raw !== "string") return;
      const event = JSON.parse(raw); sent.push(event);
      queueMicrotask(() => {
        if (event.type === "authenticate") {
          this.message({ type: "session_ready", realtime_protocol: "realtime-interview-v5", mock_interview: true, mode });
          if (this.role === "client") {
            devices(); this.message({ type: "interview_state", active, mode });
            this.message({ type: "context_status", documents_count: 1, characters_count: 100 });
            this.message({ type: "answer_snapshot_done" });
          }
        } else if (event.type === "capture_status") {
          health[this.role] = ["ready", "muted"].includes(event.phase);
          if (this.role === "interviewer") { mode = event.mode; if (health.interviewer) this.message({ type: "capture_mode_ready", mode }); }
          devices();
        } else if (event.type === "ping") this.message({ type: "pong" });
        else if (event.type === "start_transcription") {
          if (!health.interviewer || !health.candidate || event.mode !== mode) throw new Error("Invalid synthetic Start");
          active = true;
          sockets.filter(s => s.role !== "client").forEach(s => s.message({ type: "capture_start" }));
          broadcast({ type: "interview_state", active, mode });
          broadcast({ type: "mock_status", status: "ready", detail: "AI 面试官已连接 · 实时提示保留" });
          broadcast({ type: "transcript_final", speaker: "interviewer", text: "Tell me about a project you built.", turn_id: "q1", question_id: "q1" });
          broadcast({ type: "answer_snapshot", response_id: "hint1", question_id: "q1", text: "Start with the problem, then explain your contribution.\n\n先介绍问题，再解释你的具体贡献。", status: "completed" });
        }
      });
    }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code })); }
  }
  window.WebSocket = Socket;
  const media = async () => {
    const context = new AudioContext({ sampleRate: 24000 });
    const source = context.createConstantSource(); source.offset.value = 0;
    const destination = context.createMediaStreamDestination(); source.connect(destination); source.start();
    await context.resume(); return destination.stream;
  };
  navigator.mediaDevices.getUserMedia = media;
  navigator.mediaDevices.getDisplayMedia = media;
  window.interviewDesktop = {
    isElectron: true, captureHost: true, apiBaseUrl: "https://mock.invalid",
    getWindowState: async () => ({ collapsed: false, pinned: false }),
    setCodeExpanded: async () => {}, setCollapsed: async v => v, setPinned: async v => v,
    createInterview: async () => ({ interview_id: "synthetic", session_token: "test", capture_token: "test-capture" }),
    requestCaptureInitialization: async () => window.dispatchEvent(new Event("sage:capture-initialize")),
    endInterview: async () => { active = false; broadcast({ type: "session_ended" }); },
  };
}
const timeout = setTimeout(() => { console.error("MOCK_UI_SMOKE_TIMEOUT"); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 720, height: 600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  window.webContents.setAudioMuted(true);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
  try {
    const html = path.join(artifacts, "mock-ui-smoke.html");
    const dist = path.resolve(__dirname, "../dist");
    fs.writeFileSync(html, fs.readFileSync(path.join(dist, "index.html"), "utf8").replace("<head>",
      '<head><base href="' + pathToFileURL(dist + path.sep).href + '"><script>(' + fixture.toString() + ')();</script>'));
    await window.loadFile(html);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const find = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
      const until = async predicate => { for (let i=0;i<150;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error(document.body.innerText); };
      await until(() => find('开始面试') && !find('开始面试').disabled);
      find('模拟面试 · 带提示').click();
      await until(() => find('开始模拟') && !find('开始模拟').disabled);
      find('开始模拟').click();
      await until(() => document.body.innerText.includes('先介绍问题'));
      const emit = window.mockSmoke.broadcast;
      const stage = () => document.querySelector('.preview-answer-scroll');
      const segments = () => stage().querySelectorAll('.preview-answer');
      const title = 'Tell me about a project, including your contribution.';
      emit({ type: 'question_state', questions: [{ question_id: 'q1', text: title }], current_question_id: 'q1' });
      emit({ type: 'answer_snapshot', response_id: 'hint2', question_id: 'q1', text: 'Then explain the outcome.', status: 'completed' });
      await until(() => segments().length === 2 && stage().innerText.includes('Then explain the outcome.'));
      if (!stage().innerText.includes('先介绍问题')) throw new Error('Continuation removed first advice');
      if (stage().querySelector('.answer-question') || stage().innerText.includes(title) || find('上一条')) throw new Error('Question UI leaked into continuous feed');
      emit({ type: 'answer_snapshot', response_id: 'hint3', question_id: 'q2', text: 'A new question answer.', status: 'completed' });
      await until(() => segments().length === 3 && stage().innerText.includes('A new question answer.'));
      if (!stage().innerText.includes('先介绍问题') || !stage().innerText.includes('Then explain the outcome.')) throw new Error('Next question replaced previous live contents');
      emit({ type: 'answer_snapshot', response_id: 'hint4', question_id: 'q2', text: 'Another segment.', status: 'completed' });
      await until(() => segments().length === 4 && stage().innerText.includes('Another segment.'));
      emit({ type: 'answer_started', response_id: 'hint5', question_id: 'q2' });
      emit({ type: 'answer_delta', response_id: 'hint5', question_id: 'q2', delta: 'A long explanation.\\n\\n'.repeat(70) });
      await until(() => segments().length === 5 && stage().scrollHeight > stage().clientHeight + 500);
      await until(() => stage().scrollHeight - stage().clientHeight - stage().scrollTop < 35);
      stage().scrollTop = 100;
      stage().dispatchEvent(new Event('scroll'));
      await until(() => find('回到实时 ↓'));
      emit({ type: 'answer_delta', response_id: 'hint5', question_id: 'q2', delta: 'More details.\\n\\n'.repeat(20) });
      await until(() => stage().innerText.includes('More details.'));
      if (Math.abs(stage().scrollTop - 100) > 3) throw new Error('Streaming moved a reader away from their position');
      emit({ type: 'answer_snapshot', response_id: 'hint6', question_id: 'q3', text: 'Explain a difficult tradeoff from this project.', status: 'completed' });
      await until(() => segments().length === 6 && stage().innerText.includes('difficult tradeoff'));
      if (Math.abs(stage().scrollTop - 100) > 3 || !stage().innerText.includes('先介绍问题')) throw new Error('Question transition replaced contents or moved paused reading');
      stage().scrollTop = stage().scrollHeight;
      stage().dispatchEvent(new Event('scroll'));
      await until(() => find('回到实时 ↓'));
      const beforeMore = stage().scrollTop;
      emit({ type: 'answer_delta', response_id: 'hint5', question_id: 'q2', delta: 'Final detail.\\n\\n'.repeat(20) });
      await until(() => stage().innerText.includes('Final detail.'));
      if (Math.abs(stage().scrollTop - beforeMore) > 3) throw new Error('Ordinary bottom scrolling silently resumed following');
      find('回到实时 ↓').click();
      await until(() => !find('回到实时 ↓') && stage().scrollHeight - stage().clientHeight - stage().scrollTop < 35);
      emit({ type: 'answer_started', response_id: 'hint7', question_id: 'q3' });
      emit({ type: 'answer_delta', response_id: 'hint7', question_id: 'q3', delta: 'Fresh live detail.\\n\\n'.repeat(20) });
      await until(() => segments().length === 7 && stage().innerText.includes('Fresh live detail.') && stage().scrollHeight - stage().clientHeight - stage().scrollTop < 35);
      const responseIds = [...segments()].map(segment => segment.dataset.answerId);
      if (JSON.stringify(responseIds) !== JSON.stringify(['hint1','hint2','hint3','hint4','hint5','hint6','hint7'])) throw new Error('Continuous response order changed');
      if (stage().querySelector('.answer-question') || find('上一条')) throw new Error('Question paging returned');
      emit({ type: 'code_state', workspace: { document_id: 'main', revision: 0, code: '', language: 'python',
        can_undo: false, context_version: 0, run_id: '', proposal: null,
        files: [{document_id:'main',filename:'main.py',revision:0,code:'',language:'python',can_undo:false},
          {document_id:'service',filename:'service.py',revision:2,code:'class Service: pass',language:'python',can_undo:false,completeness:'partial'}] } });
      await until(()=>find('提交已保存代码')); find('提交已保存代码').click();
      await until(()=>document.querySelector('[role="menuitem"]'));
      const service = [...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.includes('service.py'));
      if(!service || !service.textContent.includes('片段')) throw Error('Actual file submission is ambiguous');
      service.click(); await until(()=>window.mockSmoke.sent.some(e=>e.type==='mock_share_code'));
      const submitted=window.mockSmoke.sent.find(e=>e.type==='mock_share_code');
      if(submitted.document_id!=='service'||submitted.base_revision!==2) throw Error('Wrong actual file/version submitted');
      const result = { startedMode: window.mockSmoke.sent.find(e=>e.type==='start_transcription')?.mode,
        explicitFileSubmission: true,
        continuousSegments: segments().length, crossQuestionAppend: true, noQuestionPaging: true,
        explicitResumeOnly: true, scrollFollow: true, scrollPositionPreserved: true, responseOrderPreserved: true,
        hintVisible: document.body.innerText.includes('先介绍问题'),
        modeChoiceHiddenWhileActive: !find('面试辅助'),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        text: document.body.innerText };
      if (result.startedMode !== 'mock' || !result.hintVisible || !result.modeChoiceHiddenWhileActive || result.horizontalOverflow) throw new Error(JSON.stringify(result));
      return result;
    })()`, true);
    fs.writeFileSync(path.join(artifacts, "mock-ui-smoke.json"), JSON.stringify(result, null, 2));
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!process.argv.includes("--no-screenshot")) {
      const screenshot = await window.webContents.capturePage();
      fs.writeFileSync(path.join(artifacts, "mock-ui-smoke.png"), screenshot.toPNG());
    }
    console.log("MOCK_UI_SMOKE_OK " + JSON.stringify({ ...result, text: undefined }));
    clearTimeout(timeout); window.destroy(); app.exit(0);
  } catch (error) {
    console.error("MOCK_UI_SMOKE_FAILED " + error.message);
    clearTimeout(timeout); window.destroy(); app.exit(1);
  }
});

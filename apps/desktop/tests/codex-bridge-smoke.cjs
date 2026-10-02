const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { CodexHost } = require("../electron/codex-host.cjs");
const { CodexProcess } = require("../electron/codex-process.cjs");
const root = path.resolve(__dirname, "../../..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await sleep(40); }
  throw new Error("Fixture timed out");
}

test("real transports preserve files, cancellation and native thread recovery after server/CLI restart", { timeout: 40000 }, async t => {
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sage-codex-fixture-"));
  let host, socket;
  const serverRoot = path.join(root, "apps/server");
  let log = "";
  function startServer() {
    const child = spawn(path.join(serverRoot, ".venv/Scripts/python.exe"),
      ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"],
      { cwd: serverRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        OPENAI_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:1/v1", INTERVIEW_WORKSPACE_HISTORY_DIR: folder,
        INTERVIEW_CONTEXT_DIR: folder, INTERVIEW_ACCESS_TOKEN: "synthetic-test-token" } });
    child.stderr.on("data", b => log += b); child.stdout.on("data", () => {});
    return child;
  }
  let server = startServer();
  t.after(async () => {
    socket?.close();
    await host?.close();
    server.kill();
    // Windows keeps a running process's cwd locked until it actually exits.
    await until(() => {
      try {
        // The target is the exact mkdtemp directory owned by this fixture.
        assert.equal(path.dirname(folder), os.tmpdir());
        assert.ok(path.basename(folder).startsWith("sage-codex-fixture-"));
        fs.rmSync(folder, {recursive:true, force:true}); return true;
      }
      catch (error) { if (error.code === "ENOENT") return true; return false; }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(base + "/health")).ok; } catch { if (server.exitCode !== null) throw new Error(log); return false; } });
  const session = await (await fetch(base + "/api/interviews", { method: "POST", headers: { Authorization: "Bearer synthetic-test-token" } })).json();
  let cli;
  host = new CodexHost({ apiBaseUrl: base, interviewId: session.interview_id, captureToken: session.capture_token }, {
    getOptions: () => ({ workspace: folder, binary: "fixture", env: process.env, instructions: "fixture" }),
    makeProcess: options => (cli = new CodexProcess(options.runtime, { ...options,
      spawnProcess: () => spawn(process.execPath, [path.join(__dirname, "fixtures/codex-app-server.cjs")],
        { cwd: folder, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) })),
  });
  await until(() => host.socket.readyState === 1);
  socket = new WebSocket(base.replace("http", "ws") + `/ws/interviews/${session.interview_id}/client`);
  const events = [];
  socket.addEventListener("message", e => events.push(JSON.parse(e.data)));
  await until(() => socket.readyState === 1);
  socket.send(JSON.stringify({ type: "authenticate", token: session.session_token }));
  await until(() => events.some(e => e.type === "session_ready"));
  for (const [id, text] of [["one", "implement fixture"], ["two", "explain fixture"]]) {
    socket.send(JSON.stringify({ type: "chat_send", operation_id: id, action: "send", text, request_ids: [] }));
    await until(() => events.some(e => e.type === "operation_status" && e.operation_id === id && ["completed", "failed"].includes(e.status)));
    const terminal = events.find(e => e.type === "answer_completed" && e.response_id === `chat:${id}`);
    assert.equal(terminal?.text, id === "one" ? "**代码区已更新。**" : "**普通聊天保留代码区。**", JSON.stringify(events.slice(-4)));
  }
  assert.equal(cli.threadId, "fixture-thread");
  socket.send(JSON.stringify({ type: "chat_send", operation_id: "slow", action: "send", text: "wait-for-stop", request_ids: [] }));
  await until(() => cli.current?.id === "slow" && cli.current.turnId);
  socket.send(JSON.stringify({ type: "chat_stop", operation_id: "stop", target_operation_id: "slow" }));
  await until(() => events.some(e => e.type === "operation_status" && e.operation_id === "slow" && e.status === "cancelled"));
  assert.equal(cli.current, null);
  socket.send(JSON.stringify({ type: "chat_send", operation_id: "after-stop", action: "send", text: "continue", request_ids: [] }));
  await until(() => events.some(e => e.type === "answer_completed" && e.response_id === "chat:after-stop"));
  const snapshot = events.filter(e => e.type === "code_state").at(-1);
  assert.ok(snapshot, "Pinned code events must reach the UI");
  await sleep(650); // Include the final debounced persistence checkpoint.
  socket.close(); await host.close(); server.kill();
  await until(() => server.exitCode !== null || server.signalCode !== null);
  server = startServer();
  await until(async () => { try { return (await fetch(base + "/health")).ok; } catch { return false; } });
  const restored = await (await fetch(base + "/api/interviews", { method: "POST", headers: { Authorization: "Bearer synthetic-test-token" } })).json();
  assert.equal(restored.interview_id, session.interview_id);
  assert.notEqual(restored.session_token, session.session_token);
  const methods = [];
  host = new CodexHost({ apiBaseUrl: base, interviewId: restored.interview_id, captureToken: restored.capture_token }, {
    getOptions: () => ({ workspace: folder, binary: "fixture", env: process.env, instructions: "fixture" }),
    makeProcess: options => {
      cli = new CodexProcess(options.runtime, { ...options,
        spawnProcess: () => spawn(process.execPath, [path.join(__dirname, "fixtures/codex-app-server.cjs")],
          { cwd: folder, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) });
      const write = cli.write.bind(cli); cli.write = m => { if (m.method) methods.push(m.method); write(m); }; return cli;
    },
  });
  await until(() => host.socket.readyState === 1);
  events.length = 0;
  socket = new WebSocket(base.replace("http", "ws") + `/ws/interviews/${restored.interview_id}/client`);
  socket.addEventListener("message", e => events.push(JSON.parse(e.data)));
  await until(() => socket.readyState === 1);
  socket.send(JSON.stringify({ type: "authenticate", token: restored.session_token }));
  await until(() => events.some(e => e.type === "code_state"));
  assert.equal(events.find(e => e.type === "chat_snapshot").messages.length, 4);
  assert.equal(events.find(e => e.type === "code_state").workspace.current.files[0].code, "def solve():\n    return 42\n");
  assert.equal(methods.length, 0, "Restoring UI records must not start a model");
  socket.send(JSON.stringify({ type: "chat_send", operation_id: "after-restart", action: "send", text: "continue", request_ids: [] }));
  await until(() => events.some(e => e.type === "answer_completed" && e.response_id === "chat:after-restart"));
  assert.ok(methods.includes("thread/resume"));
  assert.ok(!methods.includes("thread/start"));
  assert.equal(events.filter(e => e.type === "code_state").at(-1).workspace.revision, 1);
});

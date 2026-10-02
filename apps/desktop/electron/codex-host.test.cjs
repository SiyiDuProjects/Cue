const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { CodexHost } = require("./codex-host.cjs");

class Socket extends EventTarget {
  constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); this.message({ type: "codex_ready", realtime_protocol: "interview-chat-v12" }); }
  message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close(code = 1000) { this.readyState = 3; const e = new Event("close"); e.code = code; this.dispatchEvent(e); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("model heartbeat recovers a half-open connection without replaying a request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, cancelled = 0;
  const host = new CodexHost({ apiBaseUrl: "https://example.test", interviewId: "device", captureToken: "fixture" }, {
    WebSocketClass: Socket, getOptions: () => ({}),
    makeProcess: () => ({ run: async () => { calls++; }, cancel: async () => { cancelled++; return true; }, dispose() {} }),
  });
  t.after(() => host.close());
  const original = host.socket;
  original.open();
  original.message({ type: "codex_request", request_id: "once", input: [] });
  await tick();
  t.mock.timers.tick(10000);
  assert.equal(original.sent.at(-1).type, "ping");
  original.message({ type: "pong" });
  t.mock.timers.tick(10000);
  assert.equal(original.readyState, 1);
  t.mock.timers.tick(10000);
  await tick();
  assert.equal(original.readyState, 3);
  assert.equal(cancelled, 1);
  t.mock.timers.tick(1000);
  host.socket.open();
  assert.notEqual(host.socket, original);
  assert.equal(calls, 1);
  // A late close from the obsolete socket must not tear down its replacement.
  original.close(1008);
  assert.equal(host.socket.readyState, 1);
});

test("chat change replaces only native process and keeps authenticated host socket", async t => {
  const ids = [], disposed = [], requests = [];
  const host = new CodexHost({ apiBaseUrl: "https://example.test", interviewId: "device", captureToken: "fixture" }, {
    WebSocketClass: Socket, getOptions: ({ conversationId }) => ({ conversationId }),
    makeProcess: ({ runtime }) => {
      ids.push(runtime.conversationId);
      return { run: async r => requests.push(r.expected_thread_id), cancel: async () => true,
        dispose: () => disposed.push(runtime.conversationId) };
    },
  });
  t.after(() => host.close()); const socket = host.socket; socket.open();
  await host.message({ type: "codex_request", request_id: "a", conversation_id: "chat-a", expected_thread_id: null });
  await host.message({ type: "codex_request", request_id: "b", conversation_id: "chat-b", expected_thread_id: null });
  await host.message({ type: "codex_request", request_id: "c", conversation_id: "chat-a", expected_thread_id: "native-a" });
  assert.deepEqual(ids, ["chat-a", "chat-b", "chat-a"]);
  assert.deepEqual(disposed, ["chat-a", "chat-b"]);
  assert.deepEqual(requests, [null, null, "native-a"]);
  assert.equal(host.socket, socket); assert.equal(socket.readyState, 1);
});
test("desktop relay authenticates only first frame and preserves request identity without a code publication runtime", async t => {
  const calls = []; let options;
  const process = { run: async r => { calls.push(r); options.emit({ request_id: r.request_id, kind: "delta", item_id: "m", text: "答案" }); },
    lastFiles: {commit:"a".repeat(40), files:[]}, cancel: async () => true, dispose: () => {} };
  const host = new CodexHost({ apiBaseUrl: "https://example.test", interviewId: "one", captureToken: "secret" }, {
    WebSocketClass: Socket, getOptions: () => ({workspace: "C:/fixture"}), makeProcess: o => { options = o; return process; },
  });
  t.after(() => host.close()); const socket = host.socket; socket.open();
  assert.equal(socket.url.includes("secret"), false);
  assert.deepEqual(socket.sent[0], { type: "authenticate", token: "secret" });
  const request = { type: "codex_request", request_id: "r", input: [] };
  socket.message(request); await tick(); socket.message(request); await tick();
  assert.equal(calls.length, 1); assert.equal(socket.sent.some(x => x.text === "答案"), true);
  assert.equal(options.runtime.codeFiles, undefined);
  socket.message({ type: "codex_cancel", request_id: "r" }); await tick();
  assert.deepEqual(socket.sent.at(-1), {type:"codex_cancelled", request_id:"r", ok:true});
});

test("model-host disconnect interrupts computation", async t => {
  let options, cancelled = 0;
  const host = new CodexHost({ apiBaseUrl: "https://example.test", interviewId: "one", captureToken: "secret" }, {
    WebSocketClass: Socket, getOptions: () => ({workspace: "C:/fixture"}), makeProcess: o => { options = o; return {
      run: async () => {}, cancel: async () => { cancelled++; return true; }, dispose: () => {},
    }; },
  });
  t.after(() => host.close()); host.socket.open();
  host.socket.message({ type: "codex_request", request_id: "r", input: [] }); await tick();
  host.socket.close(1008); await tick();
  assert.equal(cancelled, 1);

});

test("reconnected and new hosts use the app's bound runtime for the same login and materials", async t => {
  const ids = [], runtimes = [];
  const runtimeContext = { workspace: "C:/bound-workspace", options: id => {
    ids.push(id); return { home: "C:/bound-workspace/.runtime/codex", workspace: `C:/bound-workspace/conversations/${id}` };
  } };
  function create(id) {
    const host = new CodexHost({ apiBaseUrl: "https://example.test", interviewId: id, captureToken: "fixture", runtimeContext }, {
      WebSocketClass: Socket, getOptions: () => { throw Error("Must not resolve ambient runtime"); },
      makeProcess: options => { runtimes.push(options.runtime); return { run: async () => {}, cancel: async () => true, dispose() {} }; },
    });
    t.after(() => host.close()); host.socket.open(); return host;
  }
  const first = create("first");
  first.socket.message({ type: "codex_request", request_id: "one", input: [] }); await tick();
  const oldSocket = first.socket;
  first.connect(); oldSocket.close(1008); first.socket.open();
  first.socket.message({ type: "codex_request", request_id: "two", input: [] }); await tick();
  const second = create("second");
  second.socket.message({ type: "codex_request", request_id: "three", input: [] }); await tick();
  assert.deepEqual(ids, ["first", "second"]);
  assert.ok(runtimes.every(runtime => runtime.home === "C:/bound-workspace/.runtime/codex"));
  assert.equal(first.getMaterials().root, path.resolve(runtimeContext.workspace, "materials"));
  assert.equal(first.getMaterials().root, second.getMaterials().root);
});

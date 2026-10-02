const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { CodexProcess } = require("./codex-process.cjs");

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { loggedIn = true, deferStart = false } = {}) {
  const writes = [], events = [], toolCalls = [];
  let turn = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit("exit", 0); };
  const send = message => child.stdout.write(JSON.stringify(message) + "\n");
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()); writes.push(request);
    queueMicrotask(() => {
      if (request.method === "initialize") send({ id: request.id, result: {} });
      if (request.method === "account/read") send({ id: request.id, result: { requiresOpenaiAuth: true, account: loggedIn ? { type: "chatgpt" } : null } });
      if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread" } } });
      if (request.method === "thread/resume") {
        if (request.params.threadId === "thread") send({ id: request.id, result: { thread: { id: "thread", status: { type: "idle" } } } });
        else send({ id: request.id, error: { message: "Thread not found" } });
      }
      if (request.method === "turn/start" && !deferStart) {
        turn++;
        // Notification can precede the request acknowledgement.
        send({ method: "turn/started", params: { threadId: "thread", turn: { id: `turn-${turn}` } } });
        send({ id: request.id, result: { turn: { id: `turn-${turn}` } } });
      }
      if (request.method === "turn/interrupt") {
        send({ id: request.id, result: {} });
        send({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${turn}`, status: "interrupted" } } });
      }
    });
    callback();
  } });
  const process = new CodexProcess({ binary: "test", workspace: "C:/fixture", env: {}, instructions: "INTERVIEW_ONLY" }, {
    spawnProcess: (_binary, args, options) => {
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      assert.ok(args.includes("project_doc_max_bytes=0")); return child;
    },
    emit: event => events.push(event), tool: async (...args) => { toolCalls.push(args); return { ok: true }; },
  });
  t.after(() => process.dispose());
  const request = id => ({ request_id: id, model: "gpt-6-sol", effort: "high", expected_thread_id: null,
    input: [{ role: "user", content: [{ type: "input_text", text: "问题" },
      { type: "input_image", image_url: "data:image/png;base64,fixture" }] }],
    tools: [{ name: "update_code", description: "publish", parameters: { type: "object" } }] });
  const notification = (method, params) => send({ method, params: { threadId: "thread", turnId: `turn-${turn}`, ...params } });
  return { process, writes, events, child, send, notification, request, toolCalls };
}

test("native protocol preserves images, Sol/high and literal streaming without a second model", async t => {
  const f = fixture(t);
  await f.process.run(f.request("one"));
  const config = f.writes.find(x => x.method === "thread/start").params;
  assert.equal(config.model, "gpt-6-sol"); assert.equal(config.sandbox, "read-only");
  assert.equal(config.baseInstructions, "INTERVIEW_ONLY");
  assert.equal(config.developerInstructions, "");
  assert.deepEqual(config.dynamicTools, []);
  const input = f.writes.find(x => x.method === "turn/start").params;
  assert.equal(input.effort, "high"); assert.equal(input.input[1].type, "image");
  assert.equal(input.input[1].url, "data:image/png;base64,fixture");
  assert.deepEqual(input.sandboxPolicy, { type: "readOnly" });
  f.notification("item/agentMessage/delta", { itemId: "m", delta: "**结论**" });
  f.notification("item/completed", { item: { id: "m", type: "agentMessage", text: "**结论**" } });
  f.notification("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  await tick();
  assert.deepEqual(f.events.map(x => x.kind), ["started", "delta", "text_done", "completed"]);
  assert.equal(f.events[1].text, "**结论**");
  await f.process.run({ ...f.request("two"), expected_thread_id: "thread", model: "gpt-6.1-sol", effort: "xhigh" });
  assert.equal(f.writes.filter(x => x.method === "thread/start").length, 1);
  assert.equal(f.writes.filter(x => x.method === "turn/start").at(-1).params.model, "gpt-6.1-sol");
  assert.equal(f.writes.filter(x => x.method === "turn/start").at(-1).params.effort, "xhigh");
});

test("removed application tools and unexpected approval requests are rejected", async t => {
  const f = fixture(t); await f.process.run(f.request("one"));
  const params = { threadId: "thread", turnId: "turn-1", tool: "update_code", callId: "call", arguments: { title: "code" } };
  f.send({ method: "item/started", params: { threadId: "thread", turnId: "turn-1", item: { type: "dynamicToolCall", ...params } } });
  f.send({ id: 51, method: "item/tool/call", params: { ...params, turnId: "old" } });
  f.send({ id: 52, method: "item/tool/call", params });
  f.send({ id: 53, method: "item/tool/call", params });
  f.send({ id: 54, method: "item/commandExecution/requestApproval", params: {} });
  await tick();
  assert.equal(f.toolCalls.length, 0);
  assert.ok(f.writes.find(x => x.id === 52).error);
  assert.ok(f.writes.find(x => x.id === 53).error);
  assert.ok(f.writes.find(x => x.id === 51).error);
  assert.ok(f.writes.find(x => x.id === 54).error);
});

test("stop uses turn/interrupt and confirmed completion permits next input without steering", async t => {
  const f = fixture(t); await f.process.run(f.request("one"));
  await assert.rejects(f.process.run(f.request("collision")), /上一条/);
  assert.equal(await f.process.cancel("one"), true);
  f.notification("item/agentMessage/delta", { itemId: "late", delta: "stale" });
  assert.equal(f.events.some(x => x.text === "stale"), false);
  await f.process.run({ ...f.request("two"), expected_thread_id: "thread" });
  assert.equal(f.writes.filter(x => x.method === "turn/interrupt").length, 1);
  assert.equal(f.writes.filter(x => x.method === "turn/start").length, 2);
});

test("missing login is visible and does not start a model turn", async t => {
  const f = fixture(t, { loggedIn: false }); await f.process.run(f.request("one"));
  assert.match(f.events.at(-1).detail, /尚未登录/);
  assert.equal(f.writes.some(x => x.method === "turn/start"), false);
  assert.equal(f.child.killed, true);
});

test("cancellation before turn acknowledgement kills owned process and prevents ambiguous retry", async t => {
  const f = fixture(t, { deferStart: true });
  const run = f.process.run(f.request("one"));
  while (!f.writes.some(x => x.method === "turn/start")) await tick();
  assert.equal(await f.process.cancel("one"), false);
  await run;
  assert.equal(f.child.killed, true);
  await assert.rejects(f.process.run(f.request("retry")), /不确定/);
});

test("process restart never silently substitutes an empty thread for known history", async t => {
  const f = fixture(t); await f.process.run({ ...f.request("one"), expected_thread_id: "old-thread" });
  assert.match(f.events.at(-1).detail, /Thread not found/);
  assert.equal(f.writes.some(x => x.method === "turn/start"), false);
  assert.equal(f.writes.some(x => x.method === "thread/start"), false);
});

test("restarting the app resumes native thread history without replay or a replacement thread", async t => {
  const f = fixture(t);
  await f.process.run({ ...f.request("next"), expected_thread_id: "thread", model: "gpt-6.1-sol", effort: "xhigh" });
  assert.equal(f.writes.filter(x => x.method === "thread/resume").length, 1);
  assert.equal(f.writes.some(x => x.method === "thread/start"), false);
  assert.equal(f.writes.filter(x => x.method === "turn/start").length, 1);
  assert.equal(f.process.threadId, "thread");
  const resumed = f.writes.find(x => x.method === "thread/resume").params;
  assert.equal(resumed.model, "gpt-6.1-sol");
  assert.equal(f.writes.find(x => x.method === "turn/start").params.model, "gpt-6.1-sol");
  assert.equal(f.writes.find(x => x.method === "turn/start").params.effort, "xhigh");
  assert.equal(resumed.sandbox, "read-only");
  assert.equal(resumed.baseInstructions, "INTERVIEW_ONLY");
  assert.equal(f.toolCalls.length, 0);
});

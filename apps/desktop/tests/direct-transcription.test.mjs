import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectTranscription } from "../../../packages/transcription/direct.mjs";

class Socket extends EventTarget {
  static instances = [];
  constructor(url, protocols) {
    super();
    Object.assign(this, {
      url,
      protocols,
      sent: [],
      bufferedAmount: 0,
      closed: false,
    });
    Socket.instances.push(this);
  }
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  receive(value) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  ready() {
    this.dispatchEvent(new Event("open"));
    this.receive({ type: "session.updated" });
  }
}
function fixture() {
  Socket.instances = [];
  const sent = [],
    failures = [],
    detectors = [];
  const direct = new DirectTranscription({
    WebSocket: Socket,
    send: (value) => sent.push(value),
    fail: (value) => failures.push(value),
    makeVAD: async () => {
      const vad = {
        voice: () => false,
        destroy() {
          this.destroyed = true;
        },
      };
      detectors.push(vad);
      return vad;
    },
  });
  const open = async (role, id) => {
    await direct.open({
      role,
      stream: id,
      token: "ek_synthetic",
      session: { type: "transcription" },
    });
    const socket = Socket.instances.at(-1);
    socket.ready();
    return socket;
  };
  return { direct, sent, failures, detectors, open };
}
test("PCM only reaches OpenAI; both commits precede ask and later audio", async () => {
  const { direct, sent, open, detectors } = fixture();
  const a = await open("interviewer", "a"),
    b = await open("candidate", "b");
  direct.pcm("interviewer", new ArrayBuffer(4800));
  direct.pcm("candidate", new ArrayBuffer(4800));
  direct.control({ type: "ask", id: "request" });
  direct.pcm("interviewer", new ArrayBuffer(4800));
  direct.control({ type: "stop" });
  assert.deepEqual(
    sent.map((v) => v.type),
    [
      "asr_ready",
      "asr_ready",
      "asr_commit",
      "asr_commit",
      "ask",
      "asr_commit",
      "stop",
    ],
  );
  assert(
    sent.every((v) => !Object.hasOwn(v, "audio") && !Object.hasOwn(v, "token")),
  );
  assert.equal(
    a.sent.filter((v) => v.type === "input_audio_buffer.commit").length,
    2,
  );
  assert.equal(
    b.sent.filter((v) => v.type === "input_audio_buffer.commit").length,
    1,
  );
  assert.notEqual(detectors[0], detectors[1]);
  direct.reset();
});
test("handover commits old input before activating replacement and keeps its tail open", async () => {
  const { direct, sent, open } = fixture();
  const old = await open("candidate", "old");
  direct.pcm("candidate", new ArrayBuffer(4800));
  const next = await open("candidate", "next");
  assert.deepEqual(sent.slice(-2), [
    { type: "asr_commit", stream: "old" },
    { type: "asr_ready", stream: "next" },
  ]);
  assert.equal(old.closed, false);
  direct.pcm("candidate", new ArrayBuffer(4800));
  assert.equal(next.sent.at(-1).type, "input_audio_buffer.append");
  old.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "x",
    transcript: "tail",
  });
  assert.equal(sent.at(-1).stream, "old");
  direct.handle({ type: "asr_close", stream: "old" });
  assert(old.closed);
  assert(!next.closed);
  direct.reset();
});
test("disconnect and stop close both upstreams without any retry", async () => {
  const { direct, open, failures } = fixture();
  const a = await open("interviewer", "a"),
    b = await open("candidate", "b");
  a.dispatchEvent(new Event("error"));
  assert(a.closed && b.closed);
  assert.equal(failures.length, 1);
  assert.equal(Socket.instances.length, 2);
  assert.throws(() => direct.pcm("candidate", new ArrayBuffer(4800)), /未就绪/);
});
test("a cancelled opening cannot create a late upstream", async () => {
  let finish;
  const vad = {
    voice: () => false,
    destroy() {
      this.destroyed = true;
    },
  };
  const direct = new DirectTranscription({
    WebSocket: Socket,
    send() {},
    fail() {},
    makeVAD: () => new Promise((resolve) => (finish = resolve)),
  });
  const count = Socket.instances.length;
  const opening = direct.open({
    role: "candidate",
    stream: "late",
    token: "ek_synthetic",
  });
  direct.reset();
  finish(vad);
  await opening;
  assert.equal(Socket.instances.length, count);
  assert(vad.destroyed);
});
test("partial coalescing preserves complete text and final events", async () => {
  const { direct, open, sent } = fixture();
  const socket = await open("candidate", "a");
  for (const delta of ["hello", " ", "world"])
    socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "x",
      delta,
    });
  assert.equal(sent.filter((v) => v.type === "asr_event").length, 1);
  socket.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "x",
    transcript: "hello world",
  });
  assert.equal(sent.at(-1).event.transcript, "hello world");
  direct.reset();
});
test("a rejected handshake tells the server why, without the token", async () => {
  const { direct, sent, failures } = fixture();
  await direct.open({
    role: "interviewer",
    stream: "s",
    token: "ek_synthetic",
    session: { type: "transcription" },
  });
  const socket = Socket.instances[0];
  socket.dispatchEvent(new Event("open"));
  socket.receive({ type: "error", error: { code: "invalid_value" } });
  assert.deepEqual(sent.at(-1), {
    type: "asr_failed",
    stream: "s",
    reason: "invalid_value",
  });
  assert.match(failures[0], /invalid_value/);
  assert(!JSON.stringify(sent).includes("ek_synthetic"));
});

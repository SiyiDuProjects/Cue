import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectTranscription } from "../../../packages/transcription/direct.mjs";
const settle = () => new Promise(setImmediate);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture(t, options = {}) {
  const sent = [],
    events = [],
    failures = [],
    logs = [],
    sockets = [];
  let now = 100000,
    ack = true,
    token = true;
  class Socket extends EventTarget {
    constructor() {
      super();
      this.sent = [];
      this.bufferedAmount = 0;
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw) {
      const v = JSON.parse(raw);
      this.sent.push(v);
      if (v.type === "session.update")
        queueMicrotask(() => this.receive({ type: "session.updated" }));
    }
    receive(v) {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(v) }),
      );
    }
    close() {
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
    committed(id) {
      this.receive({ type: "input_audio_buffer.committed", item_id: id });
    }
    final(id, text = "synthetic") {
      this.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: id,
        transcript: text,
      });
    }
  }
  const direct = new DirectTranscription({
    WebSocket: Socket,
    now: () => now,
    makeVAD: async () => ({ voice: () => false, destroy() {} }),
    send(v) {
      sent.push(v);
      if (v.type === "asr_token" && token)
        queueMicrotask(() =>
          direct.handle({
            ...v,
            token: "ek_synthetic",
            session: { type: "transcription" },
          }),
        );
      if (v.type === "utterance" && ack)
        queueMicrotask(() =>
          direct.handle({
            type: "utterance_saved",
            id: v.id,
            revision: v.revision,
          }),
        );
    },
    fail: (v) => failures.push(v),
    emit: (v) => events.push(v),
    log: (v) => logs.push(v),
    ...options,
  });
  direct.handle({ type: "session_ready" });
  t.after(() => {
    direct.connected = false;
    direct.reset();
    clearInterval(direct.timer);
  });
  return {
    direct,
    sent,
    events,
    failures,
    logs,
    sockets,
    setAck: (v) => (ack = v),
    setToken: (v) => (token = v),
    advance(ms) {
      now += ms;
      direct.tick();
    },
    async start() {
      await direct.start();
      return sockets;
    },
    pcm(role = "interviewer", value = 1) {
      direct.pcm(role, new Int16Array(2400).fill(value).buffer);
    },
    channel(role = "interviewer") {
      return direct.active.get(role);
    },
  };
}
test("both streams stay direct and answer waits for exact final persistence", async (t) => {
  const f = fixture(t),
    [a, b] = await f.start();
  f.setAck(false);
  f.pcm();
  f.pcm("candidate");
  const answer = f.direct.control({ type: "ask", id: "one" });
  a.committed("a");
  b.committed("b");
  a.final("a");
  b.final("b");
  await settle();
  assert(!f.sent.some((v) => v.type === "ask"));
  const latest = [...f.direct.outbox.values()].map((p) => p.value);
  for (const v of latest)
    f.direct.handle({
      type: "utterance_saved",
      id: v.id,
      revision: v.revision - 1,
    });
  await settle();
  assert(!f.sent.some((v) => v.type === "ask"));
  for (const v of latest)
    f.direct.handle({
      type: "utterance_saved",
      id: v.id,
      revision: v.revision,
    });
  await answer;
  assert.deepEqual(Object.values(f.sent.at(-1).cut), [1, 1]);
  assert.equal(f.direct.outbox.size, 0);
  assert(f.sent.every((v) => !("audio" in v) && !("token" in v)));
  assert.notEqual(f.channel().vad, f.channel("candidate").vad);
});
test("an earlier unconfirmed commit cannot pull post-click PCM into the answer cutoff", async (t) => {
  const f = fixture(t),
    [a] = await f.start(),
    c = f.channel();
  f.pcm();
  f.direct.commit(c);
  f.pcm("interviewer", 2);
  const answer = f.direct.control({ type: "ask", id: "cut" });
  f.pcm("interviewer", 3);
  assert.equal(a.sent.filter((v) => v.type.endsWith(".append")).length, 2);
  a.committed("previous");
  a.final("previous");
  await settle();
  const ordered = a.sent.filter((v) => /append|commit/.test(v.type));
  assert.deepEqual(
    ordered.map((v) => v.type.split(".").at(-1)),
    ["append", "commit", "append", "commit", "append"],
  );
  a.committed("boundary");
  f.direct.commit(c);
  a.committed("after");
  a.final("after");
  a.final("boundary");
  await answer;
  assert.equal(f.sent.find((v) => v.type === "ask").cut[c.id], 2);
  assert.equal(c.ordinal, 3);
});
test("save outages retain every final, lost ACKs retry idempotently, newer revisions win", async (t) => {
  const f = fixture(t),
    [a] = await f.start();
  f.setAck(false);
  f.pcm();
  f.direct.commit(f.channel());
  a.committed("one");
  a.receive({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "one",
    delta: "hello",
  });
  a.final("one", "hello world");
  f.pcm();
  f.direct.commit(f.channel());
  a.committed("two");
  a.final("two");
  const versions = [...f.direct.outbox.values()].map((p) => p.value);
  for (const v of versions)
    f.direct.handle({
      type: "utterance_failed",
      id: v.id,
      revision: v.revision,
      code: "db_error",
    });
  assert.equal(f.failures.length, 0);
  f.advance(3100);
  assert.equal(f.direct.outbox.size, 2);
  f.direct.handle({ type: "disconnected" });
  assert.equal(f.direct.active.size, 0);
  f.setAck(true);
  f.direct.handle({ type: "session_ready" });
  await settle();
  assert.equal(f.direct.outbox.size, 0);
  assert.equal(f.direct.phase, "idle");
  assert.deepEqual(
    f.sent
      .filter((v) => v.type === "utterance")
      .slice(-2)
      .map((v) => v.text),
    ["hello world", "synthetic"],
  );
});
test("matched commit rejection is a failed boundary even without an item or ordinal", async (t) => {
  const f = fixture(t),
    [a] = await f.start();
  f.pcm();
  const answer = f.direct.control({ type: "ask", id: "bad" });
  const commit = a.sent.at(-1);
  a.receive({
    type: "error",
    event_id: "server-event",
    error: { event_id: commit.event_id, code: "invalid_value" },
  });
  await assert.rejects(answer, /提交失败/);
  assert(!f.sent.some((v) => v.type === "ask"));
  assert.equal(f.direct.phase, "active");
  f.pcm();
  f.direct.commit(f.channel());
  a.committed("next");
  a.final("next");
  await settle();
  assert.equal(f.channel().ordinal, 1);
});
test("a failed transcription is terminal for ACK retirement but cannot start an answer", async (t) => {
  const f = fixture(t),
    [a] = await f.start();
  f.setAck(false);
  f.pcm();
  const answer = f.direct.control({ type: "ask" });
  a.committed("x");
  a.receive({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "x",
    error: { code: "audio_unintelligible" },
  });
  await assert.rejects(answer, /audio_unintelligible/);
  const v = f.direct.outbox.values().next().value.value;
  f.direct.handle({ type: "utterance_saved", id: v.id, revision: v.revision });
  assert.equal(f.direct.outbox.size, 0);
  assert.equal(f.channel().turns.size, 0);
});
test("stop is immediate; tail saves survive closure and new recording can start", async (t) => {
  const f = fixture(t, { tailMs: 30 }),
    [a, b] = await f.start();
  f.setAck(false);
  f.pcm();
  f.direct.stop();
  assert.equal(f.direct.phase, "idle");
  a.committed("tail");
  a.final("tail");
  await f.direct.start();
  await sleep(40);
  assert(a.closed && b.closed);
  assert.equal(f.direct.phase, "active");
  assert.equal(f.direct.outbox.size, 1);
  f.setAck(true);
  f.advance(31000);
  await settle();
  assert.equal(f.direct.outbox.size, 0);
  assert(f.events.some((v) => v.type === "transcription_tail" && v.detail));
});
test("stop and an immediate answer share one final commit boundary", async (t) => {
  const f = fixture(t),
    [a] = await f.start(),
    c = f.channel();
  f.pcm();
  f.direct.commit(c);
  f.pcm();
  f.direct.stop();
  const answer = f.direct.control({ type: "ask", id: "stopped-tail" });
  a.committed("previous");
  a.final("previous");
  await settle();
  a.committed("tail");
  await settle();
  assert(!f.sent.some((v) => v.type === "ask"));
  a.final("tail", "required tail");
  await answer;
  assert.equal(f.sent.find((v) => v.type === "ask").cut[c.id], 2);
  assert.equal(a.sent.filter((v) => v.type.endsWith(".commit")).length, 2);
});
test("recoverable provider errors and malformed events do not kill either stream", async (t) => {
  const f = fixture(t),
    [a, b] = await f.start();
  a.dispatchEvent(new MessageEvent("message", { data: "invalid" }));
  a.receive({
    type: "error",
    event_id: "server",
    error: { type: "server_error" },
  });
  assert(!a.closed && !b.closed);
  assert.equal(f.failures.length, 0);
  assert.equal(f.logs.length, 2);
  a.bufferedAmount = 65000;
  f.advance(500);
  f.advance(9500);
  assert(!a.closed);
  a.bufferedAmount = 0;
  f.advance(500);
  assert(!a.closed);
  a.bufferedAmount = 65000;
  f.advance(1);
  f.advance(10000);
  assert(a.closed && b.closed);
  assert.match(f.failures[0], /积压/);
});
test("unacknowledged commit closes ambiguous streams without guessing a pairing", async (t) => {
  const f = fixture(t, { commitMs: 15 }),
    [a, b] = await f.start();
  f.pcm();
  const answer = f.direct.control({ type: "ask" });
  const checked = assert.rejects(answer, /已取消|未获确认|断开/);
  await sleep(30);
  await checked;
  assert(a.closed && b.closed);
  assert.match(f.failures[0], /未获确认/);
});
test("cancel releases a waiting answer and never sends it", async (t) => {
  const f = fixture(t),
    [a] = await f.start();
  f.pcm();
  const answer = f.direct.control({ type: "ask", id: "one" });
  await f.direct.control({ type: "cancel", id: "one" });
  await assert.rejects(answer);
  a.committed("x");
  a.final("x");
  await settle();
  assert(!f.sent.some((v) => v.type === "ask"));
});
test("cancelling an answer releases its wait without cancelling the shared stop tail", async (t) => {
  const f = fixture(t),
    [a] = await f.start();
  f.pcm();
  f.direct.stop();
  const answer = f.direct.control({ type: "ask", id: "stop-cancel" });
  const rejected = assert.rejects(answer);
  await f.direct.control({ type: "cancel", id: "stop-cancel" });
  await settle();
  assert.equal(
    f.direct.asking,
    null,
    "cancel must release a shared-tail waiter immediately",
  );
  await rejected;
  a.committed("tail");
  a.final("tail");
  await settle();
  assert(!f.sent.some((v) => v.type === "ask"));
  assert(f.events.some((v) => v.type === "transcription_tail" && !v.detail));
});
test("cancelled token acquisition cannot revive a stopped recording", async (t) => {
  const f = fixture(t);
  f.setToken(false);
  const starting = f.direct.start();
  f.direct.stop();
  await assert.rejects(starting, /取消/);
  for (const v of f.sent)
    if (v.type === "asr_token")
      f.direct.handle({ ...v, token: "ek_synthetic" });
  assert.equal(f.sockets.length, 0);
  assert.equal(f.direct.phase, "idle");
});
test("55-minute handover preserves old tails and answers include both sides of the handover", async (t) => {
  const f = fixture(t),
    [a, b] = await f.start();
  f.pcm();
  f.pcm("candidate");
  f.advance(55 * 60000);
  await settle();
  assert.equal(f.sockets.length, 4);
  assert.notEqual(f.channel().ws, a);
  assert(!a.closed && !b.closed);
  const answer = f.direct.control({ type: "ask" });
  a.committed("old-a");
  b.committed("old-b");
  a.final("old-a");
  b.final("old-b");
  await answer;
  await settle();
  assert(a.closed && b.closed);
  assert.equal(Object.keys(f.sent.find((v) => v.type === "ask").cut).length, 4);
});

// Integration checks require the adjacent private apps/cloud checkout.
// Real shared desktop state machine + real cloud handlers + SQLite/R2 fixtures.
// Only OpenAI and transport delivery are simulated. No live keys or media.
import test from "node:test";
import assert from "node:assert/strict";
import { DirectTranscription } from "../packages/transcription/direct.mjs";
import { fixture as database } from "../apps/cloud/tests/helpers.mjs";
import { Store } from "../apps/cloud/worker/store.js";
import { CaptureSession } from "../apps/cloud/worker/session.js";
import { runAnswer } from "../apps/cloud/worker/answers.js";
import { readContext } from "../apps/cloud/worker/context.js";
const tick = () => new Promise(setImmediate);
async function setup(t) {
  const env = database(),
    store = new Store(env),
    sent = [],
    events = [],
    requests = [],
    sockets = [],
    tasks = [];
  let now = Date.now(),
    outage = false,
    loseACK = false,
    client;
  const batch = env.DB.batch;
  env.DB.batch = async (items) => {
    if (
      outage &&
      items.some((i) => i.query.startsWith("INSERT OR IGNORE INTO turns"))
    )
      throw Error("synthetic D1 outage");
    return batch(items);
  };
  const deliver = (e) => {
    events.push(e);
    if (e.type !== "utterance_saved" || !loseACK) client?.handle(e);
  };
  const createSession = () =>
    new CaptureSession({
      env,
      store,
      emit: deliver,
      close() {},
      issueToken: async () => ({
        token: "ek_synthetic",
        session: { type: "transcription" },
      }),
      answer: (args) =>
        runAnswer({
          ...args,
          fetcher: async (_, options) => {
            requests.push(JSON.parse(options.body));
            return new Response(
              "data: " +
                JSON.stringify({
                  type: "response.completed",
                  response: { status: "completed", output: [] },
                }) +
                "\n\n",
            );
          },
        }),
    });
  let session = createSession();
  await session.ready();
  await store.run(
    "INSERT INTO chats VALUES(?,?,?)",
    "test-chat",
    "synthetic",
    Date.now(),
  );
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
      const e = JSON.parse(raw);
      this.sent.push(e);
      if (e.type === "session.update")
        queueMicrotask(() => this.receive({ type: "session.updated" }));
    }
    receive(e) {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(e) }),
      );
    }
    close() {
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
  }
  client = new DirectTranscription({
    send: (e) => {
      sent.push(e);
      const p = session.command(e);
      tasks.push(p);
      return p;
    },
    WebSocket: Socket,
    now: () => now,
    makeVAD: async () => ({ voice: () => false, destroy() {} }),
    emit: (e) => events.push(e),
    fail: (detail) => events.push({ type: "fatal", detail }),
    tailMs: 1000,
    commitMs: 1000,
  });
  client.handle({ type: "session_ready" });
  await client.start();
  t.after(async () => {
    client.connected = false;
    client.reset();
    clearInterval(client.timer);
    await Promise.allSettled(tasks);
    await session.dispose();
  });
  const drain = async () => {
    for (let n = 0; n < 6; n++) await tick();
    await Promise.allSettled(tasks);
  };
  const channel = (role = "interviewer") => client.active.get(role);
  const pcm = (role = "interviewer") => client.pcm(role, new ArrayBuffer(4800));
  const confirm = (c, item) =>
    c.ws.receive({ type: "input_audio_buffer.committed", item_id: item });
  const final = (c, item, text) =>
    c.ws.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: item,
      transcript: text,
    });
  return {
    env,
    store,
    client,
    sent,
    events,
    requests,
    sockets,
    channel,
    pcm,
    confirm,
    final,
    drain,
    outage: (v) => (outage = v),
    loseACK: (v) => (loseACK = v),
    async advance() {
      now += 31000;
      client.tick();
      await drain();
    },
    async reconnect() {
      client.handle({ type: "disconnected" });
      await session.dispose();
      session = createSession();
      await session.ready();
      await drain();
    },
    async sentence(item, text, role = "interviewer") {
      const c = channel(role);
      pcm(role);
      client.commit(c);
      confirm(c, item);
      final(c, item, text);
      await drain();
    },
    async image(id, size = 200000) {
      await store.image(await store.timeline(), {
        request_id: id,
        image_data:
          "data:image/png;base64," +
          Buffer.alloc(size, id.charCodeAt(0)).toString("base64"),
        captured_at: new Date().toISOString(),
      });
    },
    async read(args = {}) {
      const r = await readContext(store, args);
      assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text));
      return r.structuredContent;
    },
    async ask(id) {
      await client.control({
        type: "ask",
        id,
        chat: "test-chat",
        text: "synthetic question",
        images: [],
      });
      await drain();
      return JSON.parse(
        (await store.one("SELECT context FROM messages WHERE id=?", id))
          .context,
      );
    },
  };
}
test("changing questions: live screenshots, corrected speech and independent readers keep their own progress", async (t) => {
  const f = await setup(t),
    a = await f.read(),
    b = await f.read();
  await f.sentence("question", "Use a heap.");
  await f.image("page-a");
  const first = await f.read({ cursor: a.cursor });
  assert.deepEqual(
    first.images.map((i) => i.id),
    ["page-a"],
  );
  assert.match(first.transcripts[0].text, /heap/);
  await f.sentence("correction", "Correction: duplicates are allowed.");
  await f.sentence("candidate", "I will use a map.", "candidate");
  await f.image("page-b");
  const stale = await f.read({ cursor: a.cursor });
  assert.equal(stale.images[0].id, "page-b");
  assert.equal(stale.images.length, 2);
  const next = await f.read({ cursor: first.cursor });
  assert.deepEqual(
    next.images.map((i) => i.id),
    ["page-b"],
  );
  assert.equal(next.transcripts.length, 2);
  const other = await f.read({ cursor: b.cursor });
  assert.equal(other.images.length, 2);
  assert.equal(other.transcripts.length, 3);
  assert.equal((await f.read({ cursor: next.cursor })).images.length, 0);
});
test("database outage during back-and-forth speech retains every complete sentence and all screenshots remain readable", async (t) => {
  const f = await setup(t),
    baseline = await f.read();
  f.outage(true);
  for (let i = 0; i < 12; i++)
    await f.sentence("u" + i, "turn-" + i, i % 2 ? "candidate" : "interviewer");
  await f.image("during-outage");
  const before = await f.read({ cursor: baseline.cursor });
  assert.equal(before.images[0].id, "during-outage");
  assert.equal(before.transcripts.length, 0);
  assert.equal(f.client.outbox.size, 12);
  assert.equal(f.client.phase, "active");
  f.outage(false);
  await f.advance();
  assert.equal(f.client.outbox.size, 0);
  const after = await f.read({ cursor: before.cursor });
  assert.equal(after.transcripts.length, 12);
  assert.equal(after.images.length, 0);
  assert.equal(new Set(after.transcripts.map((t) => t.text)).size, 12);
});
test("lost save ACK blocks an answer without duplicating or losing the sentence after recovery", async (t) => {
  const f = await setup(t);
  f.loseACK(true);
  await f.sentence("one", "required-before-answer");
  const asking = f.ask("lost-ack");
  await tick();
  assert.equal(f.requests.length, 0);
  assert.equal((await f.read()).transcripts[0].text, "required-before-answer");
  f.loseACK(false);
  await f.advance();
  const context = await asking;
  assert.equal(context.turns.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.client.outbox.size, 0);
  assert.equal(
    (await f.store.one("SELECT COUNT(*) n FROM turns WHERE status='final'")).n,
    1,
  );
});
test("next-question speech saved first cannot cross the answer cutoff", async (t) => {
  const f = await setup(t),
    c = f.channel();
  f.pcm();
  const asking = f.ask("cutoff");
  f.confirm(c, "before");
  f.pcm();
  f.client.commit(c);
  f.confirm(c, "after");
  f.final(c, "after", "EXCLUDE_NEXT_QUESTION");
  await f.drain();
  assert.equal(f.requests.length, 0);
  f.final(c, "before", "INCLUDE_CURRENT_QUESTION");
  await asking;
  const input = JSON.stringify(f.requests[0].input);
  assert.match(input, /INCLUDE_CURRENT_QUESTION/);
  assert.doesNotMatch(input, /EXCLUDE_NEXT_QUESTION/);
});
test("stop followed immediately by answer still includes the stopped recording tail", async (t) => {
  const f = await setup(t),
    c = f.channel();
  f.pcm();
  f.client.commit(c);
  f.pcm();
  f.client.stop();
  const asking = f.ask("stop-then-answer");
  f.confirm(c, "previous");
  f.final(c, "previous", "EARLIER_SENTENCE");
  await tick();
  f.confirm(c, "tail");
  await f.drain();
  assert.equal(
    f.requests.length,
    0,
    "must not answer before stopped tail is final and saved",
  );
  f.final(c, "tail", "STOPPED_TAIL_REQUIRED");
  await asking;
  assert.match(JSON.stringify(f.requests[0].input), /STOPPED_TAIL_REQUIRED/);
});
test("disconnect stops media; retained finals save on reconnect and do not require restarting recording", async (t) => {
  const f = await setup(t);
  f.outage(true);
  await f.sentence("before-disconnect", "PRESERVED_FINAL");
  assert.equal(f.client.outbox.size, 1);
  f.outage(false);
  await f.reconnect();
  assert.equal(f.client.phase, "idle");
  assert.equal(f.client.outbox.size, 0);
  assert.equal((await f.read()).transcripts[0].text, "PRESERVED_FINAL");
  assert.equal(f.sockets.length, 2);
  await f.client.start();
  await f.sentence("after-reconnect", "SECOND_RECORDING");
  const m = await f.read();
  assert.equal(m.transcripts.length, 2);
  assert(m.transcripts.some((t) => t.text === "SECOND_RECORDING"));
});
test("large burst paginates completely; discarded replies and new arrivals never consume images", async (t) => {
  const f = await setup(t),
    base = await f.read();
  for (let n = 0; n < 11; n++)
    await f.image("burst-" + String(n).padStart(2, "0"), 700000);
  const lost = await f.read({ cursor: base.cursor });
  assert(lost.more.new > 0);
  await f.image("new-question", 700000);
  let page = await f.read({ cursor: base.cursor }),
    ids = new Set();
  assert.equal(page.images[0].id, "new-question");
  for (let n = 0; n < 20; n++) {
    for (const image of page.images) if (image.included) ids.add(image.id);
    if (!page.more.new) break;
    page = await f.read({ cursor: page.cursor });
  }
  assert.equal(ids.size, 12);
  assert.equal(page.more.new, 0);
  const independent = await f.read();
  assert.equal(independent.images.length, 12);
});
test("stop and restart while an old tail finishes includes both recordings without stopping the new one", async (t) => {
  const f = await setup(t),
    old = f.channel();
  f.pcm();
  f.client.stop();
  await f.client.start();
  await f.sentence("new", "NEW_RECORDING_REQUIRED");
  const asking = f.ask("two-recordings");
  f.confirm(old, "old");
  f.final(old, "old", "OLD_TAIL_REQUIRED");
  await asking;
  const input = JSON.stringify(f.requests[0].input);
  assert.match(input, /OLD_TAIL_REQUIRED/);
  assert.match(input, /NEW_RECORDING_REQUIRED/);
  assert.equal(f.client.phase, "active");
  assert.equal(f.client.active.size, 2);
});
test("stopping a pending answer cancels it while still saving the complete recording tail", async (t) => {
  const f = await setup(t),
    c = f.channel();
  f.pcm();
  f.client.commit(c);
  f.pcm();
  const answering = f.client.control({
    type: "ask",
    id: "cancelled",
    chat: "test-chat",
  });
  const rejected = assert.rejects(answering, /取消/);
  f.client.stop();
  await rejected;
  f.confirm(c, "first");
  f.final(c, "first", "FIRST_REQUIRED");
  await tick();
  f.confirm(c, "last");
  f.final(c, "last", "LAST_REQUIRED");
  await f.drain();
  assert.equal(f.requests.length, 0);
  const context = await f.read();
  assert.deepEqual(
    new Set(context.transcripts.map((x) => x.text)),
    new Set(["FIRST_REQUIRED", "LAST_REQUIRED"]),
  );
});
test("partial speech read before finalization is returned again with its corrected final text", async (t) => {
  const f = await setup(t),
    c = f.channel(),
    base = await f.read();
  f.pcm();
  f.client.commit(c);
  f.confirm(c, "correction");
  c.ws.receive({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "correction",
    delta: "array is sorted",
  });
  await f.advance();
  const partial = await f.read({ cursor: base.cursor });
  assert.equal(partial.transcripts[0].text, "array is sorted");
  f.final(c, "correction", "array is NOT sorted");
  await f.drain();
  const final = await f.read({ cursor: partial.cursor });
  assert.equal(final.transcripts.length, 1);
  assert.equal(final.transcripts[0].text, "array is NOT sorted");
  assert.equal(final.transcripts[0].id, partial.transcripts[0].id);
});

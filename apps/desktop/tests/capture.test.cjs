const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function compile(relativePath, globals = {}) {
  const filename = path.join(__dirname, "..", relativePath);
  const exports = {};
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, { exports, Int16Array, ArrayBuffer, AbortController, URL, ...globals }, { filename });
  return exports;
}

function timers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    tasks,
    setTimeout(fn) { const id = nextId++; tasks.set(id, fn); return id; },
    clearTimeout(id) { tasks.delete(id); },
    setInterval(fn) { const id = nextId++; tasks.set(id, fn); return id; },
    clearInterval(id) { tasks.delete(id); },
  };
}

function audioFixture({ addModule = () => Promise.resolve() } = {}) {
  let now = 0;
  class Track extends EventTarget {
    constructor(kind = "audio") { super(); this.kind = kind; this.muted = false; this.readyState = "live"; this.stops = 0; }
    stop() { this.readyState = "ended"; this.stops++; }
    mute(value) { this.muted = value; this.dispatchEvent(new Event(value ? "mute" : "unmute")); }
    end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
  }
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  }
  class Context extends EventTarget {
    static all = [];
    constructor() { super(); this.state = "running"; this.sampleRate = 24000; this.audioWorklet = { addModule }; this.processor = null; Context.all.push(this); }
    get currentTime() { return now / 1000; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    resume() { this.setState("running"); return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    setState(state) { this.state = state; this.dispatchEvent(new Event("statechange")); }
    frame(age = 0) { this.processor.port.onmessage?.({ data: { pcm: new ArrayBuffer(2048), endTime: this.currentTime - age } }); }
  }
  class WorkletNode {
    constructor(context, name, options) { this.port = { close() {} }; this.options = options; context.processor = this; }
    connect() {}
    disconnect() {}
  }
  const clock = timers();
  const module = compile("src/audioCapture.ts", {
    MediaStream: Stream, AudioContext: Context, AudioWorkletNode: WorkletNode,
    document: { baseURI: "file:///application/dist/index.html" }, window: clock, Date: { now: () => now },
  });
  return { Track, Stream, Context, clock, module, advance: (milliseconds) => { now += milliseconds; } };
}

test("display capture lowers video overhead while retaining the video track", async () => {
  let constraints;
  const track = { stops: 0, stop() { this.stops++; } };
  const stream = { getAudioTracks: () => [{}], getTracks: () => [track] };
  const { requestCaptureStream } = compile("src/audioCapture.ts", { navigator: { mediaDevices: {
    async getDisplayMedia(options) { constraints = options; return stream; },
  } } });
  assert.equal(await requestCaptureStream("interviewer"), stream);
  assert.deepEqual(JSON.parse(JSON.stringify(constraints)), {
    audio: true, video: { frameRate: { max: 1 }, width: { max: 64 }, height: { max: 64 } },
  });
  assert.equal(track.stops, 0);
});

test("ordinary silence remains healthy; mute/unmute has separate recoverable state", async () => {
  const fixture = audioFixture();
  const track = new fixture.Track();
  const states = [], chunks = [];
  let ended = 0;
  const handle = fixture.module.startLocalAudioCapture({
    stream: new fixture.Stream([track]), onChunk: (chunk) => chunks.push(chunk),
    onHealthChange: (state) => states.push(state), onEnded: () => ended++,
  });
  const context = fixture.Context.all[0];
  assert.equal(handle.getHealth().phase, "interrupted");
  await Promise.resolve();
  for (let index = 0; index < 10; index++) { fixture.advance(500); context.frame(); }
  assert.equal(handle.getHealth().phase, "ready");
  assert.equal(chunks.length, 10);
  assert(new Int16Array(chunks[0]).every((sample) => sample === 0));
  track.mute(true);
  context.frame();
  assert.equal(handle.getHealth().phase, "muted");
  assert.equal(chunks.length, 10);
  assert.equal(ended, 0);
  track.mute(false);
  context.frame();
  assert.equal(handle.getHealth().phase, "ready");
  assert.equal(chunks.length, 11);
  assert.equal(states.filter((state) => state.phase === "error").length, 0);
  handle.stop();
  assert.equal(fixture.clock.tasks.size, 0);
});

test("AudioContext suspension and missing PCM callbacks are visible and can recover", async () => {
  const fixture = audioFixture();
  const track = new fixture.Track();
  const handle = fixture.module.startLocalAudioCapture({ stream: new fixture.Stream([track]), onChunk() {} });
  const context = fixture.Context.all[0];
  await Promise.resolve();
  context.frame();
  context.setState("suspended");
  assert.equal(handle.getHealth().phase, "interrupted");
  context.setState("running");
  assert.equal(handle.getHealth().phase, "ready");
  fixture.advance(4000);
  for (const callback of fixture.clock.tasks.values()) callback();
  assert.equal(handle.getHealth().phase, "interrupted");
  context.frame();
  assert.equal(handle.getHealth().phase, "ready");
  handle.stop();
});

test("one ended media source does not stop an independent source and notifies once", async () => {
  const fixture = audioFixture();
  const first = new fixture.Track(), second = new fixture.Track();
  let ended = 0;
  const a = fixture.module.startLocalAudioCapture({ stream: new fixture.Stream([first]), onChunk() {}, onEnded: () => ended++ });
  const b = fixture.module.startLocalAudioCapture({ stream: new fixture.Stream([second]), onChunk() {} });
  await Promise.resolve();
  fixture.Context.all.forEach((context) => context.frame());
  first.end(); first.end();
  assert.equal(ended, 1);
  assert.equal(a.getHealth().phase, "error");
  assert.equal(b.getHealth().phase, "ready");
  assert.equal(second.stops, 0);
  a.stop(); b.stop();
});

test("worklet startup failure and processor crashes remain visible until capture is replaced", async () => {
  const fixture = audioFixture({ addModule: () => Promise.reject(new Error("missing asset")) });
  const handle = fixture.module.startLocalAudioCapture({ stream: new fixture.Stream([new fixture.Track()]), onChunk() {} });
  await new Promise(setImmediate);
  for (const callback of fixture.clock.tasks.values()) callback();
  assert.equal(handle.getHealth().phase, "error");
  handle.stop();
  const healthy = audioFixture();
  const other = healthy.module.startLocalAudioCapture({ stream: new healthy.Stream([new healthy.Track()]), onChunk() {} });
  await Promise.resolve();
  const context = healthy.Context.all[0];
  context.frame();
  context.processor.onprocessorerror();
  context.frame();
  assert.equal(other.getHealth().phase, "error");
  other.stop();
});

test("stopping during worklet load cannot revive capture; stale queued PCM is discarded", async () => {
  let finish;
  const fixture = audioFixture({ addModule: () => new Promise((resolve) => { finish = resolve; }) });
  const track = new fixture.Track();
  const handle = fixture.module.startLocalAudioCapture({ stream: new fixture.Stream([track]), onChunk() {} });
  handle.stop();
  finish();
  await Promise.resolve();
  assert.equal(fixture.Context.all[0].processor, null);
  assert.equal(track.stops, 1);
  const healthy = audioFixture();
  const chunks = [];
  const other = healthy.module.startLocalAudioCapture({ stream: new healthy.Stream([new healthy.Track()]), onChunk: (chunk) => chunks.push(chunk) });
  await Promise.resolve();
  const context = healthy.Context.all[0];
  context.frame(2);
  assert.equal(other.getHealth().phase, "interrupted");
  assert.equal(chunks.length, 0);
  context.frame();
  assert.equal(chunks.length, 1);
  assert.equal(other.getHealth().phase, "ready");
  assert.equal(context.processor.options.channelCountMode, "explicit");
  assert.equal(context.processor.options.channelCount, 1);
  other.stop();
});

test("native worklet converts and clamps PCM across variable render block sizes", () => {
  let Processor;
  const messages = [];
  const scope = {
    Int16Array, currentTime: 2, sampleRate: 24000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (data, transfers) => messages.push({ data, transfers }) }; } },
    registerProcessor(name, klass) { assert.equal(name, "interview-pcm"); Processor = klass; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/pcm-worklet.js"), "utf8"), scope);
  const processor = new Processor();
  assert.equal(processor.process([]), true);
  processor.process([[Float32Array.from([-2, -1, -0.5, 0, 0.5, 1, 2])]]);
  processor.process([[new Float32Array(1017).fill(0.25)]]);
  assert.equal(messages.length, 1);
  assert.deepEqual(Array.from(new Int16Array(messages[0].data.pcm).slice(0, 7)), [-32768, -32768, -16384, 0, 16383, 32767, 32767]);
  assert.equal(new Int16Array(messages[0].data.pcm)[1023], 8191);
  assert.equal(messages[0].transfers[0], messages[0].data.pcm);
  assert.equal(messages[0].data.endTime, 2 + 1017 / 24000);
  processor.process([[new Float32Array(2048)]]);
  assert.equal(messages.length, 3);
  assert.notEqual(messages[1].data.pcm, messages[2].data.pcm);
  processor.process([[new Float32Array(17).fill(0.5)]]);
  processor.port.onmessage({ data: { type: 'finish' } });
  assert.equal(messages[3].data.pcm.byteLength, 34);
  assert.equal(new Int16Array(messages[3].data.pcm)[0], 16383);
  assert.equal(messages[4].data.type, 'finished');
  assert.equal(processor.process([[new Float32Array(128)]]), false);
  assert.equal(messages.length, 5);
});

test('audio finish forwards the final PCM before closing the media', async () => {
  const f = audioFixture(), track = new f.Track(), chunks = [];
  const handle = f.module.startLocalAudioCapture({ stream: new f.Stream([track]), onChunk: pcm => chunks.push(pcm) });
  await Promise.resolve();
  const context = f.Context.all.at(-1);
  context.processor.port.postMessage = message => {
    assert.equal(message.type, 'finish');
    context.frame();
    assert.equal(track.stops, 0);
    context.processor.port.onmessage({ data: { type: 'finished' } });
  };
  assert.equal(await handle.finish(), true);
  assert.equal(chunks.length, 1);
  assert.equal(track.stops, 1);
  assert.equal(context.state, 'closed');
  handle.stop(); assert.equal(track.stops, 1);
});

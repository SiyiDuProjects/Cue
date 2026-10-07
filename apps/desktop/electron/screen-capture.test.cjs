const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createScreenCaptureService } = require("./screen-capture.cjs");

function source(id, displayId = "") {
  return { id, display_id: displayId, name: `Source ${id}`, thumbnail: {
    isEmpty: () => false, toDataURL: () => `data:image/png;base64,${id}`,
    toPNG: () => Buffer.from(`synthetic-${id}`), toJPEG: () => Buffer.from(`synthetic-${id}`),
  } };
}

function fixture() {
  const state = { sources: [source("screen:second", "2"), source("screen:primary", "1"), source("window:question")] };
  const service = createScreenCaptureService({ getSources: async ({ types }) => state.sources.filter((item) => types.some((type) => item.id.startsWith(type))) }, {
    getPrimaryDisplay: () => ({ id: 1 }),
  });
  return { state, service };
}

test("screenshots default to the primary monitor even when another screen is listed first", async () => {
  const { service } = fixture();
  const image = await service.captureSnapshot();
  assert.match(image.image_data, /^data:image\/png;base64,/);
  assert.equal(image.source_id, "screen:primary");
  assert.equal(Buffer.from(image.image_data.split(",")[1], "base64").toString(), "synthetic-screen:primary");
  const choices = await service.listSources();
  assert.deepEqual(choices.filter((item) => item.selected).map((item) => item.id), ["screen:primary"]);
});

test("manual window selection overrides the screenshot default without changing system audio", async () => {
  const { service } = fixture();
  await service.selectSource("window:question");
  const before = Date.now();
  const image = await service.captureSnapshot();
  assert.equal(image.source_id, "window:question");
  assert(Date.parse(image.captured_at) >= before);
  assert(Date.parse(image.captured_at) <= Date.now());
  assert.equal(Buffer.from(image.image_data.split(",")[1], "base64").toString(), "synthetic-window:question");
  assert.equal((await service.getAudioCaptureSource()).id, "screen:primary");
});

test("a vanished selection fails instead of silently sending another screen", async () => {
  const { state, service } = fixture();
  await service.selectSource("window:question");
  state.sources = state.sources.filter((item) => item.id !== "window:question");
  await assert.rejects(service.captureSnapshot(), /无法截图/);
  await assert.rejects(service.selectSource("window:untrusted"), /不可用/);
  assert((await service.listSources()).every((item) => !item.selected));
  await assert.rejects(service.captureSnapshot(), /无法截图/);
});

test("default never picks a window or an ambiguous secondary monitor", async () => {
  const { state, service } = fixture();
  state.sources = [source("window:question"), source("screen:second", "2"), source("screen:third", "3")];
  await assert.rejects(service.captureSnapshot(), /无法截图/);
  state.sources = [source("window:question"), source("screen:only")];
  assert.equal((await service.captureSnapshot()).source_id, "screen:only");
  state.sources = [source("window:question")];
  await assert.rejects(service.captureSnapshot(), /无法截图/);
});

test("a source change while capture is pending invalidates the old image", async () => {
  let finish;
  const sources = [source("screen:a", "1"), source("screen:b", "2")];
  const service = createScreenCaptureService({ getSources: async ({ thumbnailSize }) => {
    if (thumbnailSize.width > 1000) return new Promise((resolve) => { finish = resolve; });
    return sources;
  } }, { getPrimaryDisplay: () => ({ id: 1 }) });
  await service.selectSource("screen:a");
  const pending = service.captureSnapshot();
  await service.selectSource("screen:b");
  finish(sources);
  await assert.rejects(pending, /来源已改变/);
});

test("oversized native images fail before creating an upload payload", async () => {
  const huge = source("window:huge");
  huge.thumbnail.toPNG = () => Buffer.alloc(4_500_001);
  huge.thumbnail.toJPEG = () => Buffer.alloc(4_500_001);
  const service = createScreenCaptureService({ getSources: async () => [huge] }, { getPrimaryDisplay: () => ({ id: 1 }) });
  await service.selectSource("window:huge");
  await assert.rejects(service.captureSnapshot(), /截图过大/);
});

test("captures 4K text losslessly and only uses high-quality JPEG when PNG exceeds the bound", async () => {
  const native = source("screen:primary", "1");
  const sizes = [], qualities = [];
  native.thumbnail.toJPEG = quality => { qualities.push(quality); return Buffer.from("jpeg-fallback"); };
  const service = createScreenCaptureService({ getSources: async ({ thumbnailSize }) => {
    sizes.push(thumbnailSize); return [native];
  } }, { getPrimaryDisplay: () => ({ id: 1 }) });
  assert.match((await service.captureSnapshot()).image_data, /^data:image\/png;/);
  assert.deepEqual(qualities, []);
  assert.deepEqual(sizes[0], { width: 4096, height: 4096 });
  native.thumbnail.toPNG = () => Buffer.alloc(4_500_001);
  assert.match((await service.captureSnapshot()).image_data, /^data:image\/jpeg;/);
  assert.deepEqual(qualities, [92]);
  native.thumbnail.toJPEG = () => Buffer.alloc(4_500_001);
  await assert.rejects(service.captureSnapshot(), /截图过大/);
});

function ownWindow(id, initiallyProtected = false) {
  return {
    protected: initiallyProtected, changes: [],
    isDestroyed: () => false,
    getMediaSourceId: () => id,
    isContentProtected() { return this.protected; },
    setContentProtection(value) { this.protected = value; this.changes.push(value); },
  };
}

test("Sage is excluded from choices and cannot be explicitly selected", async () => {
  const window = ownWindow("window:sage");
  const service = createScreenCaptureService({ getSources: async () => [
    source("screen:primary", "1"), source("window:sage"), source("window:question"),
  ] }, { getPrimaryDisplay: () => ({ id: 1 }) }, () => [window]);
  assert.deepEqual((await service.listSources()).map((item) => item.id), ["screen:primary", "window:question"]);
  await assert.rejects(service.selectSource("window:sage"), /不可用/);
  await service.selectSource("window:question");
  assert.equal((await service.captureSnapshot()).source_id, "window:question");
  assert.equal(window.protected, false);
});

test("overlapping screenshot and source preview restore protection after the last capture", { skip: process.platform !== "win32" }, async () => {
  const window = ownWindow("window:sage");
  const alreadyProtected = ownWindow("window:protected", true);
  const pending = new Map();
  let started;
  const bothStarted = new Promise((resolve) => { started = resolve; });
  const service = createScreenCaptureService({ getSources: async ({ thumbnailSize }) => {
    if (!thumbnailSize.width) return [source("screen:primary", "1")];
    assert.equal(window.protected, true);
    return new Promise((resolve, reject) => {
      pending.set(thumbnailSize.width, { resolve, reject });
      if (pending.size === 2) started();
    });
  } }, { getPrimaryDisplay: () => ({ id: 1 }) }, () => [window, alreadyProtected]);
  const snapshot = service.captureSnapshot();
  const preview = service.listSources();
  await bothStarted;
  pending.get(320).resolve([source("screen:primary", "1")]);
  await preview;
  assert.equal(window.protected, true);
  assert.equal((await service.getAudioCaptureSource()).id, "screen:primary");
  pending.get(4096).reject(new Error("native capture failed"));
  await assert.rejects(snapshot, /native capture failed/);
  assert.deepEqual(window.changes, [true, false]);
  assert.equal(alreadyProtected.protected, true);
  assert.deepEqual(alreadyProtected.changes, []);
});

test("audio source discovery never changes window capture settings", async () => {
  const window = ownWindow("window:sage");
  const service = createScreenCaptureService({ getSources: async () => [source("screen:primary", "1")] },
    { getPrimaryDisplay: () => ({ id: 1 }) }, () => [window]);
  assert.equal((await service.getAudioCaptureSource()).id, "screen:primary");
  assert.deepEqual(window.changes, []);
});

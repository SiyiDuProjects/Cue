// Native Windows capture test; only samples synthetic windows, never saves the desktop.
const { app, BrowserWindow, desktopCapturer, screen, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const moduleArgument = process.argv.find((value) => value.startsWith("--capture-module="));
const captureModule = moduleArgument ? moduleArgument.slice("--capture-module=".length) : "../electron/screen-capture.cjs";
const { createScreenCaptureService } = require(captureModule);

const artifactDir = path.resolve(__dirname, "../../../artifacts/screenshot-self-exclusion");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "sage-capture-test-")));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windows = [];
const report = { captureModule, modelCalls: 0, audioCaptured: false, samples: [] };
const timeout = setTimeout(() => { console.error("Native capture test timed out"); app.exit(1); }, 20000);

app.whenReady().then(async () => {
  assert.equal(process.platform, "win32");
  const display = screen.getPrimaryDisplay();
  const { x, y } = display.workArea;
  const question = new BrowserWindow({ x: x + 60, y: y + 60, width: 700, height: 500,
    title: "Sage capture test - question", backgroundColor: "#21bb52", alwaysOnTop: true,
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(question);
  await question.loadURL("about:blank");
  question.showInactive();
  const sage = new BrowserWindow({ x: x + 160, y: y + 160, width: 400, height: 260,
    title: "Sage capture test - assistant", backgroundColor: "#d22a47", alwaysOnTop: true,
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(sage);
  await sage.loadURL("about:blank");
  sage.showInactive();
  sage.moveTop();
  await sleep(300);

  function sample(image, name, expected) {
    const size = image.getSize();
    const px = Math.floor((x + 340 - display.bounds.x) / display.bounds.width * size.width);
    const py = Math.floor((y + 270 - display.bounds.y) / display.bounds.height * size.height);
    const pixel = image.crop({ x: px, y: py, width: 1, height: 1 }).toBitmap();
    const rgb = [pixel[2], pixel[1], pixel[0]];
    report.samples.push({ name, rgb, expected });
    assert(rgb.every((channel, i) => Math.abs(channel - expected[i]) < 35), `${name}: ${rgb}`);
  }
  async function rawScreen() {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 2560, height: 2560 } });
    return sources.find((source) => String(source.display_id) === String(display.id)).thumbnail;
  }

  sample(await rawScreen(), "before: Sage visible", [210, 42, 71]);
  const service = createScreenCaptureService(desktopCapturer, screen, () => [sage]);
  for (let i = 0; i < 3; i += 1) {
    const [snapshot, choices] = await Promise.all([service.captureSnapshot(), service.listSources()]);
    sample(nativeImage.createFromDataURL(snapshot.image_data), `capture ${i + 1}: underlying question`, [33, 187, 82]);
    assert(!choices.some((source) => source.id === sage.getMediaSourceId()));
    assert(choices.some((source) => source.id === question.getMediaSourceId()));
    assert.equal(sage.isContentProtected(), false);
    assert.equal(sage.isVisible(), true);
  }
  await sleep(150);
  sample(await rawScreen(), "after: system capture can still see Sage", [210, 42, 71]);
  await assert.rejects(service.selectSource(sage.getMediaSourceId()), /不可用/);
  await service.selectSource(question.getMediaSourceId());
  const selected = await service.captureSnapshot();
  assert.equal(selected.source_id, question.getMediaSourceId());
  assert.equal((await service.getAudioCaptureSource()).display_id, String(display.id));
  report.passed = true;
}).catch((error) => {
  report.passed = false;
  report.error = error.stack;
}).finally(() => {
  clearTimeout(timeout);
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "native-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.passed ? 0 : 1);
});

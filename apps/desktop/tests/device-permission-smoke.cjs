// Requires explicit user permission. Local only: no saved audio, images or network.
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const { buildSync } = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createScreenCaptureService } = require("../electron/screen-capture.cjs");
if (process.env.INTERVIEW_DEVICE_TEST_ALLOWED !== "1") {
  console.error("Explicit permission is required for real microphone and system capture.");
  app.exit(2);
} else {
  const output = path.resolve(__dirname, "../../../artifacts/release-2026-09-27");
  fs.mkdirSync(output, { recursive: true });
  app.setPath("userData", path.join(output, "device-check-profile"));
  const title = "Sage · 设备检查";
  let win;
  const timer = setTimeout(() => finish(new Error("DeviceCheckTimeout")), 20000);
  function finish(error, result) {
    clearTimeout(timer);
    fs.writeFileSync(path.join(output, "device-check.json"), JSON.stringify({
      local_only: true, retained_audio_or_images: false,
      status: error ? "failed" : "passed", error_class: error?.name || null,
      ...result,
    }, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    console.log(JSON.stringify({ status: error ? "failed" : "passed", error_class: error?.name || null, ...result }));
    app.exit(error ? 1 : 0);
  }
  app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({ width: 540, height: 180, show: true, title,
        webPreferences: { sandbox: true, contextIsolation: true } });
      const ses = win.webContents.session;
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
      const allowed = new Set(["media", "display-capture", "microphone"]);
      ses.setPermissionCheckHandler((contents, permission) => contents?.id === win.webContents.id && allowed.has(permission));
      ses.setPermissionRequestHandler((contents, permission, callback) => callback(contents?.id === win.webContents.id && allowed.has(permission)));
      const capture = createScreenCaptureService(desktopCapturer, screen);
      ses.setDisplayMediaRequestHandler(async (request, callback) => {
        try {
          if (request.frame !== win.webContents.mainFrame) return callback({});
          callback({ video: await capture.getAudioCaptureSource(), audio: "loopback" });
        } catch { callback({}); }
      }, { useSystemPicker: false });
      const html = path.join(output, "device-check.html");
      fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><base href="' +
        pathToFileURL(path.resolve(__dirname, "../dist") + path.sep).href +
        '"><title>' + title + '</title><h2>正在检查设备</h2><p>仅本机检查，不保存或上传声音、画面。检查完成后自动关闭。</p>');
      await win.loadFile(html);
      const bundle = buildSync({ stdin: {
        contents: 'export { requestCaptureStream, startLocalAudioCapture } from "./src/audioCapture";',
        resolveDir: path.resolve(__dirname, ".."), loader: "ts",
      }, bundle: true, write: false, format: "iife", globalName: "DeviceCheck" }).outputFiles[0].text;
      await win.webContents.executeJavaScript(bundle);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const handles = [];
        const tracks = [];
        const counts = { candidate: 0, interviewer: 0, candidate_recovered: 0 };
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        async function start(speaker, key) {
          const stream = await DeviceCheck.requestCaptureStream(speaker);
          tracks.push(...stream.getTracks());
          const handle = DeviceCheck.startLocalAudioCapture({ stream, onChunk(pcm) {
            if (pcm.byteLength > 0) counts[key]++;
          }});
          handles.push(handle);
          return handle;
        }
        try {
          const candidate = await start("candidate", "candidate");
          const interviewer = await start("interviewer", "interviewer");
          await sleep(5000);
          const candidateHealth = candidate.getHealth().phase;
          const interviewerHealth = interviewer.getHealth().phase;
          candidate.stop();
          const before = counts.interviewer;
          const recovered = await start("candidate", "candidate_recovered");
          await sleep(2000);
          return { counts, candidateHealth, interviewerHealth, recoveredHealth: recovered.getHealth().phase,
            independentSystemCapture: counts.interviewer > before,
            audioTracks: tracks.filter(track => track.kind === "audio").length,
            videoTracks: tracks.filter(track => track.kind === "video").length };
        } finally { handles.forEach(handle => handle.stop()); tracks.forEach(track => track.stop()); }
      })()`, true);
      const sources = await capture.listSources();
      const ownWindow = sources.find(source => source.name === title);
      if (!ownWindow) throw new Error("TestWindowCaptureUnavailable");
      await capture.selectSource(ownWindow.id);
      const snapshot = await capture.captureSnapshot();
      result.testWindowScreenshot = snapshot.image_data.startsWith("data:image/jpeg;base64,");
      snapshot.image_data = ""; // Never save or return captured pixels.
      if (!Object.values(result.counts).every(count => count > 0) ||
          !result.independentSystemCapture || !result.testWindowScreenshot ||
          result.candidateHealth !== "ready" || result.interviewerHealth !== "ready" ||
          result.recoveredHealth !== "ready") throw new Error("DeviceCheckFailed");
      finish(null, result);
    } catch (error) { finish(error); }
  });
}

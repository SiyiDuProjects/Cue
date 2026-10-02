// Offline Electron verification: no microphone, no provider, muted output.
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const artifacts = path.resolve(__dirname, "../../../artifacts");
fs.mkdirSync(artifacts, { recursive: true });
app.setPath("userData", path.join(artifacts, "mock-smoke-electron"));
app.disableHardwareAcceleration();
const script = buildSync({ stdin: {
  contents: 'export { MockAudio } from "./src/mockAudio"; export { startLocalAudioCapture } from "./src/audioCapture";',
  resolveDir: path.resolve(__dirname, ".."), loader: "ts",
}, bundle: true, write: false, format: "iife", globalName: "MockSmoke" }).outputFiles[0].text;
const timer = setTimeout(() => { console.error("MOCK_AUDIO_SMOKE_TIMEOUT"); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  window.webContents.setAudioMuted(true);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
  try {
    // The production worklet URL is resolved against this local document.
    const html = path.join(artifacts, "mock-audio-smoke.html");
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><base href="' +
      pathToFileURL(path.resolve(__dirname, "../dist") + path.sep).href + '"><title>Offline mock audio test</title>');
    await window.loadFile(html);
    await window.webContents.executeJavaScript(script);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const audio = new MockSmoke.MockAudio();
      const frames = [];
      let handle;
      try {
        await audio.resume();
        let resolveNonzero;
        const received = new Promise(resolve => { resolveNonzero = resolve; });
        handle = MockSmoke.startLocalAudioCapture({ stream: audio.stream.clone(), onChunk(pcm) {
          const values = new Int16Array(pcm);
          frames.push({ length: values.length, nonzero: values.some(n => n !== 0) });
          if (frames.some(frame => frame.nonzero)) resolveNonzero();
        }});
        await new Promise(resolve => setTimeout(resolve, 200));
        const bytes = new Uint8Array(24000);
        const pcm = new Int16Array(bytes.buffer);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * Math.PI / 30) * 4000;
        audio.append(btoa(String.fromCharCode(...bytes)));
        await received;
        const first = handle.getHealth();
        handle.stop();
        let resolveSecond;
        const second = new Promise(resolve => { resolveSecond = resolve; });
        handle = MockSmoke.startLocalAudioCapture({ stream: audio.stream.clone(), onChunk(pcm) {
          if (new Int16Array(pcm).some(n => n !== 0)) resolveSecond();
        }});
        audio.clear();
        await new Promise(resolve => setTimeout(resolve, 200));
        audio.append(btoa(String.fromCharCode(...bytes)));
        await second;
        return { frames: frames.length, nonzero: frames.some(frame => frame.nonzero),
          pcmLength: frames[0].length, firstHealth: first.phase, recoveryHealth: handle.getHealth().phase };
      } finally { handle?.stop(); audio.close(); }
    })()`, true);
    if (!result.nonzero || result.pcmLength !== 1024 || result.recoveryHealth !== "ready") throw new Error(JSON.stringify(result));
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, "mock-audio-smoke.json"), JSON.stringify(result, null, 2));
    console.log("MOCK_AUDIO_SMOKE_OK " + JSON.stringify(result));
    clearTimeout(timer); window.destroy(); app.exit(0);
  } catch (error) {
    console.error("MOCK_AUDIO_SMOKE_FAILED " + error.message);
    clearTimeout(timer); window.destroy(); app.exit(1);
  }
});

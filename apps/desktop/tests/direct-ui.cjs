const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cue-direct-ui-")),
);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, cb) =>
    cb({ cancel: /^(https?|wss?):/.test(details.url) }),
  );
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "direct-ui-preload.cjs"),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  const wait = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await run(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error("Direct UI timed out");
  };
  try {
    await win.loadFile(path.join(__dirname, "../dist-mac/content.html"));
    await wait("!!document.querySelector('.content-view')");
    await run(
      "for(const role of ['interviewer','candidate'])window.cueReceive({type:'asr_config',role,stream:role,token:'ek_synthetic',session:{type:'transcription'}})",
    );
    await wait(
      "window.directControls.filter(e=>e.type==='asr_ready').length===2",
    );
    await run(
      "for(const role of ['interviewer','candidate'])window.cueReceive({type:'pcm',role,data:btoa('\\0'.repeat(9600))});window.cueReceive({type:'audio_control',value:{type:'ask',id:'cut'}})",
    );
    assert.deepEqual(await run("window.directControls.map(e=>e.type)"), [
      "asr_ready",
      "asr_ready",
      "asr_commit",
      "asr_commit",
      "ask",
    ]);
    assert.equal(
      await run(
        "window.directSockets.every(s=>s.sent.some(e=>e.type==='input_audio_buffer.append'))",
      ),
      true,
    );
    assert.equal(
      await run(
        "window.directControls.every(e=>!('audio' in e)&&!('token' in e))",
      ),
      true,
    );
    await run("window.cueReceive({type:'disconnected'})");
    assert.equal(await run("window.directSockets.every(s=>s.closed)"), true);
    assert.equal(await run("window.directSockets.length"), 2);
    console.log(
      "PASS packaged Mac bridge, real VAD WASM, dual commit ordering and disconnect cleanup; network blocked",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

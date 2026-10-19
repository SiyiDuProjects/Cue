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
    await run("window.cueReceive({type:'session_ready'})");
    await run("window.cueReceive({type:'audio_control',value:{type:'start'}})");
    await wait("window.directStates.some(e=>e.type==='started')");
    for (const id of ["native", "web"]) {
      await run(
        `for(const role of ['interviewer','candidate'])window.cueReceive({type:'pcm',role,data:btoa('\\0'.repeat(9600))});window.cueReceive({type:'audio_control',value:{type:'ask',id:'${id}',chat:'chat',images:['shot']}})`,
      );
      await wait(
        `window.directControls.some(e=>e.type==='ask'&&e.id==='${id}')`,
      );
      const answer = await run("window.directControls.at(-1)");
      assert.equal(answer.id, id);
      assert.deepEqual(answer.images, ["shot"]);
      assert.equal(Object.keys(answer.cut).length, 2);
    }
    assert.equal(
      await run(
        "window.directSockets.every(s=>s.sent.some(e=>e.type==='input_audio_buffer.append'))",
      ),
      true,
    );
    assert.equal(
      await run(
        "window.directControls.every(e=>!('audio'in e)&&!('token'in e))",
      ),
      true,
    );
    await run(`window.captions=[];const socket=window.directSockets.find(s=>s.sent[0].session.tag==='interviewer');
      socket.receive({type:'conversation.item.input_audio_transcription.delta',item_id:'preview',delta:'你好'});
      socket.receive({type:'conversation.item.input_audio_transcription.delta',item_id:'preview',delta:'，请介绍'});`);
    assert.deepEqual(
      (await run("window.captions")).map((c) => c.text),
      ["你好", "你好，请介绍"],
    );
    await run("window.cueReceive({type:'disconnected'})");
    assert.equal(await run("window.directSockets.every(s=>s.closed)"), true);
    assert.equal(await run("window.directSockets.length"), 2);
    console.log(
      "PASS packaged Mac bridge, real VAD WASM, dual commit ordering, local interviewer captions and disconnect cleanup; network blocked",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

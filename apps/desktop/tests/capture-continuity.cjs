// Exercise the built overlay and real upload queue; synthetic captures only.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(os.tmpdir(), "cue-capture-check-")),
);
app.commandLine.appendSwitch("disable-gpu");
app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((d, cb) =>
      cb({ cancel: /^https?:/.test(d.url) }),
    );
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "chat-ui-preload.cjs"),
        contextIsolation: false,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = async (code) => {
      for (let n = 0; n < 150; n++) {
        if (await js(code)) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw Error("Timed out: " + code);
    };
    const shot = async (id) => {
      const command = {
        id,
        type: "shot",
        generation: "test-desktop",
        expires: Date.now() + 15000,
      };
      await js(
        `window.dispatchEvent(new CustomEvent('cue:event',{detail:${JSON.stringify({ type: "remote_command", command })}}))`,
      );
      await wait(`window.remoteResults.some(r=>r.id===${JSON.stringify(id)})`);
    };
    try {
      await win.loadFile(path.join(__dirname, "../dist/index.html"));
      await wait(
        "document.querySelector('.connection')?.textContent==='已连接'",
      );
      await js("window.uniqueShots=true");
      for (let n = 1; n <= 12; n++) {
        await shot(`capture-${n}`);
        await wait(
          `window.remoteStates.at(-1).selected.includes('shot-${n}') && window.remoteStates.at(-1).uploading===0`,
        );
        assert.equal(
          await js(`window.remoteResults.find(r=>r.id==='capture-${n}').ok`),
          true,
        );
      }
      assert.deepEqual(
        await js("window.remoteStates.at(-1).selected"),
        Array.from({ length: 8 }, (_, n) => `shot-${n + 5}`),
      );
      assert.equal(await js("!!window.lastAsk"), false);
      await wait(
        "document.body.textContent.includes('截图已同步；Cue 回答附最近 8 张')",
      );
      await js("window.holdUpload=true");
      for (let n = 13; n <= 20; n++) await shot(`capture-${n}`);
      await shot("queue-full");
      assert.equal(await js("window.shotCalls"), 20);
      assert.equal(
        await js("window.remoteResults.find(r=>r.id==='queue-full').ok"),
        false,
      );
      await wait("window.remoteStates.at(-1).uploading===8");
      await js("window.holdUpload=false;window.finishUpload()");
      await wait(
        "window.remoteStates.at(-1).uploading===0 && window.remoteStates.at(-1).selected.at(-1)==='shot-20'",
      );
      console.log(
        "PASS continuous capture: 20 originals, no answer, rolling attachments, explicit upload backpressure, no lost queued originals",
      );
    } finally {
      win.destroy();
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

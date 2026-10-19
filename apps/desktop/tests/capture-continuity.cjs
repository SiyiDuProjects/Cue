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
      await wait(
        `window.remoteStates.at(-1).uploads.includes(${JSON.stringify(id)}) || window.savedImages?.includes(${JSON.stringify(id)})`,
      );
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
          `window.remoteStates.at(-1).selected.includes('capture-${n}') && window.remoteStates.at(-1).uploading===0`,
        );
        assert.equal(
          await js(`window.savedImages.includes('capture-${n}')`),
          true,
        );
      }
      assert.deepEqual(
        await js("window.remoteStates.at(-1).selected"),
        Array.from({ length: 8 }, (_, n) => `capture-${n + 5}`),
      );
      assert.equal(await js("!!window.lastAsk"), false);
      await wait(
        "document.body.textContent.includes('截图已同步；Cue 回答附最近 8 张')",
      );
      await js("window.holdUpload=true");
      for (let n = 13; n <= 24; n++) await shot(`capture-${n}`);
      assert.equal(await js("window.shotCalls"), 24);
      await wait("window.remoteStates.at(-1).uploading===12");
      await js("window.holdUpload=false;window.finishUpload()");
      await wait(
        "window.remoteStates.at(-1).uploading===0 && window.remoteStates.at(-1).selected.at(-1)==='capture-24'",
      );
      console.log(
        "PASS continuous capture: 24 originals, no answer, rolling attachments, twelve pending uploads, no lost queued originals",
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

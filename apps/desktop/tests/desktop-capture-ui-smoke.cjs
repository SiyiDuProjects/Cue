// Runs the actual desktop entry/preload against the loopback synthetic Site.
// Start apps/cloud/scripts/preview.mjs first. No real credentials or media.
const { app, BrowserWindow, dialog, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sage-desktop-smoke-"));
os.tmpdir = () => temp;
Object.assign(process.env, {
  INTERVIEW_API_BASE_URL: "http://127.0.0.1:4178",
  INTERVIEW_ACCESS_TOKEN: JSON.stringify({ site: "synthetic", device: "synthetic" }),
  INTERVIEW_CODEX_BIN: "",
  INTERVIEW_CODEX_WORKSPACE: temp,
  INTERVIEW_MATERIALS_WORKSPACE: temp,
});
app.disableHardwareAcceleration();
const timeout = setTimeout(() => app.exit(1), 30000);
dialog.showErrorBox = (title, message) => {
  console.error(title, message);
  app.exit(1);
};
app.on("browser-window-created", (_event, win) => {
  let permissions = 0;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    permissions++;
    callback(false);
  });
  win.webContents.once("did-finish-load", async () => {
    try {
      const run = (code) => win.webContents.executeJavaScript(code);
      const wait = async (code) => {
        for (let i = 0; i < 200; i++) {
          if (await run(code)) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw Error("Desktop UI did not become ready");
      };
      await wait("document.body.textContent.includes('已连接。')");
      assert.equal(await run("!!window.sageCaptureHost && !!window.sageCapture"), true);
      assert.equal(await run("Object.values(window.sageCaptureHost).includes('synthetic')"), false);
      assert.equal(await run("!!document.querySelector('textarea')"), false);
      const before = await fetch("http://127.0.0.1:4178/__test").then((r) => r.json());
      win.webContents.send("sage:answer-requested");
      await wait("document.body.textContent.includes('ChatGPT 已接收')");
      const after = await fetch("http://127.0.0.1:4178/__test").then((r) => r.json());
      assert.equal(after.events, before.events + 1);
      assert.equal(after.models, before.models);
      assert.equal(permissions, 0);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      console.log("PASS real desktop entry: secure preload, connected capture UI, explicit IPC notification, no media/model on startup");
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
require("../electron/main.cjs");

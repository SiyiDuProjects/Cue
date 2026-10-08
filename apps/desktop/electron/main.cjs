const path = require("node:path"),
  fs = require("node:fs"),
  os = require("node:os");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  session,
  safeStorage,
  screen,
  shell,
  Tray,
  globalShortcut,
} = require("electron");
const { loadDesktopEnvironment } = require("./desktop-environment.cjs");
const {
  loadConnection,
  saveConnection,
  validateConnection,
} = require("./desktop-connection.cjs");
const { createScreenCaptureService } = require("./screen-capture.cjs");

const { DESKTOP_WINDOW_OPTIONS } = require("./desktop-window.cjs");
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAALoSURBVFhH1Vc9aFUxFO7o2LH0Vp7g5qRbt5Pm+oMgWoVCQZGCIlIUng7yBJEiguJQHYpCC6KCFGqx1KVdtINi0aUOgkMFUYcnahHpoJ0iX25zSU6S9/IuOvjBN+Xk/CXny71dXf8rst3Un+UkbHKbv4oaUU+vpNOZFAt9uVBRSrGcDVCjRrSN+6iEGlF3ltNYlotfXrD2vIPEuc9kFK0VPwKOk6kTlzTMfbfFVkkjFasOEl3kMaJAcO7AUIwcV2O3J9Tii+fq5ZsVhxPTD9W+Uye9PRZv8lgeNtvuVb5r6Iiaf/ZUpWD100d18MwoD66Ji8xjlsCFCZ05qv69scHjtATs0SnuC8X17qGdPLYGWsQ3gGitja9ra+rBk3k1evWKGjpf15yafaQr5wh1IsvFHI9tqvdaD8LJz/V1XdX4/Xtq+/69no3hscYFnaDB2/erng3odQHiwY2q8sTlS04X+o8OezbQCCcBKFjAqBIxCTZ2HDrg2WS5aJbBoXbcoCoRDCNpgGPjNoblMeBh4YudEEFxEa9NTeq7YuPirXHPvqRRyD5Jg95ihNADBLo791h9+f7NCcaBTvD9NjNJdZ0AxIEvcqJKjFqKHsAGoxs6eycBI89oBV+0ifby1oZg9AFd4j5CxOQVdyAnwRcN4cyeawDJIBA0YXJ2Rh2un/X2pRBvjpmCHr5ouPT6lRM8pbWpxOXfHEQtwx+4Afi52XSC8/WqhOrWiLbYCQTfATuBliPVIb33AKLAjUBbVHAX8DJyG5s4Howpnu6IBBeUNOgkACArbshlFSOGceSvHOy4EEV1QIoVHlsj1oWZxQUniVRgUrivIoFA9QaxV/HcjetJWgCYLkWebfcVDCHLxXRgoz5TTALe+BDwQYKqo2cvxbJz82OAUSwJOxnzNQS2Vb8ieDeP1RLQas9RNeIHpX3lIWiZlmIp4DSF71peuE4ARziW2HejTfw/ljr/L6D/HQaoUfwzOhSdtvoPkf0OHX9hJAwAAAAASUVORK5CYII=";
if (!app.isPackaged) loadDesktopEnvironment();
const dataRoot = app.isPackaged
  ? path.join(app.getPath("appData"), "Sage")
  : path.join(os.tmpdir(), "sage-capture-development");
// Keep the existing profile and saved login across the product rename.
app.setPath("userData", dataRoot);
app.setName("Cue");
let window,
  tray,
  quitting = false,
  credentials,
  origin,
  renderer;
const capture = createScreenCaptureService(desktopCapturer, screen, () =>
  BrowserWindow.getAllWindows(),
);
const allowedPermissions = new Set([
  "media",
  "display-capture",
  "microphone",
  "clipboard-sanitized-write",
]);
function trusted(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url.split("#")[0] !== renderer
  )
    throw Error("拒绝非受信任页面的请求。");
}
function headers() {
  if (!credentials)
    throw Error("请先导入此电脑的 Sites 连接配置。旧配置和资料仍然保留。");
  return {
    "Content-Type": "application/json",
    "OAI-Sites-Authorization": "Bearer " + credentials.site,
    Authorization: "Bearer " + credentials.device,
  };
}
function permitted(endpoint, method) {
  return (
    /^(GET|POST|DELETE)$/.test(method) &&
    /^\/capture\/(state|materials|images(?:\/[a-zA-Z0-9_-]+)?)$/.test(endpoint)
  );
}
async function request(endpoint, method = "GET", body) {
  if (!permitted(endpoint, method)) throw Error("不支持的采集操作。");
  const response = await net.fetch(origin + endpoint, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(18000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.detail || "连接失败，请检查连接配置。");
  return result;
}
async function connect() {
  const response = await net.fetch(origin + "/health", {
    headers: headers(),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  const health = await response.json();
  if (!response.ok || health.capture_protocol !== "cue-chat-v2")
    throw Error("此服务器尚未切换采集版本，请保留已安装的客户端。");
  return { origin };
}
function configure() {
  const handle = (name, fn) =>
    ipcMain.handle(name, (event, ...args) => {
      trusted(event);
      return fn(...args);
    });
  handle("sage:connect", connect);
  handle("sage:import", async () => {
    const selected = await dialog.showOpenDialog(window, {
      title: "导入 Cue 连接配置",
      properties: ["openFile"],
      filters: [{ name: "Cue 连接配置", extensions: ["json"] }],
    });
    if (selected.canceled) return { cancelled: true };
    const file = selected.filePaths[0];
    if (fs.statSync(file).size > 16000) throw Error("连接配置文件过大。");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      [value.site, value.device].some(
        (x) => typeof x !== "string" || !x || /[\r\n]/.test(x),
      )
    )
      throw Error("连接配置无效。");
    const old = path.join(dataRoot, "connection.bin"),
      backup = path.join(dataRoot, "connection-before-sites.bin");
    if (fs.existsSync(old) && !fs.existsSync(backup))
      fs.copyFileSync(old, backup, fs.constants.COPYFILE_EXCL);
    await saveConnection(dataRoot, safeStorage, {
      apiBaseUrl: origin,
      accessToken: JSON.stringify(value),
      materialsWorkspace: process.env.INTERVIEW_MATERIALS_WORKSPACE,
    });
    credentials = value;
    return connect();
  });
  handle("sage:request", request);
  handle("sage:sources", () => capture.listSources());
  handle("sage:select", (id) => capture.selectSource(id));
  handle("sage:screenshot", () => capture.captureSnapshot());
  handle("sage:settings", () => shell.openExternal(origin + "/settings"));
  handle("sage:pin", (value) => {
    window.setAlwaysOnTop(value === true);
    return {};
  });
  handle("sage:materials", async () => {
    const picked = await dialog.showOpenDialog(window, {
      title: "选择要更新的个人资料",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "文本资料", extensions: ["txt", "md"] }],
    });
    if (picked.canceled) return {};
    if (picked.filePaths.length > 20) throw Error("最多选择20份资料。");
    const materials = picked.filePaths.map((file) => {
      if (fs.statSync(file).size > 250000) throw Error("资料过大。");
      return { name: path.basename(file), text: fs.readFileSync(file, "utf8") };
    });
    return request("/capture/materials", "POST", { materials });
  });
  const ses = session.defaultSession;
  const mainFrame = (contents, details) =>
    contents === window?.webContents &&
    details?.isMainFrame !== false &&
    contents?.mainFrame.url.split("#")[0] === renderer;
  ses.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      allowedPermissions.has(permission) && mainFrame(contents, details),
  );
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      allowedPermissions.has(permission) && mainFrame(contents, details),
    ),
  );
  ses.setDisplayMediaRequestHandler(
    async (req, callback) => {
      if (req.frame !== window?.webContents.mainFrame) {
        callback({});
        return;
      }
      try {
        callback({
          video: req.videoRequested
            ? await capture.getAudioCaptureSource()
            : undefined,
          audio: req.audioRequested ? "loopback" : undefined,
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );
  // Only the trusted capture page can open the authenticated capture socket. Tokens never enter its JS.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url);
    if (url.protocol === "wss:" || url.protocol === "ws:") {
      if (
        details.webContentsId === window?.webContents.id &&
        url.origin === "wss://api.openai.com" &&
        url.pathname === "/v1/realtime" &&
        url.search === "?intent=transcription" &&
        !url.hash
      ) {
        // This path uses the scoped ephemeral subprotocol from Sites. Never add
        // device/Sites credentials to an OpenAI request.
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const expected = new URL(origin);
      expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
      if (
        details.webContentsId !== window?.webContents.id ||
        url.origin !== expected.origin ||
        url.pathname !== "/capture/socket" ||
        url.search ||
        url.hash
      ) {
        callback({ cancel: true });
        return;
      }
      try {
        callback({
          requestHeaders: {
            ...details.requestHeaders,
            ...headers(),
            Origin: origin,
          },
        });
      } catch {
        callback({ cancel: true });
      }
      return;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}
async function show() {
  if (!window) {
    const dev =
      !app.isPackaged &&
      process.argv.some((value) =>
        /^--renderer-url=http:\/\/127\.0\.0\.1:5173\/?$/.test(value),
      );
    renderer = dev
      ? "http://127.0.0.1:5173/"
      : pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
    window = new BrowserWindow({
      ...DESKTOP_WINDOW_OPTIONS,
      width: 640,
      height: 780,
      minWidth: 480,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        additionalArguments: ["--sage-origin=" + origin],
      },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== renderer) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", () =>
      dialog.showErrorBox(
        "Cue 采集中断",
        "请重新打开 Cue。没有自动恢复录音或重发请求。",
      ),
    );
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => (window = null));
    await window.loadURL(renderer);
  }
  window.show();
  window.focus();
}
function trigger() {
  if (window && !window.isDestroyed())
    window.webContents.send("sage:answer-requested");
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => void show());
  app
    .whenReady()
    .then(async () => {
      const source = process.argv.find((x) =>
        x.startsWith("--configure-from="),
      );
      if (source) {
        const config = {};
        loadDesktopEnvironment(path.resolve(source.slice(17)), config);
        await saveConnection(dataRoot, safeStorage, {
          apiBaseUrl: config.INTERVIEW_API_BASE_URL,
          accessToken: config.INTERVIEW_ACCESS_TOKEN,
          materialsWorkspace: config.INTERVIEW_MATERIALS_WORKSPACE,
        });
        app.quit();
        return;
      }
      if (app.isPackaged)
        await loadConnection(dataRoot, safeStorage, process.env);
      origin = validateConnection({
        apiBaseUrl:
          process.env.INTERVIEW_API_BASE_URL || "https://interview.siyidu.com",
        accessToken: "origin-validation",
      }).apiBaseUrl;
      try {
        const raw = process.env.INTERVIEW_ACCESS_TOKEN || "";
        credentials = JSON.parse(
          raw.startsWith("{")
            ? raw
            : Buffer.from(raw, "base64").toString("utf8"),
        );
        if (
          [credentials.site, credentials.device].some(
            (x) => typeof x !== "string" || !x || /[\r\n]/.test(x),
          )
        )
          credentials = null;
      } catch {
        credentials = null;
      }
      configure();
      await show();
      tray = new Tray(
        nativeImage
          .createFromDataURL(TRAY_ICON_DATA_URL)
          .resize({ width: 16, height: 16 }),
      );
      tray.setToolTip("Cue");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "回答", click: trigger },
          { label: "打开 Cue", click: () => void show() },
          { type: "separator" },
          { label: "退出", click: () => app.quit() },
        ]),
      );
      tray.on("click", () => void show());
      if (!globalShortcut.register("Control+Alt+Enter", trigger))
        dialog.showErrorBox(
          "快捷键已被占用",
          "仍可使用 Cue 窗口中的回答按钮。",
        );
    })
    .catch(() => {
      dialog.showErrorBox(
        "Cue 无法启动",
        "请检查电脑连接配置，旧配置和个人资料没有删除。",
      );
      app.quit();
    });
}
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    try {
      await window?.webContents.executeJavaScript(
        "window.sageCapture?.audio(false)",
      );
    } catch {}
    globalShortcut.unregisterAll();
    app.quit();
  })();
});

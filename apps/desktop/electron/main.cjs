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
  : path.join(os.tmpdir(), "cue-capture-development");
// Keep the existing profile and saved login across the product rename.
app.setPath("userData", dataRoot);
app.setName("Cue");
let window,
  tray,
  quitting = false,
  credentials,
  origin,
  renderer;
// Overlay placement: the top-center point the user dragged it to. The page
// reports its size and the window grows downward from there.
const overlayFile = path.join(dataRoot, "overlay.json");
let anchor,
  fitting = false;
const EFFORTS = [
  ["", "跟随网页设置"],
  ["low", "快速"],
  ["medium", "均衡"],
  ["high", "深入"],
  ["xhigh", "最深入"],
];
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
    /^\/capture\/(state|materials|remote|images(?:\/[a-zA-Z0-9_-]+)?)$/.test(
      endpoint,
    )
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
  handle("cue:connect", connect);
  handle("cue:import", async () => {
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

    });
    credentials = value;
    return connect();
  });
  handle("cue:request", request);
  handle("cue:sources", () => capture.listSources());
  handle("cue:select", (id) => capture.selectSource(id));
  handle("cue:screenshot", () => capture.captureSnapshot());
  handle("cue:settings", () => shell.openExternal(origin + "/settings"));
  handle("cue:resize", (size) => {
    fit(size);
    return {};
  });
  // Clicks never take focus; typing in the page's text box does.
  handle("cue:focus", (on) => {
    window.setFocusable(on === true);
    if (on === true) window.focus();
    return {};
  });
  // Native, so it is not clipped by the content-sized window.
  handle("cue:menu", async (state) => {
    const sources = await capture.listSources().catch(() => []);
    return new Promise((resolve) => {
      const pick = (value) => () => resolve(value);
      Menu.buildFromTemplate([
        {
          label: "回答深度",
          submenu: EFFORTS.map(([value, label]) => ({
            label,
            type: "radio",
            checked: (state?.effort || "") === value,
            click: pick({ effort: value }),
          })),
        },
        {
          label: "截图来源",
          enabled: sources.length > 0,
          submenu: sources.map((source) => ({
            label: source.name || source.id,
            type: "radio",
            checked: !!source.selected,
            click: pick({ source: source.id }),
          })),
        },
        {
          label: "允许网页遥控",
          type: "checkbox",
          checked: state?.remote !== false,
          click: pick({ remote: state?.remote === false }),
        },
        { type: "separator" },
        {
          label: "网页设置",
          click: () => {
            resolve(null);
            void shell.openExternal(origin + "/settings");
          },
        },
        { label: "连接设置…", click: pick({ action: "connection" }) },
        { type: "separator" },
        {
          label: "隐藏（Ctrl+Alt+\\）",
          click: () => {
            resolve(null);
            window.hide();
          },
        },
        {
          label: "退出 Cue",
          click: () => {
            resolve(null);
            app.quit();
          },
        },
      ]).popup({
        window,
        // A chosen item resolves first; closing without one resolves null.
        callback: () => setTimeout(() => resolve(null), 200),
      });
    });
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
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        additionalArguments: ["--cue-origin=" + origin],
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
    window.on("moved", () => {
      if (fitting) return;
      const bounds = window.getBounds();
      anchor = { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y };
      try {
        fs.mkdirSync(dataRoot, { recursive: true });
        fs.writeFileSync(overlayFile, JSON.stringify(anchor));
      } catch {}
    });
    // Above full-screen apps, on every desktop where the platform allows.
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    fit(window.getBounds());
    await window.loadURL(renderer);
  }
  window.showInactive();
}
/** The saved point if it is still on a display, else top-center of the primary. */
function placeAnchor() {
  try {
    const saved = JSON.parse(fs.readFileSync(overlayFile, "utf8"));
    if (
      screen
        .getAllDisplays()
        .some(
          ({ workArea: a }) =>
            saved.x >= a.x &&
            saved.x < a.x + a.width &&
            saved.y >= a.y &&
            saved.y < a.y + a.height,
        )
    )
      return { x: saved.x, y: saved.y };
  } catch {}
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + Math.round(area.width / 2), y: area.y + 8 };
}
function fit(size) {
  const width = Math.round(size?.width),
    height = Math.round(size?.height);
  if (!window || !(width > 0 && width < 4000 && height > 0 && height < 4000))
    return;
  anchor ??= placeAnchor();
  const area = screen.getDisplayNearestPoint(anchor).workArea;
  const bounds = {
    x: Math.round(anchor.x - width / 2),
    y: anchor.y,
    width,
    height,
  };
  // Near the bottom edge the card grows upward instead of off screen.
  if (bounds.y + height > area.y + area.height)
    bounds.y = Math.max(area.y, area.y + area.height - height);
  fitting = true;
  window.setBounds(bounds);
  fitting = false;
}
function send(name) {
  if (window && !window.isDestroyed()) window.webContents.send(name);
}
function toggle() {
  if (window?.isVisible()) window.hide();
  else void show();
}
/** Answering shows the overlay; capturing leaves it as it is. */
function trigger() {
  void show();
  send("cue:answer-requested");
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
          apiBaseUrl: config.CUE_API_BASE_URL,
          accessToken: config.CUE_ACCESS_TOKEN,

        });
        app.quit();
        return;
      }
      if (app.isPackaged)
        await loadConnection(dataRoot, safeStorage, process.env);
      origin = validateConnection({
        apiBaseUrl:
          process.env.CUE_API_BASE_URL || "https://cue.siyidu.com",
        accessToken: "origin-validation",
      }).apiBaseUrl;
      try {
        const raw = process.env.CUE_ACCESS_TOKEN || "";
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
          { label: "显示或隐藏", click: toggle },
          { label: "回答", click: trigger },
          { label: "截图", click: () => send("cue:shot-requested") },
          { type: "separator" },
          { label: "退出", click: () => app.quit() },
        ]),
      );
      tray.on("click", toggle);
      const taken = [
        ["Control+Alt+Enter", trigger],
        ["Control+Alt+S", () => send("cue:shot-requested")],
        ["Control+Alt+\\", toggle],
      ]
        .filter(([key, action]) => {
          try {
            return !globalShortcut.register(key, action);
          } catch {
            return true;
          }
        })
        .map(([key]) => key);
      if (taken.length)
        dialog.showErrorBox(
          "快捷键已被占用",
          taken.join("、") + "，仍可使用浮窗按钮。",
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
        "window.cueCapture?.audio(false)",
      );
    } catch {}
    globalShortcut.unregisterAll();
    app.quit();
  })();
});

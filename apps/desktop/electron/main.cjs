const path = require("node:path");
const { pathToFileURL } = require("node:url");
const os = require("node:os");
const http = require("node:http");
const nodeNet = require("node:net");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { loadDesktopEnvironment } = require("./desktop-environment.cjs");
const { loadConnection, saveConnection } = require("./desktop-connection.cjs");
const { DESKTOP_WINDOW_OPTIONS } = require("./desktop-window.cjs");
const { createScreenCaptureService } = require("./screen-capture.cjs");
const { createRendererRecovery } = require("./renderer-recovery.cjs");
const { CodexHost } = require("./codex-host.cjs");
const { createRuntimeContext, configArguments } = require("./codex-runtime.cjs");
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net: electronNet,
  nativeImage,
  session,
  safeStorage,
  screen,
  shell,
  Tray,
} = require("electron");

if (!app.isPackaged) loadDesktopEnvironment();

const diagnosticReport = process.argv.find(value => value.startsWith("--diagnose-package="))?.slice("--diagnose-package=".length);
const configurationSource = process.argv.find(value => value.startsWith("--configure-from="))?.slice("--configure-from=".length);

const WINDOW_TITLE = "Sage";
const DEFAULT_API_PORT = 8000;
const DEFAULT_REMOTE_API_BASE_URL = "https://interview.siyidu.com";
const FALLBACK_API_PORTS = [8000, 8001];
const API_START_TIMEOUT_MS = 15000;
const API_HEALTH_MAX_BYTES = 64 * 1024;
const DEV_RENDERER_URL = "http://127.0.0.1:5173/";
// Text copying uses Chromium's write-only clipboard permission. The handlers
// below still restrict every permission to this window's trusted main frame.
const ALLOWED_RENDERER_PERMISSIONS = new Set(["media", "display-capture", "microphone", "clipboard-sanitized-write"]);
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAALoSURBVFhH1Vc9aFUxFO7o2LH0Vp7g5qRbt5Pm+oMgWoVCQZGCIlIUng7yBJEiguJQHYpCC6KCFGqx1KVdtINi0aUOgkMFUYcnahHpoJ0iX25zSU6S9/IuOvjBN+Xk/CXny71dXf8rst3Un+UkbHKbv4oaUU+vpNOZFAt9uVBRSrGcDVCjRrSN+6iEGlF3ltNYlotfXrD2vIPEuc9kFK0VPwKOk6kTlzTMfbfFVkkjFasOEl3kMaJAcO7AUIwcV2O3J9Tii+fq5ZsVhxPTD9W+Uye9PRZv8lgeNtvuVb5r6Iiaf/ZUpWD100d18MwoD66Ji8xjlsCFCZ05qv69scHjtATs0SnuC8X17qGdPLYGWsQ3gGitja9ra+rBk3k1evWKGjpf15yafaQr5wh1IsvFHI9tqvdaD8LJz/V1XdX4/Xtq+/69no3hscYFnaDB2/erng3odQHiwY2q8sTlS04X+o8OezbQCCcBKFjAqBIxCTZ2HDrg2WS5aJbBoXbcoCoRDCNpgGPjNoblMeBh4YudEEFxEa9NTeq7YuPirXHPvqRRyD5Jg95ihNADBLo791h9+f7NCcaBTvD9NjNJdZ0AxIEvcqJKjFqKHsAGoxs6eycBI89oBV+0ifby1oZg9AFd4j5CxOQVdyAnwRcN4cyeawDJIBA0YXJ2Rh2un/X2pRBvjpmCHr5ouPT6lRM8pbWpxOXfHEQtwx+4Afi52XSC8/WqhOrWiLbYCQTfATuBliPVIb33AKLAjUBbVHAX8DJyG5s4Howpnu6IBBeUNOgkACArbshlFSOGceSvHOy4EEV1QIoVHlsj1oWZxQUniVRgUrivIoFA9QaxV/HcjetJWgCYLkWebfcVDCHLxXRgoz5TTALe+BDwQYKqo2cvxbJz82OAUSwJOxnzNQS2Vb8ieDeP1RLQas9RNeIHpX3lIWiZlmIp4DSF71peuE4ARziW2HejTfw/ljr/L6D/HQaoUfwzOhSdtvoPkf0OHX9hJAwAAAAASUVORK5CYII=";

const writableRoot = diagnosticReport ? path.join(path.dirname(path.resolve(diagnosticReport)), "package-profile")
  : app.isPackaged ? path.join(app.getPath("appData"), "Sage") : path.join(os.tmpdir(), "interview-copilot-electron");
let apiProcess = null;
let apiPort = DEFAULT_API_PORT;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let trustedRendererUrl = "";
const screenCapture = createScreenCaptureService(desktopCapturer, screen, () => BrowserWindow.getAllWindows());
const rendererRecovery = createRendererRecovery();
let rendererRecoveryTimer = null;
let startupStage = "connection";
let codexHost = null;
let codexLogin = null;
let codexRuntimeContext = null;

function isLoopbackHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function validatedApiUrl(value) {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("API 地址不能包含用户名或密码。");
  }
  if (isLoopbackHostname(url.hostname)) {
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("本地 API 地址必须使用 http 或 https。");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("远程 API 地址必须使用 https。");
  }
  return url;
}

function configuredApiBaseUrl() {
  const value = (
    process.env.INTERVIEW_API_BASE_URL ||
    process.env.VITE_API_BASE_URL ||
    DEFAULT_REMOTE_API_BASE_URL
  ).trim();
  return validatedApiUrl(value).toString();
}

function resolveApiEndpoint(apiBaseUrl, pathname) {
  const requestedUrl = validatedApiUrl(apiBaseUrl || configuredApiBaseUrl());
  const configuredUrl = validatedApiUrl(configuredApiBaseUrl());
  if (requestedUrl.origin !== configuredUrl.origin) {
    throw new Error("拒绝向未配置的 API 地址转发桌面端凭据。");
  }

  return new URL(pathname, `${requestedUrl.origin}/`).toString();
}

function buildApiHeaders() {
  const headers = { Accept: "application/json" };
  const accessToken = process.env.INTERVIEW_ACCESS_TOKEN?.trim();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

async function readApiError(response) {
  try {
    const payload = await response.json();
    return payload.detail || payload.error || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

function configureIpcHandlers() {
  ipcMain.handle("conversation:request", async (event, apiBaseUrl, payload) => {
    assertTrustedIpcSender(event);
    const { action, current_id, session_token, target_id, stop_active, title } = payload || {};
    if (!["list", "switch", "rename"].includes(action) || typeof current_id !== "string" ||
        typeof session_token !== "string" || !session_token) throw Error("无效会话操作。");
    const endpoint = action === "list" ? "/api/conversations" : action === "switch" ? "/api/conversations/switch"
      : `/api/conversations/${encodeURIComponent(current_id)}`;
    const response = await electronNet.fetch(resolveApiEndpoint(apiBaseUrl, endpoint), {
      method: action === "list" ? "GET" : action === "switch" ? "POST" : "PATCH",
      redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${session_token}`, "Content-Type": "application/json" },
      ...(action !== "list" ? { body: JSON.stringify({ current_id, target_id, stop_active, title }) } : {}),
    });
    if (!response.ok) throw Error(await readApiError(response));
    return response.json();
  });
  ipcMain.handle("window:state", (event) => {
    assertTrustedIpcSender(event);
    return { recoveryNotice: rendererRecovery.getNotice() };
  });
  ipcMain.handle("screen:list-sources", async (event) => {
    assertTrustedIpcSender(event);
    return screenCapture.listSources();
  });
  ipcMain.handle("screen:select-source", async (event, sourceId) => {
    assertTrustedIpcSender(event);
    return screenCapture.selectSource(sourceId);
  });
  ipcMain.handle("screen:capture", async (event) => {
    assertTrustedIpcSender(event);
    return screenCapture.captureSnapshot();
  });
  ipcMain.handle("interview:create", async (event, apiBaseUrl) => {
    assertTrustedIpcSender(event);
    const response = await electronNet.fetch(resolveApiEndpoint(apiBaseUrl, "/api/interviews"), {
      method: "POST",
      headers: {
        ...buildApiHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_name: os.hostname().slice(0, 80) || "我的电脑" }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const payload = await response.json();
    if (
      typeof payload.interview_id !== "string" ||
      typeof payload.session_token !== "string" ||
      typeof payload.capture_token !== "string"
    ) {
      throw new Error("创建面试返回了无效会话。");
    }
    if (codexHost?.closed || codexHost?.interviewId !== payload.interview_id || codexHost?.token !== payload.capture_token) {
      await codexHost?.close();
      codexHost = new CodexHost({ apiBaseUrl: configuredApiBaseUrl(),
        interviewId: payload.interview_id, captureToken: payload.capture_token,
        packaged: app.isPackaged, dataRoot: writableRoot, runtimeContext: codexRuntimeContext });
    }
    return {
      interview_id: payload.interview_id,
      session_token: payload.session_token,
      capture_token: payload.capture_token,
    };
  });

  ipcMain.handle("interview:end", async (event, apiBaseUrl, interviewId, sessionToken) => {
    assertTrustedIpcSender(event);
    if (typeof interviewId !== "string" || !interviewId.trim()) {
      throw new Error("缺少面试会话 ID。");
    }
    if (typeof sessionToken !== "string" || !sessionToken.trim()) {
      throw new Error("缺少面试会话令牌。");
    }

    const response = await electronNet.fetch(
      resolveApiEndpoint(apiBaseUrl, `/api/interviews/${encodeURIComponent(interviewId)}`),
      {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(await readApiError(response));
    }
    if (codexHost?.interviewId === interviewId) { await codexHost.close(); codexHost = null; }
    return { ok: true };
  });

  ipcMain.handle("capture:initialize", async (event) => {
    assertTrustedIpcSender(event);
    if (diagnosticReport) return;
    await event.senderFrame.executeJavaScript(
      "window.dispatchEvent(new Event('sage:capture-initialize'))",
      true,
    );
  });
}

function configuredApiBaseUrlSource() {
  if (process.env.INTERVIEW_API_BASE_URL?.trim()) {
    return "INTERVIEW_API_BASE_URL";
  }
  if (process.env.VITE_API_BASE_URL?.trim()) {
    return "VITE_API_BASE_URL";
  }
  return "default";
}

function isLocalApiUrl(value) {
  if (!value) {
    return false;
  }
  try {
    const url = validatedApiUrl(value);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isRemoteApiUrl(value) {
  if (!value) {
    return false;
  }
  try {
    const url = validatedApiUrl(value);
    return Boolean(url.hostname && !isLoopbackHostname(url.hostname));
  } catch {
    return false;
  }
}

function configuredApiPort() {
  const configuredUrl = configuredLocalApiBaseUrl() || configuredApiBaseUrl();
  const match = configuredUrl.match(/127\.0\.0\.1:(\d+)|localhost:(\d+)/);
  if (match) {
    return Number(match[1] || match[2]);
  }
  const configuredPort = Number(process.env.INTERVIEW_API_PORT || "");
  return Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : null;
}

function configuredLocalApiBaseUrl() {
  const explicitUrl = (process.env.INTERVIEW_API_BASE_URL || "").trim();
  return isLocalApiUrl(explicitUrl) ? explicitUrl : "";
}

app.setPath("userData", writableRoot);
app.commandLine.appendSwitch("disk-cache-dir", path.join(writableRoot, "cache"));
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

function getRendererUrl() {
  if (app.isPackaged) {
    return "";
  }

  const arg = process.argv.find((value) => value.startsWith("--renderer-url="));
  if (!arg) {
    return "";
  }

  try {
    const candidate = new URL(arg.slice("--renderer-url=".length));
    if (
      candidate.href === DEV_RENDERER_URL &&
      !candidate.username &&
      !candidate.password
    ) {
      return candidate.href;
    }
  } catch {
    // Invalid renderer URLs are rejected below.
  }
  throw new Error(`拒绝加载非受信任的 renderer URL；开发地址必须是 ${DEV_RENDERER_URL}`);
}

function packagedRendererUrl() {
  return pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
}

function isTrustedRendererUrl(value) {
  if (typeof value !== "string" || !value || !trustedRendererUrl) {
    return false;
  }

  try {
    const candidate = new URL(value);
    const trusted = new URL(trustedRendererUrl);
    candidate.hash = "";
    trusted.hash = "";
    return candidate.href === trusted.href;
  } catch {
    return false;
  }
}

function isTrustedMainFrame(webContents, frame, fallbackUrl = "") {
  return Boolean(
    mainWindow &&
      !mainWindow.isDestroyed() &&
      webContents === mainWindow.webContents &&
      frame === mainWindow.webContents.mainFrame &&
      isTrustedRendererUrl(frame?.url || fallbackUrl || webContents?.getURL()),
  );
}

function assertTrustedIpcSender(event) {
  if (!isTrustedMainFrame(event.sender, event.senderFrame)) {
    throw new Error("拒绝来自非受信任页面的桌面端请求。");
  }
}

function readApiHealth(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
      let body = "";
      let bodyBytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        bodyBytes += Buffer.byteLength(chunk, "utf8");
        if (bodyBytes > API_HEALTH_MAX_BYTES) {
          response.destroy();
          finish(null);
          return;
        }
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          finish(null);
          return;
        }
        try {
          finish(JSON.parse(body));
        } catch {
          finish(null);
        }
      });
      response.on("error", () => finish(null));
    });
    request.on("error", () => finish(null));
    request.setTimeout(1200, () => {
      request.destroy();
      finish(null);
    });
  });
}

async function isApiCompatible(port) {
  const health = await readApiHealth(port);
  return health?.status === "ok" && health?.realtime_protocol === "realtime-interview-v5" && health?.code_plan === true;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForApiReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isApiCompatible(apiPort)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function ensureApiServer() {
  const configuredUrl = configuredApiBaseUrl();
  const configuredSource = configuredApiBaseUrlSource();
  const localApiUrl = configuredLocalApiBaseUrl();
  if (!localApiUrl) {
    process.env.INTERVIEW_API_BASE_URL = isRemoteApiUrl(configuredUrl) ? configuredUrl : DEFAULT_REMOTE_API_BASE_URL;
    process.env.VITE_API_BASE_URL = process.env.INTERVIEW_API_BASE_URL;
    process.env.INTERVIEW_LOCAL_API_ENABLED = "0";
    console.log("[desktop] using remote api", {
      baseUrl: process.env.INTERVIEW_API_BASE_URL,
      source: configuredSource,
    });
    return;
  }

  console.log("[desktop] using local api", {
    baseUrl: localApiUrl,
    source: "INTERVIEW_API_BASE_URL",
  });
  process.env.INTERVIEW_LOCAL_API_ENABLED = "1";

  const candidatePorts = [configuredApiPort(), ...FALLBACK_API_PORTS].filter(
    (port, index, ports) => typeof port === "number" && ports.indexOf(port) === index,
  );

  for (const port of candidatePorts) {
    if (await isApiCompatible(port)) {
      apiPort = port;
      process.env.INTERVIEW_API_BASE_URL = `http://127.0.0.1:${apiPort}`;
      return;
    }
  }

  apiPort = await findFreePort();
  process.env.INTERVIEW_API_BASE_URL = `http://127.0.0.1:${apiPort}`;

  const serverDir = path.join(__dirname, "..", "..", "server");
  const localPython =
    process.platform === "win32"
      ? path.join(serverDir, ".venv", "Scripts", "python.exe")
      : path.join(serverDir, ".venv", "bin", "python");
  const pythonCommand =
    process.env.INTERVIEW_PYTHON ||
    (fs.existsSync(localPython) ? localPython : process.platform === "win32" ? "python" : "python3");

  apiProcess = spawn(
    pythonCommand,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(apiPort)],
    {
      cwd: serverDir,
      stdio: "pipe",
      windowsHide: true,
    },
  );

  apiProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[desktop-api] ${chunk}`);
  });
  apiProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[desktop-api] ${chunk}`);
  });
  apiProcess.on("error", (error) => {
    console.error("[desktop] failed to start local api", error);
  });
  apiProcess.on("exit", (code, signal) => {
    console.error("[desktop] local api exited", { code, signal });
    apiProcess = null;
  });

  const ready = await waitForApiReady(API_START_TIMEOUT_MS);
  if (!ready) {
    console.error("[desktop] local api did not become healthy in time");
  }
}

async function configureSession() {
  const ses = session.defaultSession;

  if (diagnosticReport) {
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
    return;
  }

  ses.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    const frame = webContents?.mainFrame;
    return Boolean(
      ALLOWED_RENDERER_PERMISSIONS.has(permission) &&
        details?.isMainFrame !== false &&
        isTrustedMainFrame(webContents, frame, details?.requestingUrl),
    );
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const frame = webContents?.mainFrame;
    callback(
      Boolean(
        ALLOWED_RENDERER_PERMISSIONS.has(permission) &&
          details?.isMainFrame !== false &&
          isTrustedMainFrame(webContents, frame, details?.requestingUrl),
      ),
    );
  });

  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isTrustedMainFrame(mainWindow?.webContents, request.frame)) {
        callback({});
        return;
      }

      try {
        const source = await screenCapture.getAudioCaptureSource();
        callback({
          video: request.videoRequested ? source : undefined,
          audio: request.audioRequested ? "loopback" : undefined,
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

function stopApiServer() {
  const processToStop = apiProcess;
  apiProcess = null;
  if (processToStop && !processToStop.killed) {
    processToStop.kill();
  }
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

async function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createMainWindow();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) {
    return;
  }

  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  if (icon.isEmpty()) {
    throw new Error("无法创建系统托盘图标。");
  }

  tray = new Tray(icon.resize({ width: 16, height: 16, quality: "best" }));
  tray.setToolTip(`${WINDOW_TITLE} 面试助手`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `显示 ${WINDOW_TITLE}`,
        click: () => void showMainWindow(),
      },
      {
        label: `隐藏 ${WINDOW_TITLE}`,
        click: hideMainWindow,
      },
      {
        label: "面试资料目录",
        click: () => {
          try {
            void shell.openPath(codexRuntimeContext.workspace);
          } catch (error) { dialog.showErrorBox("无法打开资料目录", error.message); }
        },
      },
      {
        label: "Codex 登录",
        click: () => {
          if (codexLogin) return;
          try {
            const runtime = codexRuntimeContext.options();
            // CLI owns its browser login and credential storage. No auth values
            // enter React, the relay server, logs or our connection config.
            codexLogin = spawn(runtime.binary, [...configArguments(), "login"], {
              cwd: runtime.workspace, env: runtime.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
            });
            codexLogin.stdout.on("data", () => {});
            codexLogin.stderr.on("data", () => {});
            codexLogin.on("error", () => { codexLogin = null; dialog.showErrorBox("Codex 登录失败", "无法启动 CLI，请检查安装和路径。"); });
            codexLogin.on("exit", code => {
              codexLogin = null;
              if (!isQuitting) void dialog.showMessageBox({ type: code === 0 ? "info" : "error",
                title: "Codex 登录", message: code === 0 ? "登录完成，可以回到 Sage 发送消息。" : "登录未完成，请重试或使用项目的登录脚本。" });
            });
          } catch (error) { dialog.showErrorBox("Codex 登录失败", error.message); }
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => app.quit(),
      },
    ]),
  );
  tray.on("click", () => void showMainWindow());
}

async function createMainWindow() {
  const preloadPath = path.join(__dirname, "preload.cjs");
  const rendererUrl = getRendererUrl();
  trustedRendererUrl = rendererUrl || packagedRendererUrl();

  mainWindow = new BrowserWindow({
    ...DESKTOP_WINDOW_OPTIONS,
    autoHideMenuBar: true,
    title: WINDOW_TITLE,
    webPreferences: {
      preload: preloadPath,
      additionalArguments: [`--interview-api-base-url=${configuredApiBaseUrl()}`],
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (!diagnosticReport) mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === "https:") {
        void shell.openExternal(url);
      }
    } catch {
      // Always deny malformed and non-HTTPS external URLs.
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[desktop] renderer load failed", {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[desktop] renderer process gone", details);
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    const recovery = rendererRecovery.recordCrash();
    if (!recovery.retry) {
      mainWindow.show();
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Sage 需要重新打开",
        message: recovery.notice,
        buttons: ["知道了"],
      });
      return;
    }
    const recoveringWindow = mainWindow;
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null;
      if (isQuitting || mainWindow !== recoveringWindow || recoveringWindow.isDestroyed()) return;
      recoveringWindow.show();
      recoveringWindow.webContents.reload();
    }, 750);
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error("[desktop] renderer console", {
        level,
        message,
        line,
        sourceId,
      });
    }
  });

  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      void showMainWindow();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("com.siyidu.sage");
    if (configurationSource) {
      const settings = {};
      loadDesktopEnvironment(path.resolve(configurationSource), settings);
      await saveConnection(writableRoot, safeStorage, { apiBaseUrl: settings.INTERVIEW_API_BASE_URL, accessToken: settings.INTERVIEW_ACCESS_TOKEN,
        codexWorkspace: settings.INTERVIEW_CODEX_WORKSPACE, codexBin: settings.INTERVIEW_CODEX_BIN });
      // Chromium must flush its OS-protected encryption key before shutdown.
      app.quit();
      return;
    }
    // Keep the saved configuration in an ordinary object before passing it to
    // long-lived consumers; process.env is only used for the existing API path.
    const desktopEnvironment = { ...process.env };
    const configured = app.isPackaged && !diagnosticReport && await loadConnection(writableRoot, safeStorage, desktopEnvironment);
    for (const key of ["INTERVIEW_API_BASE_URL", "INTERVIEW_ACCESS_TOKEN", "INTERVIEW_CODEX_WORKSPACE", "INTERVIEW_CODEX_BIN"]) {
      if (desktopEnvironment[key] !== undefined) process.env[key] = desktopEnvironment[key];
    }
    codexRuntimeContext = createRuntimeContext({ packaged: app.isPackaged, dataRoot: writableRoot, environment: desktopEnvironment });
    startupStage = "server";
    await ensureApiServer();
    configureIpcHandlers();
    await configureSession();
    if (!diagnosticReport) createTray();
    startupStage = "window";
    await createMainWindow();
    if (diagnosticReport) {
      startupStage = "renderer";
      await require("./package-diagnostics.cjs").checkPackagedWindow(mainWindow, path.resolve(diagnosticReport), app, configured);
      return;
    }

    app.on("activate", () => {
      void showMainWindow();
    });
  }).catch(() => {
    if (diagnosticReport) fs.writeFileSync(path.resolve(diagnosticReport), JSON.stringify({ success: false, stage: startupStage }));
    if (!diagnosticReport && !configurationSource) dialog.showErrorBox("Sage 无法启动", "请检查电脑连接配置，或重新安装 Sage。");
    app.exit(1);
  });
}

app.on("before-quit", event => {
  isQuitting = true;
  codexLogin?.kill();
  if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
  rendererRecoveryTimer = null;
  if (codexHost) {
    event.preventDefault();
    const host = codexHost; codexHost = null;
    void host.close().finally(() => { stopApiServer(); app.quit(); });
  } else stopApiServer();
});

app.on("window-all-closed", () => {
  // The capture host stays alive in the tray and can recreate its shared UI.
});

app.on("will-quit", () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

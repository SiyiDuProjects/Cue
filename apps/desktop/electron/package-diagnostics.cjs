// A packaged-app startup check. It does not initialize capture, call a server,
// show a window, or expose credentials. It loads the real renderer and preload.
const fs = require("node:fs");

async function checkPackagedWindow(window, reportPath, app, configured) {
  const deadline = Date.now() + 10_000;
  let renderer;
  while (Date.now() < deadline) {
    renderer = await window.webContents.executeJavaScript(`({
      ready: !!document.querySelector('.preview-conversation'),
      bridge: typeof window.interviewDesktop?.captureScreenSnapshot === 'function',
      captureHost: window.interviewDesktop?.captureHost === true,
      chatOnly: !document.querySelector('.preview-workspace, [aria-label="代码区"], [aria-label="代码历史"]'),
      origin: window.interviewDesktop?.apiBaseUrl,
      title: document.title,
      assets: [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(e => e.src || e.href)
    })`);
    if (renderer.ready && renderer.bridge) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const nativeWindow = { resizable: window.isResizable(), minimizable: window.isMinimizable(),
    maximizable: window.isMaximizable(), alwaysOnTop: window.isAlwaysOnTop(),
    bounds: window.getBounds(), contentBounds: window.getContentBounds() };
  const success = app.isPackaged && renderer?.ready && renderer.bridge && renderer.captureHost && renderer.chatOnly
    && nativeWindow.resizable && nativeWindow.minimizable && nativeWindow.maximizable
    && !nativeWindow.alwaysOnTop && nativeWindow.contentBounds.height < nativeWindow.bounds.height;
  fs.writeFileSync(reportPath, JSON.stringify({ success, packaged: app.isPackaged, version: app.getVersion(),
    connectionConfigured: configured, renderer, nativeWindow, mediaAcquired: false, networkRequestsAllowed: false }, null, 2));
  app.exit(success ? 0 : 1);
}

module.exports = { checkPackagedWindow };

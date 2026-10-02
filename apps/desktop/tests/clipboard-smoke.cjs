// Real Electron clipboard and shared React copy button. No provider, audio or screen capture.
const { app, BrowserWindow, clipboard, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const output = path.resolve(root, '../../artifacts/answer-quality-2026-09-28/clipboard');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
let win;
const marker = '# Sage clipboard regression\nprint("复制成功")\n';
const nativeText = () => clipboard.readText().replace(/\r\n/g, '\n');

app.whenReady().then(async () => {
  let previous;
  try {
    const page = path.join(output, 'copy.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Sage copy check</title><div id="root"></div>');
    win = new BrowserWindow({ show: false, width: 520, height: 160,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
    // Execute production permission logic rather than reproduce its whitelist in the fixture.
    const whitelist = source.match(/const ALLOWED_RENDERER_PERMISSIONS = new Set\([^;]+;/)?.[0];
    const trust = source.slice(source.indexOf('function isTrustedRendererUrl('), source.indexOf('function assertTrustedIpcSender('));
    const configure = source.slice(source.indexOf('async function configureSession('), source.indexOf('function stopApiServer('));
    assert(whitelist && trust && configure.includes('setPermissionRequestHandler'));
    const handlers = {};
    const facade = {
      setPermissionCheckHandler(fn) { handlers.check = fn; session.defaultSession.setPermissionCheckHandler(fn); },
      setPermissionRequestHandler(fn) { handlers.request = fn; session.defaultSession.setPermissionRequestHandler(fn); },
      setDisplayMediaRequestHandler() {}, // No media APIs are called by this test.
    };
    const context = vm.createContext({ URL, mainWindow: win, trustedRendererUrl: pathToFileURL(page).href,
      diagnosticReport: null, session: { defaultSession: facade }, screenCapture: {} });
    vm.runInContext(whitelist + '\n' + trust + '\n' + configure, context);
    await vm.runInContext('configureSession()', context);
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file:') }));
    await win.loadFile(page);
    const bundle = buildSync({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CopyTextButton } from './src/AnswerMarkdown';
      createRoot(document.getElementById('root')).render(<CopyTextButton text={${JSON.stringify(marker)}} label="复制代码" />);
    `, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
    await win.webContents.executeJavaScript(bundle);
    // Chromium requires a focused document for its clipboard API, even with permission.
    win.show();
    win.focus();
    win.webContents.focus();
    const press = () => win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      for (let n = 0; n < 100 && !document.hasFocus(); n++) await wait(10);
      if (!document.hasFocus()) throw Error('Clipboard fixture must be focused');
      for (let n = 0; n < 300 && document.querySelector('button')?.textContent !== '复制代码'; n++) await wait(10);
      if (document.querySelector('button')?.textContent !== '复制代码') throw Error('Copy button not ready');
      document.querySelector('button').click();
      for (let n = 0; n < 100; n++) {
        const label = document.querySelector('button').textContent;
        if (label.includes('已复制') || label.includes('复制失败')) return label;
        await wait(10);
      }
      throw Error('Copy button did not settle');
    })()`, true);
    // Reproduce the old denial before allowing the permission through the same handlers.
    vm.runInContext('ALLOWED_RENDERER_PERMISSIONS.delete("clipboard-sanitized-write")', context);
    assert.match(await press(), /复制失败/);
    vm.runInContext('ALLOWED_RENDERER_PERMISSIONS.add("clipboard-sanitized-write")', context);
    assert.equal(handlers.check(win.webContents, 'clipboard-sanitized-write', '', { isMainFrame: false }), false);
    assert.equal(handlers.check(null, 'clipboard-sanitized-write', '', {}), false);
    assert.equal(handlers.check(win.webContents, 'clipboard-read', '', { isMainFrame: true }), false);
    // Keep the user's clipboard entirely in memory and restore all available formats.
    previous = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
    const copied = await press();
    if (!copied.includes('已复制')) {
      const reason = await win.webContents.executeJavaScript(`(async () => {
        try { await navigator.clipboard.writeText(${JSON.stringify(marker)}); return 'Direct write worked'; }
        catch(e) { return e.name + ': ' + e.message + '; focused=' + document.hasFocus(); }
      })()`, true);
      throw Error('Copy button failed: ' + reason);
    }
    assert.equal(nativeText(), marker); // Windows uses CRLF in CF_UNICODETEXT.
    const report = { oldPermissionDenied: true, realCopyButton: true, nativeClipboardText: true,
      iframeDenied: true, foreignWindowDenied: true, clipboardReadDenied: true, models: false, capture: false };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('CLIPBOARD_SMOKE_OK', JSON.stringify(report));
  } catch (e) {
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    if (previous && nativeText() === marker) {
      clipboard.clear();
      for (const [format, buffer] of previous) clipboard.writeBuffer(format, buffer);
      for (const [format, buffer] of previous) assert(clipboard.readBuffer(format).equals(buffer), 'Clipboard restoration failed');
    }
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(process.exitCode || 0);
  }
});

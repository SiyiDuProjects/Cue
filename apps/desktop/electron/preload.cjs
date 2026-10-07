const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("sageCaptureHost", {
  origin: process.argv.find((x) => x.startsWith("--sage-origin="))?.slice(14),
  connect: () => ipcRenderer.invoke("sage:connect"),
  importConnection: () => ipcRenderer.invoke("sage:import"),
  request: (path, method, body) =>
    ipcRenderer.invoke("sage:request", path, method, body),
  sources: () => ipcRenderer.invoke("sage:sources"),
  selectSource: (id) => ipcRenderer.invoke("sage:select", id),
  screenshot: () => ipcRenderer.invoke("sage:screenshot"),
  startAnswer: (body) => ipcRenderer.invoke("sage:answer", body),
});
ipcRenderer.on("sage:answer-requested", () =>
  window.dispatchEvent(new Event("sage:answer-requested")),
);

const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cueCaptureHost", {
  origin: process.argv.find((x) => x.startsWith("--cue-origin="))?.slice("--cue-origin=".length),
  connect: () => ipcRenderer.invoke("cue:connect"),
  importConnection: () => ipcRenderer.invoke("cue:import"),
  request: (path, method, body) =>
    ipcRenderer.invoke("cue:request", path, method, body),
  sources: () => ipcRenderer.invoke("cue:sources"),
  selectSource: (id) => ipcRenderer.invoke("cue:select", id),
  screenshot: () => ipcRenderer.invoke("cue:screenshot"),
  openSettings: () => ipcRenderer.invoke("cue:settings"),
  resize: (size) => ipcRenderer.invoke("cue:resize", size),
  focus: (on) => ipcRenderer.invoke("cue:focus", on),
  menu: (state) => ipcRenderer.invoke("cue:menu", state),
});
for (const name of ["cue:answer-requested", "cue:shot-requested"])
  ipcRenderer.on(name, () => window.dispatchEvent(new Event(name)));

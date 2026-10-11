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
  openSettings: () => ipcRenderer.invoke("sage:settings"),
  uploadMaterials: () => ipcRenderer.invoke("sage:materials"),
  resize: (size) => ipcRenderer.invoke("sage:resize", size),
  focus: (on) => ipcRenderer.invoke("sage:focus", on),
  menu: (state) => ipcRenderer.invoke("sage:menu", state),
});
for (const name of ["sage:answer-requested", "sage:shot-requested"])
  ipcRenderer.on(name, () => window.dispatchEvent(new Event(name)));

const { contextBridge, ipcRenderer } = require("electron");

const apiBaseArgument = process.argv.find((value) =>
  value.startsWith("--interview-api-base-url="),
);
const apiBaseUrl = apiBaseArgument?.slice("--interview-api-base-url=".length) || "";

contextBridge.exposeInMainWorld("interviewDesktop", {
  isElectron: true,
  captureHost: true,
  platform: process.platform,
  apiBaseUrl,
  getWindowState: () => ipcRenderer.invoke("window:state"),
  listScreenSources: () => ipcRenderer.invoke("screen:list-sources"),
  selectScreenSource: (sourceId) => ipcRenderer.invoke("screen:select-source", sourceId),
  captureScreenSnapshot: () => ipcRenderer.invoke("screen:capture"),
  createInterview: (apiBaseUrl) => ipcRenderer.invoke("interview:create", apiBaseUrl),
  conversationRequest: (apiBaseUrl, payload) => ipcRenderer.invoke("conversation:request", apiBaseUrl, payload),
  endInterview: (apiBaseUrl, interviewId, sessionToken) =>
    ipcRenderer.invoke("interview:end", apiBaseUrl, interviewId, sessionToken),
  requestCaptureInitialization: () => ipcRenderer.invoke("capture:initialize"),
});

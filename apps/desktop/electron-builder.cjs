const path = require("node:path");

module.exports = {
  appId: "com.siyidu.sage",
  productName: "Cue",
  directories: { output: path.resolve(__dirname, "../../releases/windows"), buildResources: path.join(__dirname, "assets") },
  electronVersion: require("electron/package.json").version,
  ...(process.platform === "win32" ? {electronDist: path.dirname(require("electron"))} : {}),
  asar: true,
  toolsets: { nsis: "1.2.1" },
  npmRebuild: false,
  files: ["package.json", "VAD-LICENSE.txt", "electron/*.cjs", "dist/**/*", "!node_modules{,/**/*}"],
  win: { ...(process.platform === "win32" ? {} : {signAndEditExecutable:false}), target: [{ target: "nsis", arch: ["x64"] }], executableName: "Cue", icon: path.join(__dirname, "assets/sage.ico"), requestedExecutionLevel: "asInvoker" },
  nsis: {
    artifactName: "Cue-Setup-${version}.exe",
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    runAfterFinish: false,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    shortcutName: "Cue",
    deleteAppDataOnUninstall: false,
  },
  publish: null,
};

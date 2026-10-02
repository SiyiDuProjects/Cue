const path = require("node:path");

module.exports = {
  appId: "com.siyidu.sage",
  productName: "Sage",
  directories: { output: path.resolve(__dirname, "../../releases/windows"), buildResources: path.join(__dirname, "assets") },
  electronVersion: require("electron/package.json").version,
  electronDist: path.dirname(require("electron")),
  asar: true,
  npmRebuild: false,
  files: ["package.json", "electron/*.cjs", "codex-workspace/*.md", "codex-workspace/guides/*.md", "dist/**/*", "!node_modules{,/**/*}"],
  win: { target: [{ target: "nsis", arch: ["x64"] }], executableName: "Sage", icon: path.join(__dirname, "assets/sage.ico"), requestedExecutionLevel: "asInvoker" },
  nsis: {
    artifactName: "Sage-Setup-${version}.exe",
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    runAfterFinish: false,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    shortcutName: "Sage",
    deleteAppDataOnUninstall: false,
  },
  publish: null,
};

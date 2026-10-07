import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: "inherit", windowsHide: true,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
  if (result.error || result.status !== 0) throw new Error("Windows package command failed.");
}
if (!fs.existsSync(path.join(desktop, "assets/sage.ico"))) run(require("electron"), [path.join(desktop, "scripts/prepare-windows-icon.cjs")]);
fs.mkdirSync(path.join(desktop, "build"), { recursive: true });
const stage = fs.mkdtempSync(path.join(desktop, "build/sage-app-"));
fs.mkdirSync(path.join(stage, "electron"));
// Explicit allowlist: no server code, tests, .env, profile, or node_modules.
for (const name of ["main.cjs", "preload.cjs", "desktop-environment.cjs", "desktop-connection.cjs",
  "desktop-window.cjs", "screen-capture.cjs"]) {
  fs.copyFileSync(path.join(desktop, "electron", name), path.join(stage, "electron", name));
}
fs.cpSync(path.join(desktop, "dist"), path.join(stage, "dist"), { recursive: true });
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({
  name: "sage", productName: "Cue", version: metadata.version, description: "Cue desktop interview assistant",
  author: "Cue", main: "electron/main.cjs", private: true,
}, null, 2));
run(process.execPath, [require.resolve("electron-builder/cli.js"), "--projectDir", stage, "--config", path.join(desktop, "electron-builder.cjs"),
  "--config.directories.app=" + stage, "--win", "nsis", "--x64", "--publish", "never"]);
const asar = require("@electron/asar");
const archive = path.resolve(desktop, "../../releases/windows/win-unpacked/resources/app.asar");
const contents = asar.listPackage(archive).map(file => file.replaceAll("\\", "/").replace(/^\//, ""));
if (contents.some(file => /(^|\/)(materials|codex-workspace|codex-host\.cjs|codex-process\.cjs|codex-runtime\.cjs|\.runtime|\.env|auth\.json|node_modules)(\/|$)/.test(file))) {
  throw new Error("Package contains private/runtime/dependency files.");
}
console.log("Verified desktop chat package; no personal material or credentials packaged.");

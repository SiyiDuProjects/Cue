import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
if (process.platform !== "win32") throw new Error("This command builds the Windows app on Windows.");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: "inherit", windowsHide: true,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
  if (result.error || result.status !== 0) throw new Error("Windows package command failed.");
}
run(require("electron"), [path.join(desktop, "scripts/prepare-windows-icon.cjs")]);
fs.mkdirSync(path.join(desktop, "build"), { recursive: true });
const stage = fs.mkdtempSync(path.join(desktop, "build/sage-app-"));
fs.mkdirSync(path.join(stage, "electron"));
// Explicit allowlist: no server code, tests, .env, profile, or node_modules.
for (const name of ["main.cjs", "preload.cjs", "desktop-environment.cjs", "desktop-connection.cjs",
  "desktop-window.cjs", "screen-capture.cjs", "renderer-recovery.cjs", "package-diagnostics.cjs",
  "codex-host.cjs", "codex-process.cjs", "codex-runtime.cjs", "codex-activity.cjs", "materials.cjs"]) {
  fs.copyFileSync(path.join(desktop, "electron", name), path.join(stage, "electron", name));
}
fs.cpSync(path.join(desktop, "dist"), path.join(stage, "dist"), { recursive: true });
fs.mkdirSync(path.join(stage, "codex-workspace"));
// Only the public prompt is bundled; never copy the working directory or login.
for (const name of ["AGENTS.md", "README.md"]) {
  fs.copyFileSync(path.resolve(desktop, "../../assistant-workspace", name), path.join(stage, "codex-workspace", name));
}
fs.cpSync(path.resolve(desktop, "../../assistant-workspace/guides"), path.join(stage, "codex-workspace/guides"), { recursive: true });
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({
  name: "sage", productName: "Sage", version: metadata.version, description: "Sage desktop interview assistant",
  author: "Sage", main: "electron/main.cjs", private: true,
}, null, 2));
run(process.execPath, [require.resolve("electron-builder/cli.js"), "--projectDir", stage, "--config", path.join(desktop, "electron-builder.cjs"),
  "--config.directories.app=" + stage, "--win", "nsis", "--x64", "--publish", "never"]);
const asar = require("@electron/asar");
const archive = path.resolve(desktop, "../../releases/windows/win-unpacked/resources/app.asar");
const contents = asar.listPackage(archive).map(file => file.replaceAll("\\", "/").replace(/^\//, ""));
for (const file of ["electron/codex-host.cjs", "electron/codex-process.cjs", "electron/codex-runtime.cjs",
  "electron/codex-activity.cjs", "codex-workspace/AGENTS.md", "codex-workspace/README.md",
  "codex-workspace/guides/coding.md", "codex-workspace/guides/algorithms.md", "codex-workspace/guides/object-design.md"]) {
  if (!contents.includes(file)) throw new Error(`Package is missing ${file}`);
}
if (contents.some(file => /(^|\/)(materials|\.runtime|\.env|auth\.json|node_modules)(\/|$)/.test(file))) {
  throw new Error("Package contains private/runtime/dependency files.");
}
console.log("Verified Codex runtime and public templates; no personal material or credentials packaged.");

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Explicit opt-in: Electron retains its production default in all other modes.
const require = createRequire(import.meta.url);
const child = spawn(require("electron"), ["."], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, INTERVIEW_API_BASE_URL: "http://127.0.0.1:8001" },
  stdio: "inherit",
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });

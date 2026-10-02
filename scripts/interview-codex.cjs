const { spawn } = require("node:child_process");
const { loadDesktopEnvironment } = require("../apps/desktop/electron/desktop-environment.cjs");
const { runtimeOptions, configArguments } = require("../apps/desktop/electron/codex-runtime.cjs");
loadDesktopEnvironment();
try {
  const runtime = runtimeOptions();
  const args = process.argv.slice(2);
  // The application loads its own AGENTS.md explicitly; the interactive CLI
  // gets exactly the same file without discovering parent project instructions.
  const child = spawn(runtime.binary, [...configArguments(), "-c", `developer_instructions=${JSON.stringify(runtime.instructions)}`,
    ...(args.length ? args : ["--cd", runtime.workspace, "--sandbox", "read-only", "--ask-for-approval", "never"])],
  { cwd: runtime.workspace, env: runtime.env, stdio: "inherit", shell: false });
  child.on("error", () => { console.error("无法启动 Codex CLI。"); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }

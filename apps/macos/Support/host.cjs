// Only a local protocol bridge. Native Swift owns all UI, screenshots and audio.
const readline = require('node:readline');
const { CodexHost } = require('./electron/codex-host.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createRuntimeContext, configArguments } = require('./electron/codex-runtime.cjs');
let host, login;
let loginCancelled = false;
const lines = readline.createInterface({ input: process.stdin });
lines.once('line', line => {
  try {
    const config = JSON.parse(line);
    const environment = { ...process.env };
    if (config.codexBin) environment.INTERVIEW_CODEX_BIN = config.codexBin;
    else {
      const candidate = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'].find(file => fs.existsSync(file));
      if (candidate) environment.INTERVIEW_CODEX_BIN = candidate;
    }
    const runtimeContext = createRuntimeContext({ packaged: true, dataRoot: config.dataRoot, environment });
    if (config.action === 'login') {
      const runtime = runtimeContext.options();
      login = spawn(runtime.binary, [...configArguments(), 'login'], { cwd: runtime.workspace, env: runtime.env, stdio: 'ignore' });
      const timeout = setTimeout(() => { loginCancelled = true; process.exitCode = 1; lines.close(); }, 180_000);
      login.once('error', () => { clearTimeout(timeout); process.exitCode = 1; lines.close(); });
      login.once('exit', code => { clearTimeout(timeout); process.exitCode = !loginCancelled && code === 0 ? 0 : 1; login = null; lines.close(); });
    } else host = new CodexHost({ ...config, packaged: true, runtimeContext });
  } catch { process.exitCode = 1; lines.close(); }
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  try {
    // Reap the CLI before exiting, including when a hung login ignores SIGTERM.
    // The callback listener belongs to the CLI and must not outlive this private pipe.
    const child = login;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      loginCancelled = true; process.exitCode = 1;
      await new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 1500);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill();
      });
    }
    await host?.close(); clearTimeout(deadline); process.exit(process.exitCode || 0);
  }
  catch { process.exit(1); }
}
lines.on('close', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);

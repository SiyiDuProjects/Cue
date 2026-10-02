const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function findCodex(environment = process.env) {
  if (environment.INTERVIEW_CODEX_BIN) return path.resolve(environment.INTERVIEW_CODEX_BIN);
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  for (const directory of (environment.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  // The installed desktop app ships the same structured app-server executable.
  const base = path.join(environment.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "OpenAI/Codex/bin");
  if (fs.existsSync(base)) {
    const candidates = fs.readdirSync(base).map(name => path.join(base, name, executable))
      .filter(file => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  throw new Error("未找到 Codex CLI，请安装 CLI，或设置 INTERVIEW_CODEX_BIN 为可执行文件路径。");
}

function referenceWorkspace({ packaged = false, dataRoot, environment = process.env } = {}) {
  const template = path.resolve(__dirname, "../codex-workspace");
  const workspace = path.resolve(environment.INTERVIEW_CODEX_WORKSPACE || (packaged
    ? path.join(dataRoot, "assistant-workspace") : path.resolve(__dirname, "../../../assistant-workspace")));
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, "materials"), { recursive: true });
  for (const name of ["AGENTS.md", "README.md"]) {
    if (!fs.existsSync(path.join(workspace, name)) && fs.existsSync(path.join(template, name))) {
      fs.copyFileSync(path.join(template, name), path.join(workspace, name));
    }
  }
  for (const name of ["coding.md", "algorithms.md", "object-design.md"]) {
    const source = path.join(template, "guides", name), target = path.join(workspace, "guides", name);
    if (!fs.existsSync(target) && fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
    }
  }
  return workspace;
}

function runtimeOptions({ packaged = false, dataRoot, environment = process.env, conversationId } = {}) {
  const workspace = referenceWorkspace({ packaged, dataRoot, environment });
  const instructions = path.join(workspace, "AGENTS.md");
  if (!fs.existsSync(instructions)) throw new Error("Codex 工作目录缺少 AGENTS.md。");
  const home = path.join(workspace, ".runtime/codex");
  fs.mkdirSync(home, { recursive: true });
  // Do not inherit this developer's app identity, API secrets, global plugins or
  // memory. Authentication belongs to this runtime's normal Codex login store.
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(CODEX_|OPENAI_|INTERVIEW_|VITE_|HEROUI_|GITHUB_TOKEN$|GH_TOKEN$)/i.test(key)));
  env.CODEX_HOME = home;
  if (conversationId && !/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId)) throw new Error("无效的会话目录。");
  const codeRoot = conversationId ? path.join(workspace, "conversations", conversationId) : workspace;
  fs.mkdirSync(codeRoot, { recursive: true });
  const prompt = fs.readFileSync(instructions, "utf8").replaceAll("{{REFERENCE_ROOT}}", workspace.replaceAll("\\", "/"));
  return { binary: findCodex(environment), workspace: codeRoot, home, env, instructions: prompt };
}

function createRuntimeContext({ packaged = false, dataRoot, environment = process.env } = {}) {
  // Resolve once after loading the encrypted desktop configuration. Login,
  // materials and later conversations must not choose a new default directory
  // because the ambient environment changes during this app's lifetime.
  const snapshot = { ...environment };
  const workspace = referenceWorkspace({ packaged, dataRoot, environment: snapshot });
  snapshot.INTERVIEW_CODEX_WORKSPACE = workspace;
  Object.freeze(snapshot);
  return Object.freeze({ workspace,
    options: conversationId => runtimeOptions({ packaged, dataRoot, environment: snapshot, conversationId }),
  });
}

// Applied to the process as well as its threads: never load the product repo's
// ancestor AGENTS.md or third-party app plugins into the interview conversation.
const CONFIG = {
  ...(process.platform === "win32" ? { "windows.sandbox": "unelevated" } : {}),
  project_doc_max_bytes: 0,
  model_verbosity: "high",
  "features.apps": false,
  "features.plugins": false,
  "features.memories": false,
  "features.multi_agent": false,
  "features.computer_use": false,
  "features.browser_use": false,
  "features.skip_host_skill_discovery": true,
  web_search: "live",
};

function configArguments() {
  return Object.entries(CONFIG).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}

module.exports = { findCodex, runtimeOptions, referenceWorkspace, createRuntimeContext, CONFIG, configArguments };

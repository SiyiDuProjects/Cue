const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runtimeOptions, createRuntimeContext } = require("./codex-runtime.cjs");
const { loadConnection, saveConnection } = require("./desktop-connection.cjs");

test("dedicated workspace keeps explicit prompt, isolated login and excludes inherited provider credentials", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sage-runtime-test-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "PERSONAL_INSTRUCTIONS");
  t.after(() => {
    fs.rmdirSync(path.join(root, "materials"));
    fs.rmdirSync(path.join(root, ".runtime/codex")); fs.rmdirSync(path.join(root, ".runtime"));
    fs.unlinkSync(path.join(root, "AGENTS.md")); fs.rmdirSync(root);
  });
  const options = runtimeOptions({ environment: { INTERVIEW_CODEX_WORKSPACE: root,
    INTERVIEW_CODEX_BIN: process.execPath, CODEX_HOME: "unrelated-host", CODEX_THREAD_ID: "developer-thread",
    OPENAI_API_KEY: "must-not-forward", OPENAI_BASE_URL: "https://unrelated.test", INTERVIEW_ACCESS_TOKEN: "must-not-forward",
    PATH: "keep-path", SystemRoot: "keep-system" } });
  assert.equal(options.workspace, root);
  assert.equal(options.instructions, "PERSONAL_INSTRUCTIONS");
  assert.equal(options.env.CODEX_HOME, path.join(root, ".runtime/codex"));
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.OPENAI_BASE_URL, undefined);
  assert.equal(options.env.INTERVIEW_ACCESS_TOKEN, undefined);
  assert.equal(options.env.CODEX_THREAD_ID, undefined);
  assert.equal(options.env.SystemRoot, "keep-system");
});

test("saved login directory stays bound after environment changes and across conversations", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sage-bound-runtime-"));
  const workspace = path.join(root, "saved-workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "FIRST_INSTRUCTIONS");
  t.after(() => {
    for (const id of ["first", "second"]) fs.rmdirSync(path.join(workspace, "conversations", id));
    fs.rmdirSync(path.join(workspace, "conversations"));
    fs.rmdirSync(path.join(workspace, "materials"));
    fs.rmdirSync(path.join(workspace, ".runtime/codex")); fs.rmdirSync(path.join(workspace, ".runtime"));
    fs.unlinkSync(path.join(workspace, "AGENTS.md")); fs.rmdirSync(workspace);
    fs.unlinkSync(path.join(root, "connection.bin")); fs.rmdirSync(root);
  });
  let stored;
  const storage = { isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => { stored = value; return Buffer.from("encrypted-fixture"); },
    decryptStringAsync: async () => ({ result: stored }) };
  await saveConnection(root, storage, { accessToken: "private-fixture", codexWorkspace: workspace, codexBin: process.execPath });
  const environment = { SystemRoot: "preserved-system", CODEX_HOME: "unrelated-login" };
  await loadConnection(root, storage, environment);
  const context = createRuntimeContext({ packaged: true, dataRoot: root, environment });
  delete environment.INTERVIEW_CODEX_WORKSPACE;
  environment.INTERVIEW_CODEX_BIN = "wrong.exe";
  const first = context.options("first");
  environment.INTERVIEW_CODEX_WORKSPACE = path.join(root, "other-workspace");
  // Instructions stay editable while the workspace and auth identity stay fixed.
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "UPDATED_INSTRUCTIONS");
  const second = context.options("second"), login = context.options();
  assert.equal(context.workspace, workspace);
  assert.equal(login.workspace, workspace);
  assert.equal(first.workspace, path.join(workspace, "conversations/first"));
  assert.equal(second.workspace, path.join(workspace, "conversations/second"));
  for (const options of [first, second, login]) {
    assert.equal(options.home, path.join(workspace, ".runtime/codex"));
    assert.equal(options.env.CODEX_HOME, options.home);
    assert.equal(options.binary, process.execPath);
    assert.equal(options.env.INTERVIEW_ACCESS_TOKEN, undefined);
  }
  assert.equal(second.instructions, "UPDATED_INSTRUCTIONS");
  assert.equal(fs.existsSync(path.join(root, "assistant-workspace")), false);
  assert.equal(fs.existsSync(path.join(root, "other-workspace")), false);
});

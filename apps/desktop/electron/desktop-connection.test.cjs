const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConnection, saveConnection, validateConnection } = require("./desktop-connection.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sage-connection-test-"));
  t.after(() => { for (const name of ["connection.bin", "connection.bin.tmp"]) {
    const file = path.join(directory, name); if (fs.existsSync(file)) fs.unlinkSync(file);
  } fs.rmdirSync(directory); });
  let protectedValue;
  const storage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => { protectedValue = value; return Buffer.from("synthetic-encrypted"); },
    decryptStringAsync: async () => ({ result: protectedValue, shouldReEncrypt: false }),
  };
  return { directory, storage };
}
test("connection is stored encrypted and only desktop fields are restored", async t => {
  const { directory, storage } = fixture(t);
  await saveConnection(directory, storage, { apiBaseUrl: "https://example.test", accessToken: "fixture-token", OPENAI_API_KEY: "never-store" });
  assert.equal(fs.readFileSync(path.join(directory, "connection.bin"), "utf8"), "synthetic-encrypted");
  const env = {};
  assert.equal(await loadConnection(directory, storage, env), true);
  assert.deepEqual(env, { INTERVIEW_API_BASE_URL: "https://example.test", INTERVIEW_ACCESS_TOKEN: "fixture-token" });
});
test("saved credentials cannot be redirected to a different server", async t => {
  const { directory, storage } = fixture(t);
  await saveConnection(directory, storage, { apiBaseUrl: "https://example.test", accessToken: "fixture-token" });
  const env = { INTERVIEW_API_BASE_URL: "https://other.test" };
  await assert.rejects(loadConnection(directory, storage, env), /连接配置/);
  assert.equal(env.INTERVIEW_ACCESS_TOKEN, undefined);
  env.INTERVIEW_ACCESS_TOKEN = "explicit-other-token";
  assert.equal(await loadConnection(directory, storage, env), false);
  assert.equal(env.INTERVIEW_ACCESS_TOKEN, "explicit-other-token");
});
test("desktop-only Codex paths survive encrypted config import without storing provider auth", async t => {
  const { directory, storage } = fixture(t);
  const workspace = path.join(directory, "personal"), binary = path.join(directory, "codex.exe");
  await saveConnection(directory, storage, { accessToken: "fixture-token", codexWorkspace: workspace,
    codexBin: binary, OPENAI_API_KEY: "not-stored" });
  const env = {};
  await loadConnection(directory, storage, env);
  assert.equal(env.INTERVIEW_CODEX_WORKSPACE, workspace);
  assert.equal(env.INTERVIEW_CODEX_BIN, binary);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.throws(() => validateConnection({ accessToken: "fixture", codexWorkspace: "relative/path" }), /绝对路径/);
});
test("unavailable encryption preserves previous encrypted connection", async t => {
  const { directory, storage } = fixture(t);
  await saveConnection(directory, storage, { accessToken: "fixture-token" });
  storage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(saveConnection(directory, storage, { accessToken: "replacement" }), /安全存储/);
  assert.equal(fs.readFileSync(path.join(directory, "connection.bin"), "utf8"), "synthetic-encrypted");
});
test("rejects insecure remote URLs and missing tokens", () => {
  for (const url of ["http://remote.test", "https://user:password@example.test", "https://example.test/?token=secret", "file:///private"]) {
    assert.throws(() => validateConnection({ apiBaseUrl: url, accessToken: "fixture" }));
  }
  assert.throws(() => validateConnection({ apiBaseUrl: "https://example.test" }));
  assert.equal(validateConnection({ apiBaseUrl: "http://127.0.0.1:8000", accessToken: "fixture" }).apiBaseUrl, "http://127.0.0.1:8000");
});

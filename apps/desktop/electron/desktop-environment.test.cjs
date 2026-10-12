const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadDesktopEnvironment } = require("./desktop-environment.cjs");

function fixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cue-env-test-"));
  const file = path.join(directory, ".env");
  fs.writeFileSync(file, source);
  t.after(() => {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  return file;
}

test("loads private desktop settings without importing backend secrets", (t) => {
  const file = fixture(t, '\uFEFFCUE_ACCESS_TOKEN="test-only-token"\nCUE_API_BASE_URL=https://example.test\nOPENAI_API_KEY=test-only-backend-secret\nNODE_OPTIONS=untrusted\n');
  const environment = {};
  loadDesktopEnvironment(file, environment);
  assert.deepEqual(environment, {
    CUE_ACCESS_TOKEN: "test-only-token",
    CUE_API_BASE_URL: "https://example.test",
  });
});

test("explicit process settings win, including an empty local access token", (t) => {
  const file = fixture(t, "CUE_ACCESS_TOKEN=test-only-token\nCUE_API_BASE_URL=https://example.test\n");
  const environment = { CUE_ACCESS_TOKEN: "", CUE_API_BASE_URL: "http://127.0.0.1:8000" };
  loadDesktopEnvironment(file, environment);
  assert.equal(environment.CUE_ACCESS_TOKEN, "");
  assert.equal(environment.CUE_API_BASE_URL, "http://127.0.0.1:8000");
});

test("a missing local file is optional", (t) => {
  const file = fixture(t, "");
  const environment = {};
  loadDesktopEnvironment(path.join(path.dirname(file), "missing.env"), environment);
  assert.deepEqual(environment, {});
});

test("retired CLI and materials settings are never imported", (t) => {
  const file = fixture(t, "CUE_ACCESS_TOKEN=existing-login\nINTERVIEW_CODEX_BIN=unused\nINTERVIEW_CODEX_WORKSPACE=unused\nINTERVIEW_MATERIALS_WORKSPACE=unused\n");
  const environment = {};
  loadDesktopEnvironment(file, environment);
  assert.deepEqual(environment, { CUE_ACCESS_TOKEN: "existing-login" });
});

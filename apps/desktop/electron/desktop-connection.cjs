const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SERVER = "https://cue.siyidu.com";

function validateConnection(value) {
  const url = new URL(value.apiBaseUrl || DEFAULT_SERVER);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (loopback && url.protocol === "http:"))) {
    throw new Error("服务器地址必须是 HTTPS 地址；本机开发可使用 HTTP。");
  }
  if (typeof value.accessToken !== "string" || !value.accessToken.trim()) {
    throw new Error("缺少电脑连接配置。");
  }
  return { apiBaseUrl: url.origin, accessToken: value.accessToken.trim() };
}

async function saveConnection(directory, safeStorage, value) {
  const connection = validateConnection(value);
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("系统安全存储暂时不可用。");
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(connection));
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "connection.bin");
  // Only encrypted bytes touch disk; a failed write preserves the last config.
  fs.writeFileSync(target + ".tmp", encrypted, { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
}

async function loadConnection(directory, safeStorage, environment = process.env) {
  const target = path.join(directory, "connection.bin");
  if (!fs.existsSync(target)) return false;
  try {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("Unavailable");
    const decoded = await safeStorage.decryptStringAsync(fs.readFileSync(target));
    const saved = JSON.parse(decoded.result);
    const value = validateConnection(saved);
    // Both HTTPS origins belong to the same Sites project. Upgrade the encrypted
    // connection once; never redirect a credential to an arbitrary host.
    if (value.apiBaseUrl === "https://interview.siyidu.com") {
      value.apiBaseUrl = DEFAULT_SERVER;
    }
    const requested = environment.CUE_API_BASE_URL || environment.VITE_API_BASE_URL;
    if (requested && new URL(requested).origin !== value.apiBaseUrl) {
      // Never attach a saved credential to a server selected by another config.
      if (environment.CUE_ACCESS_TOKEN === undefined) throw new Error("Origin mismatch");
      return false;
    }
    if (JSON.stringify(saved) !== JSON.stringify(value)) {
      await saveConnection(directory, safeStorage, value);
    }
    if (!requested) environment.CUE_API_BASE_URL = value.apiBaseUrl;
    if (environment.CUE_ACCESS_TOKEN === undefined) environment.CUE_ACCESS_TOKEN = value.accessToken;
    return true;
  } catch {
    throw new Error("无法读取这台电脑的连接配置，请重新配置 Cue。配置不能复制到其他 Windows 账户使用。");
  }
}

module.exports = { DEFAULT_SERVER, loadConnection, saveConnection, validateConnection };

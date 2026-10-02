import { access, cp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expected = "1.0.0-beta.8";
const desktop = fileURLToPath(new URL("../", import.meta.url));
const target = path.join(desktop, "node_modules/@heroui-pro/react");
const entries = ["dist/components/resizable/index.js", "dist/components/chat-conversation/index.js", "dist/css/components/resizable.css", "dist/css/components/chat-conversation.css"];

async function verify(directory) {
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (metadata.version !== expected) throw new Error(`Expected Pro ${expected}, received ${metadata.version}.`);
  await Promise.all(entries.map(entry => access(path.join(directory, entry))));
}

try {
  await verify(target);
} catch {
  // Reuse the user's existing CollectUI installation; never download artifacts,
  // inspect credentials, or write to the source project during this local build.
  const source = path.resolve(process.env.HEROUI_PRO_LOCAL_DIR || path.join(desktop, "../../../Connection/web/node_modules/@heroui-pro/react"));
  try { await verify(source); }
  catch { throw new Error(`CollectUI Pro ${expected} artifacts are unavailable. For local builds, set HEROUI_PRO_LOCAL_DIR to an existing installation. For CI, configure HEROUI_AUTH_TOKEN before npm ci.`); }
  await cp(source, target, { recursive: true });
  await verify(target);
}
console.log(`Verified CollectUI Pro ${expected}.`);

#!/bin/bash
set -euo pipefail
MAC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$MAC_ROOT/../.." && pwd)"
CONFIGURATION="${CONFIGURATION:-release}"
NODE_BIN="${SAGE_NODE_BIN:-$(command -v node)}"
NODE_BIN="$("$NODE_BIN" -p 'process.execPath')"
NODE_LICENSE="${SAGE_NODE_LICENSE:-$(dirname "$(dirname "$NODE_BIN")")/LICENSE}"
if [[ ! -f "$NODE_LICENSE" ]]; then
  echo 'Set SAGE_NODE_LICENSE to the bundled Node distribution LICENSE file.' >&2
  exit 1
fi
if [[ "$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0]) >= 22')" != true ]]; then
  echo 'Node.js 22 or later is required.' >&2
  exit 1
fi
export CLANG_MODULE_CACHE_PATH="$MAC_ROOT/.build/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$MAC_ROOT/.build/swift-cache"
cd "$MAC_ROOT"
swift build --disable-sandbox --cache-path "$MAC_ROOT/.build/cache" -c "$CONFIGURATION"
BIN_DIR="$(swift build --disable-sandbox --cache-path "$MAC_ROOT/.build/cache" -c "$CONFIGURATION" --show-bin-path)"
"$BIN_DIR/SageChecks"
# Stage into a fresh directory; a failed build never replaces a working app.
mkdir -p "$MAC_ROOT/output"
STAGE="$(mktemp -d "$MAC_ROOT/output/staging.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/Cue.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bridge/electron"
cp "$BIN_DIR/Sage" "$APP/Contents/MacOS/Cue"
cp "$NODE_BIN" "$APP/Contents/MacOS/sage-node"
cp "$NODE_LICENSE" "$APP/Contents/Resources/Node-LICENSE.txt"
cp "$MAC_ROOT/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/THIRD_PARTY_NOTICES.md"
cp "$MAC_ROOT/Support/Info.plist" "$APP/Contents/Info.plist"
cp "$MAC_ROOT/Support/native-appshot.cjs" "$APP/Contents/Resources/bridge/native-appshot.cjs"
(cd "$REPO_ROOT/apps/desktop" && npm run build)
cp "$REPO_ROOT/apps/desktop/node_modules/@ozymandiasthegreat/vad/LICENSE" "$APP/Contents/Resources/VAD-LICENSE.txt"
cp -R "$REPO_ROOT/apps/desktop/dist" "$APP/Contents/Resources/ui"
# The bundled Vite output is one self-contained script. Classic loading avoids
# file-origin module CORS in WKWebView without weakening WebKit permissions.
"$NODE_BIN" -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/type="module"/g,"defer").replace(/ crossorigin/g,""));' "$APP/Contents/Resources/ui/index.html"
codesign --force --sign - "$APP/Contents/MacOS/sage-node"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
if [[ -e "$MAC_ROOT/output/Cue.app" ]]; then
  mv "$MAC_ROOT/output/Cue.app" "$STAGE/previous.app"
fi
mv "$APP" "$MAC_ROOT/output/Cue.app"
echo "Built $MAC_ROOT/output/Cue.app (local ad-hoc signature; not notarized)."

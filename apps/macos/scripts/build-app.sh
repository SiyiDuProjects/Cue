#!/bin/bash
set -euo pipefail
MAC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$MAC_ROOT/../.." && pwd)"
CONFIGURATION="${CONFIGURATION:-release}"
SIGN_IDENTITY="${CUE_SIGN_IDENTITY:-}"
if [[ -z "$SIGN_IDENTITY" ]] && ! python3 "$MAC_ROOT/scripts/local-signing.py" configured; then
  if [[ "${CUE_ALLOW_ADHOC:-0}" == "1" ]]; then
    SIGN_IDENTITY="-"
  else
    echo "No stable Cue signing identity. Configure local signing or CUE_SIGN_IDENTITY before packaging." >&2
    exit 1
  fi
fi
NODE_BIN="${SAGE_NODE_BIN:-$(command -v node)}"
NODE_BIN="$("$NODE_BIN" -p 'process.execPath')"
if [[ "$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0]) >= 22')" != true ]]; then
  echo 'Node.js 22 or later is required.' >&2
  exit 1
fi
export CLANG_MODULE_CACHE_PATH="$MAC_ROOT/.build/modules/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$MAC_ROOT/.build/modules/swift"
cd "$MAC_ROOT"
swift build --disable-sandbox --cache-path "$MAC_ROOT/.build/cache" -c "$CONFIGURATION"
BIN_DIR="$(swift build --disable-sandbox --cache-path "$MAC_ROOT/.build/cache" -c "$CONFIGURATION" --show-bin-path)"
"$BIN_DIR/SageChecks"
"$NODE_BIN" "$MAC_ROOT/tests/appshot-budget.cjs" "$BIN_DIR/SageChecks"
if nm -u "$BIN_DIR/Sage" | grep '_AXUIElementGetWindow' >/dev/null; then
  echo 'App Shot must not strongly import the optional AX window ID function.' >&2
  exit 1
fi
# Stage into a fresh directory; a failed build never replaces a working app.
mkdir -p "$MAC_ROOT/output"
STAGE="$(mktemp -d "$MAC_ROOT/output/staging.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/Cue.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Sage" "$APP/Contents/MacOS/Cue"
cp "$MAC_ROOT/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/THIRD_PARTY_NOTICES.md"
cp "$MAC_ROOT/Support/Info.plist" "$APP/Contents/Info.plist"
# The Mac window is native; the page only renders answers and runs transcription.
(cd "$REPO_ROOT/apps/desktop" && npm run build:mac)
cp "$REPO_ROOT/apps/desktop/node_modules/@ozymandiasthegreat/vad/LICENSE" "$APP/Contents/Resources/VAD-LICENSE.txt"
cp -R "$REPO_ROOT/apps/desktop/dist-mac" "$APP/Contents/Resources/ui"
# The bundled Vite output is one self-contained script. Classic loading avoids
# file-origin module CORS in WKWebView without weakening WebKit permissions.
"$NODE_BIN" -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/type="module"/g,"defer").replace(/ crossorigin/g,""));' "$APP/Contents/Resources/ui/content.html"
if [[ -n "$SIGN_IDENTITY" ]]; then
  codesign --force --sign "$SIGN_IDENTITY" "$APP"
else
  python3 "$MAC_ROOT/scripts/local-signing.py" sign "$APP"
fi
codesign --verify --deep --strict "$APP"
if [[ -e "$MAC_ROOT/output/Cue.app" ]]; then
  mv "$MAC_ROOT/output/Cue.app" "$STAGE/previous.app"
fi
mv "$APP" "$MAC_ROOT/output/Cue.app"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  echo "Built $MAC_ROOT/output/Cue.app (ad-hoc: changed builds may require macOS permission again)."
else
  echo "Built $MAC_ROOT/output/Cue.app with the configured stable signing identity."
fi

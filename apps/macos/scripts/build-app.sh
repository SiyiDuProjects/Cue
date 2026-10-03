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
APP="$STAGE/Sage.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bridge/electron" "$APP/Contents/Resources/bridge/codex-workspace/guides"
cp "$BIN_DIR/Sage" "$APP/Contents/MacOS/Sage"
cp "$NODE_BIN" "$APP/Contents/MacOS/sage-node"
cp "$NODE_LICENSE" "$APP/Contents/Resources/Node-LICENSE.txt"
cp "$MAC_ROOT/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/THIRD_PARTY_NOTICES.md"
cp "$MAC_ROOT/Support/Info.plist" "$APP/Contents/Info.plist"
cp "$MAC_ROOT/Support/host.cjs" "$APP/Contents/Resources/bridge/host.cjs"
cp "$REPO_ROOT/apps/desktop/package.json" "$APP/Contents/Resources/bridge/package.json"
for name in codex-host codex-process codex-runtime codex-activity materials; do
  cp "$REPO_ROOT/apps/desktop/electron/$name.cjs" "$APP/Contents/Resources/bridge/electron/"
done
# Explicit public-template whitelist: never copy materials, credentials or runtime state.
for name in AGENTS.md README.md; do
  cp "$REPO_ROOT/assistant-workspace/$name" "$APP/Contents/Resources/bridge/codex-workspace/"
done
for name in coding algorithms object-design; do
  cp "$REPO_ROOT/assistant-workspace/guides/$name.md" "$APP/Contents/Resources/bridge/codex-workspace/guides/"
done
codesign --force --sign - "$APP/Contents/MacOS/sage-node"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
if [[ -e "$MAC_ROOT/output/Sage.app" ]]; then
  mv "$MAC_ROOT/output/Sage.app" "$STAGE/previous.app"
fi
mv "$APP" "$MAC_ROOT/output/Sage.app"
echo "Built $MAC_ROOT/output/Sage.app (local ad-hoc signature; not notarized)."

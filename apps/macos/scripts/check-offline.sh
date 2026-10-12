#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="$PWD/.build/modules/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/modules/swift"
swift build --disable-sandbox --cache-path "$PWD/.build/cache" -c debug
.build/debug/CueChecks
bash scripts/check-audio-delivery.sh "$PWD/.build/debug"
if nm -u ".build/debug/Cue" | grep -E '_AX(UIElement|IsProcessTrusted)' >/dev/null; then
  echo 'Screenshot capture must not read other apps through accessibility APIs.' >&2
  exit 1
fi

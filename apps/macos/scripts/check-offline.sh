#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="$PWD/.build/modules/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/modules/swift"
swift build --disable-sandbox --cache-path "$PWD/.build/cache" -c debug
.build/debug/SageChecks
bash scripts/check-audio-delivery.sh "$PWD/.build/debug"
node tests/appshot-budget.cjs .build/debug/SageChecks
if nm -u .build/debug/Sage | grep '_AXUIElementGetWindow' >/dev/null; then
  echo 'App Shot must not strongly import the optional AX window ID function.' >&2
  exit 1
fi

#!/bin/bash
set -euo pipefail
MAC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$1"
# Compile the actual native orchestration with fake devices/control transport.
# Support both Xcode and native SwiftPM build product layouts.
CHECK_DIR="$MAC_ROOT/.build/audio-delivery-check"
mkdir -p "$CHECK_DIR"
if [[ -f "$BIN_DIR/SageCore.o" ]]; then
  OBJECTS=("$BIN_DIR/SageCore.o" "$BIN_DIR/SageAppShot.o")
  MODULES="$BIN_DIR"
else
  OBJECTS=("$BIN_DIR/SageCore.build/"*.swift.o "$BIN_DIR/SageAppShot.build/"*.swift.o)
  MODULES="$BIN_DIR/Modules"
fi
swiftc -parse-as-library -module-cache-path "$MAC_ROOT/.build/modules/clang" \
  -I "$MODULES" "${OBJECTS[@]}" \
  "$MAC_ROOT/Sources/Sage/AppStore.swift" "$MAC_ROOT/Sources/Sage/Capture.swift" \
  "$MAC_ROOT/Sources/Sage/WindowText.swift" "$MAC_ROOT/Sources/Sage/LocalServices.swift" \
  "$MAC_ROOT/tests/audio-delivery.swift" -o "$CHECK_DIR/check"
"$CHECK_DIR/check"

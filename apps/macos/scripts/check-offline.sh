#!/bin/bash
set -euo pipefail
MAC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIGURATION=debug bash "$MAC_ROOT/scripts/build-app.sh"
"$MAC_ROOT/output/Cue.app/Contents/MacOS/Cue" --self-test
node "$MAC_ROOT/tests/bridge-smoke.cjs"
node --test "$MAC_ROOT/tests/native-appshot-smoke.cjs"

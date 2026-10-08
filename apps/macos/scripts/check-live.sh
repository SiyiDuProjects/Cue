#!/bin/bash
set -euo pipefail
# Production acceptance is deliberately separate from the offline checks.
# No microphone or screen APIs are used; credentials stay in the native driver.
if [[ "${1:-}" != "--run-live" || $# -gt 2 ]]; then
  echo "Usage: bash apps/macos/scripts/check-live.sh --run-live [minutes, default 65]" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MINUTES="${2:-65}"
mkdir -p "$ROOT/artifacts/acceptance"
RUN_DIR="$(mktemp -d "$ROOT/artifacts/acceptance/run.XXXXXX")"
for role in interviewer candidate; do
  if [[ "$role" == interviewer ]]; then
    phrase='This is the interviewer channel. The project code is cobalt seven.'
  else
    phrase='This is the candidate channel. The answer code is maple nine.'
  fi
  /usr/bin/say -v Samantha --file-format=WAVE --data-format=LEI16@24000 -o "$RUN_DIR/$role.wav" "$phrase"
done
python3 - "$RUN_DIR" <<'PY'
import sys, wave
from pathlib import Path
for p in Path(sys.argv[1]).glob('*.wav'):
    with wave.open(str(p)) as audio:
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
        assert audio.getframerate() == 24000 and audio.getnframes() > 24000
        p.with_suffix('.pcm').write_bytes(audio.readframes(audio.getnframes()))
PY
swiftc -parse-as-library -module-cache-path "$ROOT/apps/macos/.build/acceptance-cache" \
  "$ROOT/apps/macos/Sources/SageCore/Protocol.swift" \
  "$ROOT/apps/macos/Sources/SageCore/Transport.swift" \
  "$ROOT/apps/macos/tests/DirectAcceptanceBridge.swift" \
  "$ROOT/apps/macos/tests/live-acceptance.swift" -o "$RUN_DIR/CueAcceptance"
export CUE_NODE_BIN="$(node -p 'process.execPath')"
export CUE_DIRECT_RUNNER="$ROOT/apps/desktop/tests/direct-runner.mjs"
echo "Production acceptance: replaces the desktop connection; uses paid transcription."
echo "A 65-minute run also checks paid Responses chat. No real microphone or screen capture."
exec "$RUN_DIR/CueAcceptance" --run-live "$RUN_DIR" "$MINUTES" "$RUN_DIR/report.jsonl"

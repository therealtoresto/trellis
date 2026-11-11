#!/bin/bash
# Builds Trellis, replaces /Applications/Trellis.app and starts the new copy.
# The running copy is asked to quit first and stopped if it does not, so the old build never lingers.
set -euo pipefail
cd "$(dirname "$0")/.."
./node_modules/.bin/tauri build
APP=/Applications/Trellis.app
BIN="$APP/Contents/MacOS/trellis"
osascript -e 'tell application id "com.tarasbondaruk.trellis" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$BIN" >/dev/null || break; sleep 0.5; done
if pgrep -f "$BIN" >/dev/null; then pkill -TERM -f "$BIN" || true; sleep 1; fi
rm -rf "$APP"
cp -R src-tauri/target/release/bundle/macos/Trellis.app /Applications/
open "$APP"

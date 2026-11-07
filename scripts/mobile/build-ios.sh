#!/usr/bin/env bash
# Builds the Bola 8 Staff app for the iOS Simulator and launches it (macOS only, no EAS, no Apple account).
#   expo prebuild (ios/) -> pod install -> expo run:ios on the chosen simulator (starts Metro).
# ios/ is git-ignored and regenerated from mobile/app.config.ts, so never edit it by hand.
#
# Usage: scripts/mobile/build-ios.sh [device name or UDID] [--clean]
#   device   simulator name ("iPhone 17 Pro", the default) or UDID; it is booted if needed
#   --clean  wipe ios/ and re-run `expo prebuild --clean` + pod install
# Env:   BOLA8_IOS_DEVICE overrides the default device name.
# After launch, enter the server URL on the first screen (e.g. localhost:8090 for scripts/mobile/start-local-backend.sh;
# the simulator shares the host network).
set -euo pipefail

DEVICE="${BOLA8_IOS_DEVICE:-iPhone 17 Pro}"
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    *) DEVICE="$arg" ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE="$ROOT/mobile"
export EXPO_NO_TELEMETRY=1
export LANG="${LANG:-en_US.UTF-8}"   # CocoaPods aborts under a non-UTF-8 locale

[[ "$(uname)" == "Darwin" ]] || { echo "build-ios.sh needs macOS" >&2; exit 1; }
for tool in xcodebuild xcrun pod node npx; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

# Resolve the simulator (UDID or exact name) and boot it.
UDID="$(xcrun simctl list devices available | grep -F "$DEVICE" | grep -oE '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -1 || true)"
[[ -n "$UDID" ]] || { echo "no available simulator matching '$DEVICE' (xcrun simctl list devices available)" >&2; exit 1; }
xcrun simctl boot "$UDID" 2>/dev/null || true   # already booted is fine
open -a Simulator

cd "$MOBILE"
[[ -d node_modules ]] || npm ci

if [[ "$CLEAN" == 1 || ! -d ios ]]; then
  PREBUILD=(npx expo prebuild --platform ios --no-install)
  [[ "$CLEAN" == 1 ]] && PREBUILD+=(--clean)
  echo "+ ${PREBUILD[*]}"
  "${PREBUILD[@]}"
fi

if [[ "$CLEAN" == 1 || ! -d ios/Pods ]]; then
  echo "+ pod install"
  (cd ios && pod install)
fi

echo "+ expo run:ios --device $UDID   (Metro stays in the foreground; Ctrl-C stops it)"
exec npx expo run:ios --device "$UDID" --no-install

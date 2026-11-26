#!/usr/bin/env bash
# Builds an UNSIGNED Release .ipa of the Bola 8 Staff iOS app (no Apple account needed on this Mac).
# The partner re-signs it with their own Apple ID using Sideloadly (see docs/mobile/release/INSTALL_IOS_PARTNER_ES.md).
#
#   expo prebuild (ios/) -> pod install -> xcodebuild Release, generic/platform=iOS, CODE_SIGNING_ALLOWED=NO
#   -> dist/Payload/<App>.app -> zip -> dist/bola8-staff-<APP_VERSION>-<APP_BUILD>-unsigned.ipa
#
# Usage: scripts/mobile/ios-build-unsigned-ipa.sh [IOS_BUNDLE_ID]
#   Paths are relative to mobile/ (all git-ignored): build/ios = DerivedData, dist/ = Payload + the .ipa.
#   Default bundle id com.bola8.staff (override with arg or IOS_BUNDLE_ID); Sideloadly may rewrite it per Apple ID.
#   Prints the absolute .ipa path, size and sha256 at the end.
#
# The GitHub updater token is Android-only and is NEVER embedded: BOLA8_UPDATES_* is unset below, and the
# script refuses to run if mobile/.env* defines it (Expo would load it into the app config).
set -euo pipefail

export IOS_BUNDLE_ID="${1:-${IOS_BUNDLE_ID:-com.bola8.staff}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE="$ROOT/mobile"
export EXPO_NO_TELEMETRY=1
export LANG="${LANG:-en_US.UTF-8}"   # CocoaPods aborts under a non-UTF-8 locale

[[ "$(uname)" == "Darwin" ]] || { echo "ios-build-unsigned-ipa.sh needs macOS" >&2; exit 1; }
for tool in xcodebuild pod node npx zip shasum; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

unset BOLA8_UPDATES_TOKEN BOLA8_UPDATES_LATEST_URL
if grep -qsE '^[[:space:]]*(export[[:space:]]+)?BOLA8_UPDATES_(TOKEN|LATEST_URL)=' "$MOBILE"/.env "$MOBILE"/.env.* 2>/dev/null; then
  echo "refusing to build: mobile/.env* defines BOLA8_UPDATES_* (Expo would load it into the app config). Remove it for this build." >&2
  exit 1
fi

cd "$MOBILE"
[[ -d node_modules ]] || npm ci

# Single source of truth for the file name: mobile/src/config/version.ts
APP_VERSION="$(sed -nE "s/.*APP_VERSION = '([^']+)'.*/\1/p" src/config/version.ts)"
APP_BUILD="$(sed -nE "s/.*APP_BUILD = ([0-9]+).*/\1/p" src/config/version.ts)"
[[ -n "$APP_VERSION" && -n "$APP_BUILD" ]] || { echo "could not read APP_VERSION/APP_BUILD from src/config/version.ts" >&2; exit 1; }

echo "+ expo prebuild --platform ios --clean   (bundle id $IOS_BUNDLE_ID)"
npx expo prebuild --platform ios --clean --no-install

echo "+ pod install"
(cd ios && pod install)

WORKSPACE="$(ls -d ios/*.xcworkspace 2>/dev/null | head -1 || true)"
[[ -n "$WORKSPACE" ]] || { echo "no ios/*.xcworkspace after prebuild" >&2; exit 1; }
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"

echo "+ xcodebuild $WORKSPACE scheme $SCHEME (Release, generic iOS, unsigned)"
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath build/ios build

APP="$(find build/ios/Build/Products/Release-iphoneos -maxdepth 1 -name '*.app' | head -1)"
[[ -d "$APP" ]] || { echo "build finished but no .app under build/ios/Build/Products/Release-iphoneos" >&2; exit 1; }

IPA="dist/bola8-staff-${APP_VERSION}-${APP_BUILD}-unsigned.ipa"
rm -rf dist/Payload "$IPA"
mkdir -p dist/Payload
cp -R "$APP" dist/Payload/
(cd dist && zip -qry "$(basename "$IPA")" Payload)
rm -rf dist/Payload

echo "ipa:    $MOBILE/$IPA"
echo "size:   $(du -h "$IPA" | cut -f1)"
echo "sha256: $(shasum -a 256 "$IPA" | cut -d' ' -f1)"

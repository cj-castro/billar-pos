#!/usr/bin/env bash
# Builds the Bola 8 Staff app for a PHYSICAL iPhone, signs it with a FREE Apple ID ("Personal Team"),
# installs it over USB/Wi-Fi and launches it. No paid Apple Developer account, no EAS, macOS only.
#
#   expo prebuild (ios/) -> pod install -> xcodebuild Release (automatic signing) -> devicectl install + launch
#
# Usage:
#   DEVELOPMENT_TEAM=ABCDE12345 scripts/mobile/ios-resign-install.sh [DEVICE_UDID]
#   scripts/mobile/ios-resign-install.sh ABCDE12345 [DEVICE_UDID]
#
#   DEVELOPMENT_TEAM  (required, env or 1st arg) 10-character Team ID of your Personal Team. Find it in
#                     Xcode > Settings > Accounts > select the Apple ID > "Personal Team" > Team ID, or run
#                     `security find-identity -v -p codesigning` and read the (ABCDE12345) after the name.
#   DEVICE_UDID       (optional, env or last arg) UDID or CoreDevice identifier from `xcrun devicectl list devices`.
#                     Default: the first iPhone that is connected (cable, or paired + reachable over Wi-Fi).
#   IOS_BUNDLE_ID     (optional env) bundle identifier. Default com.bola8.staff.
#
# Free Personal Team limits (Apple, not ours):
#   * The provisioning profile / certificate expires after 7 DAYS. The app then stops launching until you re-run
#     this script (it re-signs and reinstalls over the existing app, data is kept). Re-run it weekly.
#   * Max 3 devices registered and 3 apps installed per device with a free account.
#   * 10 new App IDs per 7 days per Apple ID. If Xcode says the bundle id "is not available" / cannot be registered,
#     someone else owns com.bola8.staff: use IOS_BUNDLE_ID=com.bola8.staff.dev PERMANENTLY (changing the id later
#     burns another App ID from the quota and installs as a separate app).
#
# One-time setup on the iPhone/Mac: see docs/mobile/release/INSTALL_IOS_OWNER.md (Developer Mode, trust the Mac,
# sign in with your Apple ID in Xcode > Settings > Accounts).
#
# The build never embeds the GitHub updater token (the updater is Android-only): BOLA8_UPDATES_* is unset below.
# Output: mobile/build/ios (DerivedData, git-ignored). ios/ is git-ignored and regenerated each run.
set -euo pipefail

TEAM="${DEVELOPMENT_TEAM:-}"
UDID="${DEVICE_UDID:-}"
# Positional args: [TEAM] [UDID]; if DEVELOPMENT_TEAM is already in the env, a single arg is the UDID.
if [[ $# -ge 1 ]]; then
  if [[ -n "$TEAM" ]]; then UDID="$1"; else TEAM="$1"; fi
fi
[[ $# -ge 2 ]] && UDID="$2"
[[ -n "$TEAM" ]] || { echo "DEVELOPMENT_TEAM is required (10-char Team ID). See the header of this script." >&2; exit 1; }
[[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo "DEVELOPMENT_TEAM '$TEAM' does not look like a 10-character Team ID" >&2; exit 1; }
BUNDLE_ID="${IOS_BUNDLE_ID:-com.bola8.staff}"
export IOS_BUNDLE_ID="$BUNDLE_ID"   # read by mobile/app.config.ts at prebuild time

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE="$ROOT/mobile"
export EXPO_NO_TELEMETRY=1
export LANG="${LANG:-en_US.UTF-8}"   # CocoaPods aborts under a non-UTF-8 locale

[[ "$(uname)" == "Darwin" ]] || { echo "ios-resign-install.sh needs macOS" >&2; exit 1; }
for tool in xcodebuild xcrun pod node npx python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

# Never bake the (Android-only) updater token / override URL into an iOS binary.
unset BOLA8_UPDATES_TOKEN BOLA8_UPDATES_LATEST_URL
if grep -qsE '^[[:space:]]*(export[[:space:]]+)?BOLA8_UPDATES_(TOKEN|LATEST_URL)=' "$MOBILE"/.env "$MOBILE"/.env.* 2>/dev/null; then
  echo "refusing to build: mobile/.env* defines BOLA8_UPDATES_* (Expo would load it into the app config). Remove it for this build." >&2
  exit 1
fi

cd "$MOBILE"
[[ -d node_modules ]] || npm ci

echo "+ expo prebuild --platform ios --clean   (bundle id $BUNDLE_ID)"
npx expo prebuild --platform ios --clean --no-install

echo "+ pod install"
(cd ios && pod install)

# Free Personal Teams cannot sign the Push Notifications capability. expo-notifications adds
# aps-environment, but the app only uses LOCAL notifications (ready chime), which need no entitlement.
for ent in ios/*/*.entitlements; do
  [[ -f "$ent" ]] || continue
  if /usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ent" >/dev/null 2>&1; then
    echo "+ removing aps-environment from $ent (not allowed for free Personal Teams)"
    /usr/libexec/PlistBuddy -c 'Delete :aps-environment' "$ent"
  fi
done

WORKSPACE="$(ls -d ios/*.xcworkspace 2>/dev/null | head -1 || true)"
[[ -n "$WORKSPACE" ]] || { echo "no ios/*.xcworkspace after prebuild" >&2; exit 1; }
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
DERIVED="$MOBILE/build/ios"

# Pick the device BEFORE building: a free Personal Team can only create a provisioning profile for a
# device registered to the team, and xcodebuild registers it only when it builds for that specific device.
# Accepts either the hardware UDID or the CoreDevice identifier; resolves to the hardware UDID.
LIST_JSON="$(mktemp -t bola8-devices).json"
xcrun devicectl list devices --json-output "$LIST_JSON" >/dev/null
UDID="$(python3 - "$LIST_JSON" "$UDID" <<'PY2'
import json, sys
devs = json.load(open(sys.argv[1]))["result"]["devices"]
want = sys.argv[2]
phones = [d for d in devs if d.get("hardwareProperties", {}).get("deviceType") == "iPhone"]
if want:
    phones = [d for d in phones if want in (d.get("identifier"), d.get("hardwareProperties", {}).get("udid"))]
rank = {"connected": 0, "disconnected": 1}
phones = [d for d in phones if d.get("connectionProperties", {}).get("tunnelState") != "unavailable"]
phones.sort(key=lambda d: rank.get(d.get("connectionProperties", {}).get("tunnelState"), 2))
print(phones[0]["hardwareProperties"]["udid"] if phones else "")
PY2
)"
rm -f "$LIST_JSON"
[[ -n "$UDID" ]] || { echo "no iPhone found. Plug it in, unlock it, tap 'Trust', enable Developer Mode, then re-run (or pass DEVICE_UDID)." >&2; exit 1; }
echo "device: $UDID"

echo "+ xcodebuild $WORKSPACE scheme $SCHEME (Release, device $UDID, team $TEAM)"
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination "id=$UDID" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" \
  -derivedDataPath "$DERIVED" build

APP="$(find "$DERIVED/Build/Products/Release-iphoneos" -maxdepth 1 -name '*.app' | head -1)"
[[ -d "$APP" ]] || { echo "build finished but no .app under $DERIVED/Build/Products/Release-iphoneos" >&2; exit 1; }
echo "built: $APP"

echo "+ devicectl device install app"
xcrun devicectl device install app --device "$UDID" "$APP"
echo "+ devicectl device process launch $BUNDLE_ID"
xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID" || {
  echo "installed, but launch failed. On the iPhone: Settings > General > VPN & Device Management > trust your Apple ID, then open the app." >&2
  exit 1
}
echo "Done. Free-account signing expires in 7 days: re-run this script weekly."

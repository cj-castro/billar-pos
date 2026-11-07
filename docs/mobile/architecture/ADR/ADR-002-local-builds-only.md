# ADR-002: Local builds only (no EAS, no store publishing)

## Status
Accepted (D2)

## Problem
Expo's default path uses EAS cloud builds and updates. The project mandate keeps everything local; the app is sideloaded for one venue.

## Options
1. EAS Build + EAS Update + stores.
2. Local `expo prebuild` + Gradle, sideloaded APK.
3. Check in a hand-maintained `android/` folder.

## Decision
Option 2. `android/` and `ios/` are generated and git-ignored. Debug: `npx expo run:android`. Release: `gradlew assembleRelease`, signed with a local keystore that is never committed. No `eas-cli`, `eas.json`, `expo-updates`, `expo-dev-client`, or Expo Go.

## Rationale
No external service or account dependency, reproducible from `app.json` and plugins, works on the Windows host with JDK 21 and the command-line Android SDK. Option 3 drifts from the generated template and makes SDK upgrades painful.

## Consequences
- No OTA updates: every change is a new APK installed by hand; show the version string in Admin diagnostics.
- Keystore loss forces uninstall and reinstall on every phone; back it up outside the repo.
- Build time and Windows path-length limits are ours to manage (long paths enabled).
- iOS later needs a Mac with Xcode, still without cloud services.

## Reversibility
High. Adding EAS later is configuration only; the project is a standard Expo app.

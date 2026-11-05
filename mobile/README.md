# Bola 8 Staff (mobile companion)

Android-first (iOS-ready) Expo + React Native + TypeScript companion to the Bola 8 POS.
Foundation only: server setup, login, role routing, API client, realtime, i18n. Feature screens come next.

- Expo SDK **58** (React Native 0.88, React 19.3), Expo Router, TanStack Query 5, zustand 5, axios, socket.io-client 4, i18next.
- Package `com.bola8.staff` (Android) / bundle id `com.bola8.staff` (iOS).
- Local builds only (no EAS, no stores). Design decisions: `docs/mobile/PROJECT_STATE.md` (D1-D13).

## Prerequisites

- Node 20+ and npm (tested Node 24 / npm 11).
- JDK 21 (`JAVA_HOME`), Android SDK (`ANDROID_HOME`) with a platform 34+ and build-tools.
- A device or emulator for `run:android`. Accept SDK licences once: `sdkmanager --licenses`.
- If your `~/.npmrc` sets `allow-scripts`, `npx expo install` can fail with `EALLOWSCRIPTS`; run it with `npm_config_userconfig=<empty file>`.

## Install / run

```bash
cd mobile
npm install
npx expo start              # Metro dev server
npx expo run:android        # prebuild + build + install on the connected device/emulator
```

`EXPO_NO_TELEMETRY=1` is recommended.

## Test / lint / typecheck

```bash
npm test            # jest-expo + React Native Testing Library
npm run typecheck   # tsc --noEmit
npm run lint        # expo lint (eslint-config-expo)
```

## Build a debug APK

```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew.bat assembleDebug      # ./gradlew on macOS/Linux
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

**Windows path-length gotcha.** The CMake/ninja steps of the native modules (gesture-handler, screens, worklets) fail with
`ninja: error: mkdir(...): No such file or directory` when the project lives under a deep path
(e.g. `D:\Projects\Code\billar-pos-worktrees\...`), even with `LongPathsEnabled=1`, because the SDK's ninja 1.10.2 is not long-path aware.
Workaround used to produce the first APK: build from a short path (e.g. `E:\b8\m`) and point AGP at a CMake dir whose
`bin\ninja.exe` is ninja >= 1.13 (`pip download ninja`), via `android/local.properties`: `cmake.dir=E\:\\b8\\cmake322`.
Limiting ABIs speeds it up: `./gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64`.

`android/` and `ios/` are **generated** (Expo CNG) and gitignored. Native config lives in `app.config.ts`; never hand-edit the generated folders.

## Server URL

On first launch the app asks for the POS address and checks `GET {base}/api/v1/health` (5 s timeout, expects `{"status":"ok"}`).
Input is normalized: `192.168.1.22:8080` becomes `http://192.168.1.22:8080`. It is stored in AsyncStorage (change it from the login screen).

| Where | URL |
|---|---|
| Bar network (production) | `http://<pos-host>:8080` (nginx; backend :5000 is not published) |
| Android emulator -> local docker backend | `http://10.0.2.2:8090` |
| Physical phone -> dev machine | `http://<dev-machine-LAN-IP>:8090` |

## Security notes

- The LAN backend is plain `http://`, so `app.config.ts` enables Android cleartext traffic (`expo-build-properties` -> `usesCleartextTraffic: true`).
  **This is LAN-only. HTTPS (TLS at nginx) is on the roadmap and the flag should then be removed.**
- Tokens live in `expo-secure-store` (Keystore/Keychain), never AsyncStorage. Only the non-secret user profile is in AsyncStorage.
- The API client never logs tokens, PINs or request bodies.

## Layout

```
app/                 Expo Router: _layout (providers), index (boot gate), setup, login, denied,
                     (waiter)/floor (kitchen)/queue (manager)/overview (admin)/diagnostics  -- placeholders
src/config/          server URL store + health validation
src/api/             axios client (Bearer, single-flight refresh, ApiError) + endpoints/*
src/domain/types.ts  wire types from backend to_dict()
src/state/           authStore (zustand), queryClient (+ AppState/NetInfo wiring)
src/auth/            roleRouting (role -> group, canAccess guard), boot, loginErrors
src/realtime/        socket.io manager, role rooms, event -> query invalidation, useRealtimeEvent
src/i18n/            i18next; web/{es,en}.ts copied from frontend/src/i18n; mobile.ts = app-only `mobile` namespace
src/theme/tokens.ts  placeholder tokens (TODO: mirror docs/mobile/design/tokens.json when delivered)
src/test/            render-with-providers + mock server config
```

Route names inside groups are distinct (`floor`, `queue`, `overview`, `diagnostics`) because group folders do not appear in the URL and several `index` screens would all map to `/`.

## Known limitations

- Launcher/splash icons are the Expo template placeholders.
- Backend extensions B1-B4 (idempotency, richer socket payloads, manager room) are not required; the client sends `Idempotency-Key` and handles missing fields.

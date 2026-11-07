# Bola 8 Staff (mobile companion)

Android-first (iOS-ready) Expo SDK 58 / React Native 0.88 / React 19 app for Bola 8 POS staff: waiter, kitchen/bar KDS, manager, admin.
TypeScript strict, Expo Router, TanStack Query, zustand, axios, socket.io-client, i18next (Spanish first).
Package / bundle id: `com.bola8.staff`. Local builds only (no EAS, no stores). Design notes: `docs/mobile/PROJECT_STATE.md`, `docs/mobile/v2/DESIGN_SPEC_V2.md`.

## Features by role

- **Waiter**: Mesas (billar / mesas / barra / rapidos, live pool timers, unsent-order bar), Lista de espera, open table or Rapido, menu with Frecuentes, draft and Enviar (idempotent), Listos, ticket actions (name, transfer, void and qty-decrease with manager PIN), **Cobrar** (efectivo, tarjeta, mixto, propina, print receipt).
- **Kitchen / bar**: single KDS queue with undo, sound, keep-awake, account sheet (language, mute, station switch).
- **Manager**: Resumen, Tickets (open / bills / closed, void, reopen, discount without PIN, edit payment), Piso, Caja (open, gastos, close), Mas; can also work as a waiter.
- **Admin**: everything above plus Reportes (with CSV share) and Sistema (diagnostics, KDS thresholds, waiter-can-close, `min_mobile_version`).

## Setup

- Node 22, npm, JDK 21 (`JAVA_HOME`), Android SDK (`ANDROID_HOME`, platform 34+). Check with `pwsh scripts/mobile/check-android-env.ps1`.
- `cd mobile && npm ci`

## Run

```bash
npx expo start          # Metro
npx expo run:android    # prebuild + build + install on the connected device/emulator
```

First launch asks for the POS address (`GET {base}/api/v1/health` must answer `{"status":"ok"}`). `192.168.1.22` becomes `http://192.168.1.22:8080`.
Emulator -> local docker backend: `http://10.0.2.2:8090`. Phone -> dev machine: `http://<LAN-IP>:8090`. Production: `http://<pos-host>:8080` (nginx).

## Test

```bash
npm test             # jest-expo + React Native Testing Library (CI runs this)
npm run typecheck    # tsc --noEmit (CI runs this)
npm run lint         # expo lint
npm run test:contract  # against a local backend, not in CI
```

## Build

```powershell
pwsh scripts/mobile/build-android-debug.ps1     # -> mobile/dist/bola8-staff-debug.apk
pwsh scripts/mobile/build-android-release.ps1   # signed release APK -> mobile/dist/bola8-staff-<version>-local.apk
```

`android/` and `ios/` are generated (Expo CNG) and gitignored: native config lives in `app.config.ts`, never hand-edit them.
On Windows deep paths break CMake/ninja; the scripts point `android/local.properties` at a private CMake (`BOLA8_CMAKE_DIR`, default `E:\b8\cmake322`).

## Release

1. Bump `APP_VERSION` and `APP_BUILD` in `src/config/version.ts` (single source: `app.config.ts` reads it for `version` and Android `versionCode`; keep `package.json` version equal). `APP_BUILD` must increase on every release.
2. One time: `pwsh scripts/mobile/new-keystore.ps1` creates the venue keystore. Keep it outside the repo and back it up: losing it means phones can never be updated in place.
3. Set `BOLA8_KEYSTORE` (path), `BOLA8_KEYSTORE_PASS`, `BOLA8_KEY_ALIAS`, `BOLA8_KEY_PASS`, then run `build-android-release.ps1`. It fails fast if any is missing. `app.config.ts` rewrites the generated release `signingConfig` to read them from the environment at Gradle time (nothing is written to disk).
4. Copy the APK to the bar machine so nginx serves it at `/mobile/latest.apk`.

## Update path

- Yo (profile) and Sistema show `version (build)`.
- `GET /api/v1/health` may return `server_version`, `min_mobile_version` and `features`. At boot (and on server setup) an app older than `min_mobile_version` is sent to the "Actualiza la app" screen, which opens `{server}/mobile/latest.apk`. Missing fields never block.
- `features` containing `socket_handshake_auth` makes the app stop sending the JWT in the socket `join` payload (it is always sent in the handshake `auth`).

## Security notes

- The LAN backend is plain `http://`, so `app.config.ts` enables Android cleartext traffic (`usesCleartextTraffic`). LAN-only: drop the flag once nginx terminates TLS.
- Tokens live in `expo-secure-store`, never AsyncStorage. The API client never logs tokens, PINs or request bodies.

## Layout

```
app/              Expo Router: _layout (providers), index (boot), setup, login, denied, update-required, role groups
src/components/   UI kit (one design system)
src/features/     per-role feature code (README = ownership contract); pure *Model.ts logic
src/config/       server URL, server info (health), version + versionGate
src/api/          axios client (Bearer, single-flight refresh) + endpoints/*
src/realtime/     socket.io manager, role rooms, event -> query invalidation
src/i18n/         web/{es,en}.ts (copied from frontend) + mobile.ts (app-only strings)
src/theme/        design tokens
```

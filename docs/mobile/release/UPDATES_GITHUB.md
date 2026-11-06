# In-app updates via GitHub Releases (Android, no Play Store)

## Architecture
- Private repo `<login>/bola8-staff-releases` holds one release per build: tag `mobile-v<version>+<build>`,
  assets `bola8-staff-<version>-<build>.apk` and `latest.json` `{version, build, apk, notes, sha256, md5}`.
- The app (`mobile/src/update/`) reads `releases/latest` with a read-only PAT baked in at build time
  (`BOLA8_UPDATES_TOKEN` -> `app.config.ts` `extra.updates`). Newer `build` than `APP_BUILD` -> "Nueva versión disponible" sheet.
- Download goes to the cache dir with progress, md5 is verified on device (expo-file-system cannot sha256 files), then the system installer opens.
  Android also checks the APK signature: an APK signed with a different key is refused.
- Empty token = updates disabled; Profile shows "Actualizaciones no configuradas". iOS is a no-op.

## One-time: create the PAT
GitHub -> Settings -> Developer settings -> Fine-grained tokens -> Generate new token:
- Resource owner: your account. Repository access: **Only select repositories** -> `bola8-staff-releases`.
- Permissions: Repository -> **Contents: Read-only** (Metadata read is added automatically). Nothing else.
- Expiration: no expiry, or 1 year (then add a calendar reminder 2 weeks before; an expired token silently stops updates until a new APK is sideloaded).
- Set it before building: `$env:BOLA8_UPDATES_TOKEN = 'github_pat_...'` (never commit it).

## Publish a new version
1. Bump `mobile/src/config/version.ts` (`APP_VERSION`, and `APP_BUILD` +1 - always strictly increasing) and add a section at the top of `CHANGELOG.md`.
2. Load the signing env, set `BOLA8_UPDATES_TOKEN`, run `scripts/mobile/build-android-release.ps1` (add `-Prebuild` after changing `app.config.ts`), then copy
   `mobile/dist/bola8-staff-<version>-local.apk` to `D:\Projects\Code\billar-pos-dist\bola8-staff-<version>-<build>.apk`.
3. `pwsh scripts/mobile/publish-release.ps1` (`-Apk`, `-Notes`, `-Repo` optional). It refuses to reuse an existing tag.
Optional CI path: push tag `mobile-v<version>+<build>`; `.github/workflows/mobile-release.yml` builds and publishes (secrets listed in its header).

## How phones pick it up
After login the app checks at most every 6 h; Profile -> "Buscar actualización" checks on demand. The server-driven gate
(`min_mobile_version`) screen also offers "Descargar actualización". First install of "Instalar apps desconocidas" is asked by Android once.
The first build that contains the updater (1.2.0 / 3) must be sideloaded; with the token baked in, later builds self-update. Build 3 without a token cannot update itself: publish build 4 with the token.

## Rollback
Delete the release (phones stop seeing it) or, better, publish a fixed build with a higher `APP_BUILD`. Installed phones never downgrade (Android rejects lower versionCode).

## Security
The token is extractable from the APK. It only grants read on the APK repo (private, APK is signed with the venue key), so the worst case is someone downloading our APK.
Rotate by creating a new PAT and shipping a new build. Never put a write-scoped token in the app.

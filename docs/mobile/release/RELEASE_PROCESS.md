# Bola 8 Staff: Android release process

Internal sideloaded APK. Google Play is out of scope.

## Keystore (never in the repo)
- `D:\Projects\Code\billar-pos-secrets\bola8-release.jks`, alias `bola8`, PKCS12 (one password for store and key).
- `D:\Projects\Code\billar-pos-secrets\release-keystore.env` sets the four `BOLA8_*` env vars (PowerShell `$env:` lines).
- Folder ACL is restricted to the current Windows user. BACK IT UP: a different key cannot install over the
  existing app, so losing it forces every phone to uninstall/reinstall.

## Bump version
Edit `mobile/src/config/version.ts`: `APP_VERSION` (semver) and `APP_BUILD` (integer, strictly increasing,
becomes Android versionCode). Never reuse or lower a build number. Commit the bump.

## Build
```powershell
Get-Content D:\Projects\Code\billar-pos-secrets\release-keystore.env -Raw | Invoke-Expression
pwsh scripts/mobile/build-android-release.ps1 -Prebuild   # -Prebuild after app.config.ts changes or first build
```
`assembleRelease` yields an APK (not AAB). The script copies it to `mobile/dist/bola8-staff-<version>-local.apk`
(git-ignored). It uses a short-path CMake (`E:\b8\cmake322`) to avoid the Windows long-path ninja failure.

## Verify
- `apksigner verify --print-certs <apk>` (Android SDK build-tools): signer must be `CN=Bola 8 Staff`.
- `aapt dump badging <apk>`: check `versionName` and `versionCode`.

## Publish
Copy to `D:\Projects\Code\billar-pos-dist\bola8-staff-<version>-<build>.apk` and record the SHA256
(`Get-FileHash`). Never commit the APK, keystore, env file, or `mobile/android/`.

## Distribute
Send the APK by WhatsApp or a Drive link, plus `INSTALL_STAFF_ES.md`. Staff install over the old version.

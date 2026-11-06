# Builds a STANDALONE release APK locally (no EAS, no remote services, no Metro needed at run time)
#   -> mobile/dist/bola8-staff-<version>-local.apk   (git-ignored)
#
# The JS bundle is embedded (release variant), the app is not debuggable. Same long-path workaround as
# build-android-debug.ps1 (private CMake/ninja via android\local.properties; see the header of that script).
#
# SIGNING: requires the venue keystore via env (create it once with scripts\mobile\new-keystore.ps1; keep it OUTSIDE the repo):
#   BOLA8_KEYSTORE (path), BOLA8_KEYSTORE_PASS, BOLA8_KEY_ALIAS, BOLA8_KEY_PASS
# app.config.ts rewrites the generated release signingConfig to read them from the environment at Gradle time.
#
# Usage:  pwsh scripts/mobile/build-android-release.ps1 [-Prebuild] [-Archs x86_64,arm64-v8a] [-CmakeDir E:\b8\cmake322]
#   -Prebuild  re-run `expo prebuild --clean` first (needed after changing app.config.ts: permissions, backup flag...)
param(
  [switch]$Prebuild,
  [string]$Archs = 'x86_64,arm64-v8a',
  [string]$CmakeDir = $(if ($env:BOLA8_CMAKE_DIR) { $env:BOLA8_CMAKE_DIR } else { 'E:\b8\cmake322' })
)
$ErrorActionPreference = 'Stop'
$env:EXPO_NO_TELEMETRY = '1'
$mobile = (Resolve-Path "$PSScriptRoot\..\..\mobile").Path

$missing = 'BOLA8_KEYSTORE', 'BOLA8_KEYSTORE_PASS', 'BOLA8_KEY_ALIAS', 'BOLA8_KEY_PASS' | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
if ($missing) { throw "Release signing needs env vars: $($missing -join ', '). Create a keystore with scripts\mobile\new-keystore.ps1 and set them." }
if (-not (Test-Path -LiteralPath $env:BOLA8_KEYSTORE)) { throw "BOLA8_KEYSTORE not found: $env:BOLA8_KEYSTORE" }
$env:BOLA8_KEYSTORE = (Resolve-Path -LiteralPath $env:BOLA8_KEYSTORE).Path

$verMatch = Select-String -Path "$mobile\src\config\version.ts" -Pattern "APP_VERSION\s*=\s*'([^']+)'"
if (-not $verMatch) { throw 'could not read APP_VERSION from src/config/version.ts' }
$version = $verMatch.Matches[0].Groups[1].Value
$apkOut = Join-Path $mobile "dist\bola8-staff-$version-local.apk"

Push-Location $mobile
try {
  # The signing hook lives in app.config.ts: regenerate android/ if it was generated without it.
  $needsPrebuild = $Prebuild -or -not (Test-Path "$mobile\android") -or -not (Select-String -Path "$mobile\android\app\build.gradle" -Pattern 'BOLA8_KEYSTORE' -Quiet)
  if ($needsPrebuild) {
    $ep = @('expo', 'prebuild', '--platform', 'android', '--no-install', '--clean')
    Write-Host "npx $($ep -join ' ')"
    & npx @ep
    if ($LASTEXITCODE) { throw 'expo prebuild failed' }
  }

  $lp = "$mobile\android\local.properties"
  if (Test-Path $CmakeDir) {
    $esc = $CmakeDir.Replace([char]92, '/').Replace(':', '\:')  # forward slashes survive properties-file escaping
    Set-Content -Path $lp -Value "cmake.dir=$esc" -Encoding ascii
    Write-Host "local.properties: cmake.dir=$esc"
  } else {
    Write-Host "CMake override '$CmakeDir' not found: using the SDK CMake (needs a short project path)."
  }

  Push-Location "$mobile\android"
  try {
    & .\gradlew.bat assembleRelease "-PreactNativeArchitectures=$Archs" --console=plain
    if ($LASTEXITCODE) { throw 'gradle assembleRelease failed' }
  } finally {
    Pop-Location
  }

  $apk = "$mobile\android\app\build\outputs\apk\release\app-release.apk"
  if (-not (Test-Path $apk)) { throw "APK not found: $apk" }
  New-Item -ItemType Directory -Force (Split-Path $apkOut) | Out-Null
  Copy-Item $apk $apkOut -Force
  $mb = [math]::Round((Get-Item $apkOut).Length / 1MB, 1)
  Write-Host "OK: $apkOut ($mb MB, ABIs: $Archs), signed with $env:BOLA8_KEYSTORE"
} finally {
  Pop-Location
}

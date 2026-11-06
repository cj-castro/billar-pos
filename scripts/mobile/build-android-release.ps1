# Builds a STANDALONE release APK locally (no EAS, no remote services, no Metro needed at run time)
#   -> mobile/dist/bola8-staff-<version>-local.apk   (git-ignored)
#
# The JS bundle is embedded (release variant), the app is not debuggable. Same long-path workaround as
# build-android-debug.ps1 (private CMake/ninja via android\local.properties; see the header of that script).
#
# WARNING - LOCAL USE ONLY: the Expo template signs the release variant with its PUBLIC DEBUG KEYSTORE. Anyone can build
# an APK that Android installs as an update of this app. Do NOT put this APK on staff phones. Before distributing,
# re-sign with a venue-owned keystore kept outside the repo (see docs/mobile/architecture/SECURITY_MODEL.md, Residual
# risks, SEC-06). This script never creates or uses a production keystore.
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

Write-Warning 'LOCAL USE ONLY: this release APK is signed with the public debug keystore. Re-sign with a venue-owned keystore before it goes anywhere near a staff phone.'

$version = (Select-String -Path "$mobile\app.config.ts" -Pattern "^\s*version:\s*'([^']+)'").Matches[0].Groups[1].Value
if (-not $version) { throw 'could not read version from app.config.ts' }
$apkOut = Join-Path $mobile "dist\bola8-staff-$version-local.apk"

Push-Location $mobile
try {
  if ($Prebuild -or -not (Test-Path "$mobile\android")) {
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
  Write-Host "OK: $apkOut ($mb MB, ABIs: $Archs)"
  Write-Warning 'Signed with the debug keystore: LOCAL/EMULATOR USE ONLY.'
} finally {
  Pop-Location
}

# Builds the Bola 8 Staff debug APK locally (no EAS, no remote services) -> mobile/dist/bola8-staff-debug.apk
#
# Long-path problem (Windows): the native modules (gesture-handler, screens, worklets, reanimated) fail in CMake/ninja with
# "ninja: error: mkdir(...): No such file or directory" when the project sits under a deep path such as
# D:\Projects\Code\billar-pos-worktrees\...\mobile, because the Android SDK's ninja 1.10.2 is not long-path aware.
#
# Fix used here (no project copy): android\local.properties points cmake.dir at a private CMake 3.22 whose
# bin\ninja.exe is ninja >= 1.13 (long-path aware). Default location E:\b8\cmake322; override with -CmakeDir or
# $env:BOLA8_CMAKE_DIR. The file is rewritten on every run because `expo prebuild --clean` regenerates android\.
# If the directory does not exist the SDK CMake is used (fine on short paths).
#
# Why not `subst`: we tried mapping the worktree to a short drive (W:\mobile). Node resolves subst drives to their
# real target (realpath), so Expo autolinking emits D:\ module paths while Gradle runs from W:\, and the RN codegen
# step fails with "this and base files have different roots". Mapping the mobile folder itself as a drive root also
# breaks expo-modules-autolinking ("Couldn't find package.json up from path W:\"). `-UseSubst` therefore does not exist.
#
# Usage:  pwsh scripts/mobile/build-android-debug.ps1 [-Clean] [-Archs x86_64,arm64-v8a] [-CmakeDir E:\b8\cmake322]
param(
  [switch]$Clean,
  # Emulator = x86_64, phones = arm64-v8a. All four ABIs roughly double build time and APK size.
  [string]$Archs = 'x86_64,arm64-v8a',
  [string]$CmakeDir = $(if ($env:BOLA8_CMAKE_DIR) { $env:BOLA8_CMAKE_DIR } else { 'E:\b8\cmake322' })
)
$ErrorActionPreference = 'Stop'
$env:EXPO_NO_TELEMETRY = '1'
$mobile = (Resolve-Path "$PSScriptRoot\..\..\mobile").Path
$apkOut = Join-Path $mobile 'dist\bola8-staff-debug.apk'

Push-Location $mobile
try {
  if ($Clean -or -not (Test-Path "$mobile\android")) {
    $ep = @('expo', 'prebuild', '--platform', 'android', '--no-install')
    if ($Clean) { $ep += '--clean' }
    Write-Host "npx $($ep -join ' ')"
    & npx @ep
    if ($LASTEXITCODE) { throw 'expo prebuild failed' }
  }

  # Private CMake/ninja (see header). Only cmake.dir; sdk.dir comes from ANDROID_HOME.
  $lp = "$mobile\android\local.properties"
  if (Test-Path $CmakeDir) {
    $esc = $CmakeDir.Replace('\', '\\').Replace(':', '\:')
    Set-Content -Path $lp -Value "cmake.dir=$esc" -Encoding ascii
    Write-Host "local.properties: cmake.dir=$esc"
  } else {
    Write-Host "CMake override '$CmakeDir' not found: using the SDK CMake (needs a short project path)."
  }

  Push-Location "$mobile\android"
  try {
    & .\gradlew.bat assembleDebug "-PreactNativeArchitectures=$Archs" --console=plain
    if ($LASTEXITCODE) { throw 'gradle assembleDebug failed' }
  } finally {
    Pop-Location
  }

  $apk = "$mobile\android\app\build\outputs\apk\debug\app-debug.apk"
  if (-not (Test-Path $apk)) { throw "APK not found: $apk" }
  New-Item -ItemType Directory -Force (Split-Path $apkOut) | Out-Null
  Copy-Item $apk $apkOut -Force
  $mb = [math]::Round((Get-Item $apkOut).Length / 1MB, 1)
  Write-Host "OK: $apkOut ($mb MB, ABIs: $Archs)"
} finally {
  Pop-Location
}

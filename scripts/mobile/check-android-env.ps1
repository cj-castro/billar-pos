# Prints Android dev env status; exits 1 if an essential piece is missing.
param([string]$Avd = 'billar_mobile_api35')
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$fail = 0
function Check($name, $ok, $detail) {
  Write-Host ("{0,-14} {1,-5} {2}" -f $name, $(if ($ok) {'OK'} else {'FAIL'}), $detail)
  if (-not $ok) { $script:fail = 1 }
}
$java = if ($env:JAVA_HOME) { "$env:JAVA_HOME\bin\java.exe" } else { 'java' }
$jv = try { (& $java -version 2>&1 | Select-Object -First 1) } catch { $null }
Check 'java'           ([bool]$jv) "$jv"
Check 'ANDROID_HOME'   (Test-Path $sdk) $sdk
$adb = "$sdk\platform-tools\adb.exe"
Check 'platform-tools' (Test-Path $adb) $(if (Test-Path $adb) { (& $adb version)[0] } else { 'missing' })
$emu = "$sdk\emulator\emulator.exe"
$emuV = if (Test-Path $emu) { ((& $emu -version 2>&1 | Select-String 'Android emulator version' | Select-Object -First 1).Line) } else { 'missing' }
Check 'emulator'       (Test-Path $emu) $emuV
Check 'system-image'   ((Get-ChildItem "$sdk\system-images" -Directory -ErrorAction SilentlyContinue).Count -gt 0) 'android-35 google_apis x86_64'
$avds = if (Test-Path $emu) { & $emu -list-avds } else { @() }
Check 'AVD'            ($avds -contains $Avd) "$Avd (all: $($avds -join ', '))"
$acc = if (Test-Path $emu) { (& $emu -accel-check 2>&1) -join ' ' } else { '' }
Check 'accel'          ($acc -match 'usable') ($acc -replace '\s+', ' ')
$devs = if (Test-Path $adb) { (& $adb devices | Select-String 'device$') } else { @() }
Write-Host ("{0,-14} {1}" -f 'running', $(if ($devs) { ($devs -join '; ') } else { 'no emulator running (info only)' }))
exit $fail

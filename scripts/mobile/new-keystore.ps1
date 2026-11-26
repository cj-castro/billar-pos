# Creates the release keystore ONCE. Store it OUTSIDE the repo and back it up: losing it means staff phones can never
# be updated in place (a different key cannot install over the old app).
# Usage: pwsh scripts/mobile/new-keystore.ps1 [-Path C:\secure\bola8-release.jks] [-Alias bola8]
param(
  [string]$Path = (Join-Path $HOME 'bola8-release.jks'),
  [string]$Alias = 'bola8'
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Path) { throw "Refusing to overwrite existing keystore: $Path" }
if ($Path -like "$((Resolve-Path "$PSScriptRoot\..\..").Path)*") { throw 'Keep the keystore outside the repository.' }
if (-not (Get-Command keytool -ErrorAction SilentlyContinue)) { throw 'keytool not found: set JAVA_HOME / add the JDK bin to PATH.' }

$pass = Read-Host 'Keystore password (min 6 chars)' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass))
if ($plain.Length -lt 6) { throw 'Password too short.' }

& keytool -genkeypair -v -storetype PKCS12 -keystore $Path -alias $Alias -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass $plain -keypass $plain -dname 'CN=Bola 8 Staff, O=Bola 8 Pool Club'
if ($LASTEXITCODE) { throw 'keytool failed' }

Write-Host "`nKeystore created: $Path`nSet these before running build-android-release.ps1:`n"
Write-Host "  `$env:BOLA8_KEYSTORE      = '$Path'"
Write-Host "  `$env:BOLA8_KEYSTORE_PASS = '<the password you just typed>'"
Write-Host "  `$env:BOLA8_KEY_ALIAS     = '$Alias'"
Write-Host "  `$env:BOLA8_KEY_PASS      = '<same password (PKCS12 uses one)>'"

# Publishes the built APK as a GitHub Release in the PRIVATE releases repo; phones self-update from it (see docs/mobile/release/UPDATES_GITHUB.md).
#   tag mobile-v<version>+<build>, assets: bola8-staff-<version>-<build>.apk + latest.json {version,build,apk,notes,sha256,md5}
# Usage: pwsh scripts/mobile/publish-release.ps1 [-Apk <path>] [-Notes "text"] [-Repo owner/name]
# Needs `gh` logged in with write access to the releases repo. Fails fast if the tag already exists (never overwrite a published build).
param(
  [string]$Apk,
  [string]$Notes,
  [string]$Repo
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$ver = Get-Content "$root\mobile\src\config\version.ts" -Raw
if ($ver -notmatch "APP_VERSION\s*=\s*'([^']+)'") { throw 'APP_VERSION not found in version.ts' }
$version = $Matches[1]
if ($ver -notmatch 'APP_BUILD\s*=\s*(\d+)') { throw 'APP_BUILD not found in version.ts' }
$build = [int]$Matches[1]
$name = "bola8-staff-$version-$build.apk"
if (-not $Apk) { $Apk = "D:\Projects\Code\billar-pos-dist\$name" }
if (-not (Test-Path -LiteralPath $Apk)) { throw "APK not found: $Apk (build it with scripts\mobile\build-android-release.ps1)" }
if (-not $Repo) { $Repo = "$(gh api user --jq .login)/bola8-staff-releases" }
$tag = "mobile-v$version+$build"

gh release view $tag --repo $Repo *> $null
if ($LASTEXITCODE -eq 0) { throw "Release $tag already exists in $Repo. Bump APP_BUILD in version.ts (builds are immutable)." }

if (-not $Notes) {
  # top section of the changelog: from the first '## ' heading to the next one
  $cl = Get-Content "$root\docs\mobile\release\CHANGELOG.md" -Raw
  $Notes = if ($cl -match '(?ms)^##\s.*?(?=^##\s|\z)') { $Matches[0].Trim() } else { "Bola 8 Staff $version ($build)" }
}
# the sheet shows notes verbatim: strip the heading line
$sheetNotes = ($Notes -replace '(?m)^##.*\r?\n', '').Trim()

$tmp = Join-Path ([IO.Path]::GetTempPath()) "b8rel-$([guid]::NewGuid())"
New-Item -ItemType Directory $tmp | Out-Null
try {
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $Apk).Hash.ToLower()
  $md5 = (Get-FileHash -Algorithm MD5 -LiteralPath $Apk).Hash.ToLower()
  $assetApk = Join-Path $tmp $name   # asset name must match latest.json "apk"
  Copy-Item -LiteralPath $Apk $assetApk
  $latest = Join-Path $tmp 'latest.json'
  [ordered]@{ version = $version; build = $build; apk = $name; notes = $sheetNotes; sha256 = $sha; md5 = $md5 } | ConvertTo-Json | Set-Content -Path $latest -Encoding utf8NoBOM
  $notesFile = Join-Path $tmp 'notes.md'
  Set-Content -Path $notesFile -Value $Notes -Encoding utf8NoBOM
  gh release create $tag $assetApk $latest --repo $Repo --title "Bola 8 Staff $version ($build)" --notes-file $notesFile
  if ($LASTEXITCODE) { throw 'gh release create failed' }
  Write-Host "OK: https://github.com/$Repo/releases/tag/$([uri]::EscapeDataString($tag))  sha256=$sha"
} finally {
  Remove-Item -Recurse -Force $tmp
}

#Requires -Version 5.1
<#
.SYNOPSIS
  Full self-contained build pipeline for BilliardBar POS desktop installer.

.DESCRIPTION
  Produces a single setup EXE that works on a virgin Windows machine:
    1. Builds the React frontend (npm run build)
    2. Runs PyInstaller to bundle the Flask backend into a standalone exe
    3. Runs electron-builder to package the Electron shell (win unpacked dir)
       — electron-builder copies the PyInstaller output into resources/backend/
    4. Downloads VC++ 2022 Redistributable x64 (if not already present)
    5. Generates a WiX file-harvest from the electron win-unpacked directory
    6. Compiles the WiX MSI  (installer.wxs + harvested fragment)
    7. Compiles the WiX Bundle (bundle.wxs → BilliardBarPOS-Setup.exe)

.PREREQUISITES
  - Python 3.11+ with pip
      pip install pyinstaller
      pip install -r backend\requirements.txt
  - Node.js 20+
  - WiX v4 CLI:
      dotnet tool install --global wix
      wix extension add --global WixToolset.UI.wixext
      wix extension add --global WixToolset.Util.wixext
      wix extension add --global WixToolset.Bal.wixext

.USAGE
  cd installer
  .\build-full.ps1
#>

$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot -Parent
$outDir  = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# ---------------------------------------------------------------------------
# Helper: generate a WiX v4 file-harvest fragment from a source directory.
# Produces a <ComponentGroup Id="$ComponentGroupId"> referencing every file
# found under $SourceDir, using flat <DirectoryRef> blocks per subdirectory.
# ---------------------------------------------------------------------------
function New-WixHarvest {
    param(
        [Parameter(Mandatory)][string]$SourceDir,
        [Parameter(Mandatory)][string]$ComponentGroupId,
        [Parameter(Mandatory)][string]$RootDirRef,
        [Parameter(Mandatory)][string]$OutFile
    )

    $src      = (Resolve-Path $SourceDir).Path.TrimEnd('\')
    $allFiles = @(Get-ChildItem -Path $src -Recurse -File | Sort-Object FullName)

    # Build a directory map: relative path => { Id, Name, ParentPath, Files[] }
    $dirs = [ordered]@{}
    $dirs[''] = @{ Id = $RootDirRef; Name = ''; ParentPath = $null; Files = [System.Collections.ArrayList]::new() }

    foreach ($file in $allFiles) {
        $relFile = $file.FullName.Substring($src.Length + 1)
        $relDir  = Split-Path $relFile -Parent
        if (-not $relDir) { $relDir = '' }

        # Ensure every ancestor directory exists in the map
        $parts   = if ($relDir) { $relDir -split '\\' } else { @() }
        $cumPath = ''
        foreach ($part in $parts) {
            $parentPath = $cumPath
            $cumPath    = if ($cumPath) { "$cumPath\$part" } else { $part }
            if (-not $dirs.ContainsKey($cumPath)) {
                $safe = $cumPath -replace '[\\. \-\(\)]', '_' -replace '[^a-zA-Z0-9_]', '_'
                $dirs[$cumPath] = @{
                    Id         = "hd_$safe"
                    Name       = $part
                    ParentPath = $parentPath
                    Files      = [System.Collections.ArrayList]::new()
                }
            }
        }
        $null = $dirs[$relDir].Files.Add($file)
    }

    $xml      = [System.Text.StringBuilder]::new()
    $compRefs = [System.Collections.ArrayList]::new()
    $idx      = 0

    $null = $xml.AppendLine('<?xml version="1.0" encoding="utf-8"?>')
    $null = $xml.AppendLine('<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">')
    $null = $xml.AppendLine('  <Fragment>')

    # Emit one <DirectoryRef> block per directory (flat pattern, valid WiX v4)
    foreach ($dirPath in $dirs.Keys) {
        $dir = $dirs[$dirPath]
        $null = $xml.AppendLine("    <DirectoryRef Id=`"$($dir.Id)`">")

        # Declare immediate child directories (empty; content comes from their own block)
        foreach ($childPath in ($dirs.Keys | Where-Object {
            $_ -and $dirs[$_].ParentPath -eq $dirPath
        } | Sort-Object)) {
            $child = $dirs[$childPath]
            $null = $xml.AppendLine("      <Directory Id=`"$($child.Id)`" Name=`"$($child.Name)`" />")
        }

        # One component per file
        foreach ($file in $dir.Files) {
            $cid  = "hc_$idx"; $idx++
            $guid = [System.Guid]::NewGuid().ToString().ToUpper()
            $null = $xml.AppendLine("      <Component Id=`"$cid`" Guid=`"$guid`">")
            $null = $xml.AppendLine("        <File Source=`"$($file.FullName)`" />")
            $null = $xml.AppendLine("      </Component>")
            $null = $compRefs.Add($cid)
        }

        $null = $xml.AppendLine("    </DirectoryRef>")
    }

    # Component group collects all harvested components
    $null = $xml.AppendLine("    <ComponentGroup Id=`"$ComponentGroupId`">")
    foreach ($ref in $compRefs) {
        $null = $xml.AppendLine("      <ComponentRef Id=`"$ref`" />")
    }
    $null = $xml.AppendLine("    </ComponentGroup>")
    $null = $xml.AppendLine('  </Fragment>')
    $null = $xml.AppendLine('</Wix>')

    [System.IO.File]::WriteAllText($OutFile, $xml.ToString(), [System.Text.Encoding]::UTF8)
    Write-Host "  Harvested $idx files from $(Split-Path $SourceDir -Leaf)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Step 1 — React frontend
# ---------------------------------------------------------------------------
Write-Host "`n[1/7] Building React frontend..." -ForegroundColor Cyan
Set-Location "$root\frontend"
npm ci --silent
if ($LASTEXITCODE -ne 0) { throw "npm ci failed in frontend" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

# ---------------------------------------------------------------------------
# Step 2 — PyInstaller backend bundle
# ---------------------------------------------------------------------------
Write-Host "`n[2/7] Building PyInstaller backend bundle..." -ForegroundColor Cyan
Set-Location "$root\backend"
pyinstaller desktop.spec --noconfirm --clean
if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }

$backendDist = "$root\backend\dist\billiardbar-backend"
if (-not (Test-Path $backendDist)) {
    throw "PyInstaller output not found at: $backendDist"
}
Write-Host "  Backend bundle: $backendDist" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# Step 3 — Electron packaging (electron-builder copies backend via extraResources)
# ---------------------------------------------------------------------------
Write-Host "`n[3/7] Packaging Electron app (electron-builder)..." -ForegroundColor Cyan
Set-Location "$root\electron"
npm ci --silent
if ($LASTEXITCODE -ne 0) { throw "npm ci failed in electron" }
npm run build        # runs: electron-builder --win dir
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }

$winUnpacked = "$root\electron\dist\win-unpacked"
if (-not (Test-Path $winUnpacked)) {
    throw "electron-builder win-unpacked not found at: $winUnpacked"
}
Write-Host "  Electron output: $winUnpacked" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# Step 4 — Download VC++ 2022 Redistributable x64 (if not cached)
# ---------------------------------------------------------------------------
Write-Host "`n[4/7] Checking VC++ 2022 Redistributable..." -ForegroundColor Cyan
$vcRedist = Join-Path $outDir 'vc_redist.x64.exe'
if (-not (Test-Path $vcRedist)) {
    Write-Host "  Downloading vc_redist.x64.exe..." -ForegroundColor DarkGray
    $vcUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
    Invoke-WebRequest -Uri $vcUrl -OutFile $vcRedist -UseBasicParsing
    Write-Host "  Downloaded: $vcRedist" -ForegroundColor DarkGray
} else {
    Write-Host "  Cached: $vcRedist" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Step 5 — Harvest Electron win-unpacked into a WiX fragment
# ---------------------------------------------------------------------------
Write-Host "`n[5/7] Harvesting Electron app files for WiX..." -ForegroundColor Cyan
$harvestFile = Join-Path $PSScriptRoot 'harvested.wxs'
New-WixHarvest `
    -SourceDir       $winUnpacked `
    -ComponentGroupId 'ElectronApp' `
    -RootDirRef      'INSTALLFOLDER' `
    -OutFile         $harvestFile

# ---------------------------------------------------------------------------
# Step 6 — Compile WiX MSI
# ---------------------------------------------------------------------------
Write-Host "`n[6/7] Compiling WiX MSI..." -ForegroundColor Cyan
Set-Location $PSScriptRoot

wix extension add WixToolset.UI.wixext   --global 2>$null
wix extension add WixToolset.Util.wixext --global 2>$null
wix extension add WixToolset.Bal.wixext  --global 2>$null

$msiOut = Join-Path $outDir 'BilliardBarPOS-Setup.msi'

wix build `
    installer.wxs `
    DbConfigDlg.wxs `
    WixUI_DbConfig.wxs `
    harvested.wxs `
    -ext WixToolset.UI.wixext `
    -ext WixToolset.Util.wixext `
    -arch x64 `
    -out $msiOut

if ($LASTEXITCODE -ne 0) { throw "WiX MSI build failed" }
Write-Host "  MSI: $msiOut" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# Step 7 — Compile WiX Bundle (Bootstrapper)
# ---------------------------------------------------------------------------
Write-Host "`n[7/7] Compiling WiX Bundle..." -ForegroundColor Cyan

# Bundle expects vc_redist.x64.exe and the MSI in the same working directory
Copy-Item $vcRedist  $PSScriptRoot -Force
Copy-Item $msiOut    $PSScriptRoot -Force

$bundleOut = Join-Path $outDir 'BilliardBarPOS-Setup.exe'

wix build `
    bundle.wxs `
    -ext WixToolset.Bal.wixext `
    -ext WixToolset.Util.wixext `
    -out $bundleOut

if ($LASTEXITCODE -ne 0) { throw "WiX Bundle build failed" }

# Cleanup temp copies from installer/ dir
Remove-Item (Join-Path $PSScriptRoot 'vc_redist.x64.exe')    -ErrorAction SilentlyContinue
Remove-Item (Join-Path $PSScriptRoot 'BilliardBarPOS-Setup.msi') -ErrorAction SilentlyContinue

Write-Host "`n✅ Build complete!" -ForegroundColor Green
Write-Host "   Bundle:   $bundleOut"
Write-Host "   MSI only: $msiOut`n"

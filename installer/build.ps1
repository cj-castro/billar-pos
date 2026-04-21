<#
.SYNOPSIS
  Build the BilliardBar POS Windows installer using WiX v4.

.DESCRIPTION
  1. Builds the React frontend (npm run build)
  2. Installs Electron dependencies
  3. Compiles WiX sources into an .msi installer

.PREREQUISITES
  - Node.js 20+
  - Python 3.11+ with pip
  - WiX v4 CLI:  dotnet tool install --global wix
  - WiX UI ext:  wix extension add --global WixToolset.UI.wixext
  - WiX Util ext: wix extension add --global WixToolset.Util.wixext

.USAGE
  cd installer
  .\build.ps1
#>

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

Write-Host "`n[1/4] Building React frontend..." -ForegroundColor Cyan
Set-Location "$root\frontend"
npm install --silent
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

Write-Host "`n[2/4] Installing Electron dependencies..." -ForegroundColor Cyan
Set-Location "$root\electron"
npm install --silent
if ($LASTEXITCODE -ne 0) { throw "Electron npm install failed" }

Write-Host "`n[3/4] Compiling WiX installer..." -ForegroundColor Cyan
Set-Location $PSScriptRoot

# Ensure WiX extensions are available
wix extension add WixToolset.UI.wixext -acceptEula wix7    --global 2>$null
wix extension add WixToolset.Util.wixext -acceptEula wix7  --global 2>$null

$outDir = "$root\installer\out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

wix build `
  installer.wxs `
  DbConfigDlg.wxs `
  WixUI_DbConfig.wxs `
  -ext WixToolset.UI.wixext `
  -out "$outDir\BilliardBarPOS-Setup.msi" -acceptEula wix7

if ($LASTEXITCODE -ne 0) { throw "WiX build failed" }

Write-Host "`n[4/4] Done!" -ForegroundColor Green
Write-Host "  Installer: $outDir\BilliardBarPOS-Setup.msi`n"

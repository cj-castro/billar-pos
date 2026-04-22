#Requires -Version 5.1
<#
.SYNOPSIS
  Full self-contained build pipeline for BilliardBar POS desktop installer.

.DESCRIPTION
  Produces a single setup EXE (NSIS) that works on a virgin Windows machine
  (PostgreSQL must be pre-installed — the app configures the connection on
  first launch):
    1. Builds the React frontend  (npm run build)
    2. Runs PyInstaller to bundle the Flask backend into a standalone exe
    3. Runs electron-builder NSIS to produce BilliardBarPOS-Setup.exe
    4. Copies the installer to installer\out\

.PREREQUISITES
  - Python 3.11+ with pip
      pip install pyinstaller
      pip install -r backend\requirements.txt
  - Node.js 20+
  - No WiX or any other installer toolchain required.

.USAGE
  cd installer
  .\build-full.ps1
#>

$ErrorActionPreference = 'Stop'
$root   = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# ---------------------------------------------------------------------------
# Step 1 — React frontend
# ---------------------------------------------------------------------------
Write-Host "`n[1/4] Building React frontend..." -ForegroundColor Cyan
Set-Location "$root\frontend"
npm ci --silent
if ($LASTEXITCODE -ne 0) { throw "npm ci failed in frontend" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

# ---------------------------------------------------------------------------
# Step 2 — PyInstaller backend bundle
# ---------------------------------------------------------------------------
Write-Host "`n[2/4] Building PyInstaller backend bundle..." -ForegroundColor Cyan
Set-Location "$root\backend"
pyinstaller desktop.spec --noconfirm --clean
if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }

$backendDist = "$root\backend\dist\billiardbar-backend"
if (-not (Test-Path $backendDist)) {
    throw "PyInstaller output not found at: $backendDist"
}
Write-Host "  Backend bundle: $backendDist" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# Step 3 — electron-builder NSIS installer
# ---------------------------------------------------------------------------
Write-Host "`n[3/4] Building NSIS installer with electron-builder..." -ForegroundColor Cyan
Set-Location "$root\electron"
npm install --silent
if ($LASTEXITCODE -ne 0) { throw "npm install failed in electron" }

# electron-builder --win nsis produces dist\BilliardBarPOS-Setup.exe
npm run build
if ($LASTEXITCODE -ne 0) { throw "electron-builder NSIS build failed" }

$nsisExe = "$root\electron\dist\BilliardBarPOS-Setup.exe"
if (-not (Test-Path $nsisExe)) {
    throw "NSIS installer not found at: $nsisExe"
}
Write-Host "  Installer: $nsisExe" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# Step 4 — Copy to installer\out\
# ---------------------------------------------------------------------------
Write-Host "`n[4/4] Copying installer to out\..." -ForegroundColor Cyan
$dest = Join-Path $outDir 'BilliardBarPOS-Setup.exe'
Copy-Item $nsisExe $dest -Force
Write-Host "  Output: $dest" -ForegroundColor DarkGray

Write-Host "`n✅ Build complete!" -ForegroundColor Green
Write-Host "   Installer: $dest`n"

# Dot-sourced by run-*.ps1: env, TZ strip, paths. Not run directly.
param([string]$Root, [string]$EnvFile)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\PosCommon.psm1') -Force
Import-PosEnv -Path $EnvFile
# TZ must never reach Python (on Windows it would turn naive time into UTC) - also strips an inherited machine/service TZ
[Environment]::SetEnvironmentVariable('TZ', $null, 'Process')
$env:PYTHONUTF8 = '1'
$env:PYTHONUNBUFFERED = '1'
if (-not $env:BACKEND_DIR) { $env:BACKEND_DIR = Join-Path $Root 'app\backend' }
$script:Py = Join-Path $Root 'venv\Scripts\python.exe'
Set-Location $env:BACKEND_DIR
$ErrorActionPreference = 'Continue'   # native stderr must not throw (PS 5.1); steps check $LASTEXITCODE

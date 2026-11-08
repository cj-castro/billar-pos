# Dot-sourced by run-*.ps1: env, TZ strip, paths. Not run directly.
param([string]$Root, [string]$EnvFile)
$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSScriptRoot '..\PosCommon.psm1') -Force
    Import-PosEnv -Path $EnvFile
    # TZ must never reach Python (on Windows it would turn naive time into UTC) - also strips an inherited machine/service TZ
    [Environment]::SetEnvironmentVariable('TZ', $null, 'Process')
    $env:PYTHONUTF8 = '1'
    $env:PYTHONUNBUFFERED = '1'
    if (-not $env:BACKEND_DIR) { $env:BACKEND_DIR = Join-Path $Root 'app\backend' }
    $script:Py = Join-Path $Root 'venv\Scripts\python.exe'
    if (-not (Test-Path $Py)) { throw "python not found: $Py" }
    Set-Location $env:BACKEND_DIR
} catch {
    "{0} STARTUP FAILED at setup: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message
    exit 1
}
$ErrorActionPreference = 'Continue'   # native stderr must not throw (PS 5.1); steps check $LASTEXITCODE

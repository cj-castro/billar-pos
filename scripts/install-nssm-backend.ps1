# =============================================================================
# install-nssm-backend.ps1
# BilliardBar Backend - installs as a REAL Windows Service using NSSM
#
# [OK] Starts at BOOT (no login required - even headless servers)
# [OK] Auto-restarts on crash
# [OK] Manageable via services.msc or "nssm start/stop/restart BilliardBarBackend"
# [OK] Runs backend/service_entry.py, which sequences flask init-db -> seed.py
#      -> socketio.run() every start, matching backend/entrypoint.sh's
#      idempotent Docker startup behavior (D-05/D-06) -- gunicorn cannot run
#      natively on Windows, so this replaces it with wsgi.py's own eventlet
#      server started in-process.
#
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd <repo root>
#   4. .\scripts\install-nssm-backend.ps1
#
# Secrets: this script never hardcodes secret values. All environment
# variables (passwords, DB credentials, SMTP creds, etc.) are read at install
# time from the git-ignored repo-root .env file via Read-DotEnv below, then
# forwarded into the NSSM service's AppEnvironmentExtra block.
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendDir  = Join-Path $BaseDir "backend"
$VenvPy      = Join-Path $BackendDir "venv\Scripts\pythonw.exe"
$VenvPip     = Join-Path $BackendDir "venv\Scripts\pip.exe"
$Script      = Join-Path $BackendDir "service_entry.py"
$Requirements = Join-Path $BackendDir "requirements.txt"
$EnvFile     = Join-Path $BaseDir ".env"
$ServiceName = "BilliardBarBackend"
$NssmExe     = $null

Write-Host "`n=== BilliardBar Backend - Windows Service Installer ===" -ForegroundColor Cyan
Write-Host "   Service will start at BOOT - no login required.`n"

# ---------------------------------------------------------------------------
# Read-DotEnv: parses the repo-root .env into a hashtable.
#   - Skips blank lines and lines starting with #
#   - Splits each remaining line on the FIRST = into key/value
#   - Strips a single layer of surrounding quotes from the value, if present
# Secrets stay in the git-ignored .env file and are never hardcoded here.
# ---------------------------------------------------------------------------
function Read-DotEnv {
    param([string]$Path)
    $envVars = @{}
    if (-not (Test-Path $Path)) {
        Write-Host "   WARNING: .env not found at $Path -- forwarding no vars from it." -ForegroundColor Yellow
        return $envVars
    }
    Get-Content -Path $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if ($value.Length -ge 2 -and (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            )) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $envVars[$key] = $value
    }
    return $envVars
}

# -- Step 1: Find or install NSSM ---------------------------------------------
Write-Host "[1/6] Locating NSSM..."
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                  "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                  "$BaseDir\scripts\nssm.exe")) {
    try {
        $v = & $p version 2>&1
        if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
    } catch {}
}

if (-not $NssmExe) {
    Write-Host "   NSSM not found. Trying to install via Chocolatey..." -ForegroundColor Yellow
    $chocoOk = $false
    try {
        & choco install nssm -y --no-progress 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $NssmExe = "nssm"; $chocoOk = $true }
    } catch {}

    if (-not $chocoOk) {
        Write-Host "   Chocolatey not available. Downloading NSSM directly..." -ForegroundColor Yellow
        $nssmZip  = "$env:TEMP\nssm.zip"
        $nssmDir  = "$env:TEMP\nssm_extract"
        $nssmDest = "$BaseDir\scripts\nssm.exe"
        try {
            Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" `
                -OutFile $nssmZip -UseBasicParsing -TimeoutSec 30
            Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force
            $exe = Get-ChildItem -Path $nssmDir -Recurse -Filter "nssm.exe" |
                   Where-Object { $_.FullName -match 'win64' } |
                   Select-Object -First 1
            if (-not $exe) {
                $exe = Get-ChildItem -Path $nssmDir -Recurse -Filter "nssm.exe" |
                       Select-Object -First 1
            }
            Copy-Item $exe.FullName -Destination $nssmDest -Force
            $NssmExe = $nssmDest
            Write-Host "   NSSM downloaded to $nssmDest" -ForegroundColor Green
        } catch {
            Write-Host "   Failed to download NSSM: $_" -ForegroundColor Red
            Write-Host "   Manual install: https://nssm.cc/download -> copy nssm.exe to scripts\" -ForegroundColor Yellow
            exit 1
        }
    }
}
Write-Host "   NSSM found: $NssmExe" -ForegroundColor Green

# -- Step 2: Ensure Python venv + packages ------------------------------------
Write-Host "`n[2/6] Checking Python environment..."
$python = $null
foreach ($p in @("python", "python3", "py")) {
    try {
        $v = & $p --version 2>&1
        if ($LASTEXITCODE -eq 0) { $python = $p; break }
    } catch {}
}
if (-not $python) {
    Write-Host "   Python not found. Run: winget install Python.Python.3.11" -ForegroundColor Red; exit 1
}
Write-Host "   Python: $python" -ForegroundColor Green

if (-not (Test-Path $VenvPy)) {
    Write-Host "   Creating virtualenv..." -ForegroundColor Yellow
    & $python -m venv "$BackendDir\venv"
}
Write-Host "   Installing/updating packages from requirements.txt..." -ForegroundColor Yellow
& $VenvPip install -r $Requirements --quiet --upgrade

# -- Step 3: Build environment block from .env --------------------------------
Write-Host "`n[3/6] Reading environment variables from .env..."
$DotEnv = Read-DotEnv -Path $EnvFile

$PgUser     = if ($DotEnv.ContainsKey('POSTGRES_USER') -and $DotEnv['POSTGRES_USER'])         { $DotEnv['POSTGRES_USER'] }     else { 'billiard' }
$PgPassword = if ($DotEnv.ContainsKey('POSTGRES_PASSWORD') -and $DotEnv['POSTGRES_PASSWORD']) { $DotEnv['POSTGRES_PASSWORD'] } else { 'billiard_secret' }
$PgDb       = if ($DotEnv.ContainsKey('POSTGRES_DB') -and $DotEnv['POSTGRES_DB'])             { $DotEnv['POSTGRES_DB'] }       else { 'billiardbar' }

# The native Postgres install's port is auto-discovered from
# scripts\.postgres-port.txt (written by install-postgres-native.ps1), never
# assumed to be the Postgres-standard 5432 -- this machine may already have a
# different, unrelated Postgres installation bound to 5432.
$PgPortFile = Join-Path $BaseDir "scripts\.postgres-port.txt"
$PgPort     = if (Test-Path $PgPortFile) { (Get-Content $PgPortFile -Raw).Trim() } else { '5432' }

# POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD are consumed above to build
# DATABASE_URL, not forwarded raw.
$ExcludedKeys = @('POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD')
$EnvArgs = @()
foreach ($key in $DotEnv.Keys) {
    if ($ExcludedKeys -contains $key) { continue }
    $EnvArgs += "$key=$($DotEnv[$key])"
}

# These are appended AFTER the loop so they always win, overriding whatever
# (if anything) came from .env for the same keys -- native-environment values
# take precedence over any Docker-oriented values that might be sitting in .env.
$EnvArgs += "DATABASE_URL=postgresql://${PgUser}:${PgPassword}@localhost:${PgPort}/${PgDb}"
# 127.0.0.1, not localhost: eventlet.monkey_patch() (DATA-03) breaks
# Python-level "localhost" DNS resolution on this Windows environment
# (confirmed Phase 4 04-04 staging validation) -- an IP literal avoids the
# DNS lookup entirely.
$EnvArgs += "PRINT_AGENT_URL=http://127.0.0.1:9191"
$EnvArgs += "FLASK_APP=wsgi.py"
$EnvArgs += "FLASK_ENV=production"

Write-Host "   Forwarding $($EnvArgs.Count) environment variables (DATABASE_URL -> localhost:$PgPort, PRINT_AGENT_URL -> 127.0.0.1:9191)." -ForegroundColor Green

# -- Step 4: Stop & remove existing service if reinstalling -------------------
Write-Host "`n[4/6] Registering Windows Service..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Stopping existing service..." -ForegroundColor Yellow
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

# Register the service -- NSSM launches service_entry.py (not wsgi.py
# directly), which runs flask init-db -> seed.py -> socketio.run() in order
# on every start (D-06's every-start idempotent behavior).
& $NssmExe install $ServiceName $VenvPy $Script
& $NssmExe set $ServiceName AppDirectory $BackendDir
& $NssmExe set $ServiceName AppStdout    (Join-Path $BackendDir "backend.log")
& $NssmExe set $ServiceName AppStderr    (Join-Path $BackendDir "backend_err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760   # rotate at 10 MB
& $NssmExe set $ServiceName Start SERVICE_AUTO_START  # start at boot
& $NssmExe set $ServiceName ObjectName LocalSystem    # matches print-agent precedent; see threat_model T-02-02

# Environment variables, sourced from .env at install time (never hardcoded).
& $NssmExe set $ServiceName AppEnvironmentExtra $EnvArgs

# Restart policy: restart on failure after 5s (matches print-agent precedent)
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000

Write-Host "   Service '$ServiceName' registered." -ForegroundColor Green

# -- Step 5: Open Windows Firewall port 5000 -----------------------------------
Write-Host "`n[5/6] Opening firewall port 5000 (LAN access for frontend/proxy)..."
$ruleName = "BilliardBarBackend"
$ruleExists = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ($LASTEXITCODE -ne 0) {
    netsh advfirewall firewall add rule `
        name="$ruleName" dir=in action=allow protocol=TCP localport=5000 | Out-Null
    Write-Host "   Firewall rule added (port 5000 open)." -ForegroundColor Green
} else {
    Write-Host "   Firewall rule already exists." -ForegroundColor Gray
}

# -- Step 6: Start service and verify -----------------------------------------
Write-Host "`n[6/6] Starting service..."
& $NssmExe start $ServiceName
# Longer wait than the print agent's 4s -- init-db + seed.py run before the
# server starts listening.
Start-Sleep -Seconds 6

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "   Service is RUNNING [OK]" -ForegroundColor Green
} else {
    Write-Host "   Service status: $($svc.Status)" -ForegroundColor Yellow
    Write-Host "   Check log: $BackendDir\backend_err.log" -ForegroundColor Yellow
}

# Health-check retry loop: a non-2xx/401 JSON response is expected and
# acceptable (the endpoint requires auth); only connection-refused/timeout
# means the service isn't actually up yet.
$verifyOk = $false
for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
        $null = Invoke-RestMethod -Uri "http://localhost:5000/api/v1/auth/me" -TimeoutSec 5
        $verifyOk = $true
        break
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        if ($statusCode) {
            # Got an actual HTTP response (e.g. 401 unauthorized) -- server is up.
            $verifyOk = $true
            break
        }
        Start-Sleep -Seconds 2
    }
}

if ($verifyOk) {
    Write-Host "   Health check: PASS - backend responding on http://localhost:5000" -ForegroundColor Green
} else {
    Write-Host "   Health check: FAIL - backend not reachable after 10 attempts" -ForegroundColor Red
    Write-Host "   Check log: $BackendDir\backend_err.log" -ForegroundColor Yellow
}

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Service management commands:"
Write-Host "   Start:   nssm start $ServiceName"
Write-Host "   Stop:    nssm stop  $ServiceName"
Write-Host "   Restart: nssm restart $ServiceName"
Write-Host "   Logs:    $BackendDir\backend.log"
Write-Host "   Status:  Get-Service $ServiceName"
Write-Host "============================================================"

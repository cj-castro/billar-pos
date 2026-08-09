# =============================================================================
# install-nssm-scheduler.ps1
# BilliardBar Daily Report Scheduler - installs as a REAL Windows Service
# using NSSM, independent of the backend service (SVC-04).
#
# [OK] Starts at BOOT (no login required - even headless servers)
# [OK] Auto-restarts on crash
# [OK] Runs in its own virtualenv, separate from the backend's (D-07)
# [OK] Manageable via services.msc or "nssm start/stop/restart BilliardBarScheduler"
#
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd C:\Users\bola8lacalma\Desktop\POS\billiards
#   4. .\scripts\install-nssm-scheduler.ps1
#
# Secrets (SMTP_PASSWORD, etc.) are read from the repo-root .env file at
# install time and written into the service's private environment block —
# never hardcoded in this script.
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendDir  = Join-Path $BaseDir "backend"
$VenvDir     = Join-Path $BackendDir "scheduler_venv"
$VenvPy      = Join-Path $VenvDir "Scripts\pythonw.exe"
$VenvPip     = Join-Path $VenvDir "Scripts\pip.exe"
$Script      = Join-Path $BackendDir "scheduler.py"
$ServiceName = "BilliardBarScheduler"
$EnvFile     = Join-Path $BaseDir ".env"
$NssmExe     = $null

Write-Host "`n=== BilliardBar Scheduler - Windows Service Installer ===" -ForegroundColor Cyan
Write-Host "   Service will start at BOOT - no login required.`n"

# ---------------------------------------------------------------------------
# Read-DotEnv: parse the repo-root .env into a hashtable. Never hardcode
# secret values in this script — they are always sourced from .env at
# install time (git-ignored, never committed).
# ---------------------------------------------------------------------------
function Read-DotEnv {
    param([string]$Path)
    $result = @{}
    if (Test-Path $Path) {
        Get-Content $Path | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
                $idx = $line.IndexOf('=')
                $key = $line.Substring(0, $idx).Trim()
                $val = $line.Substring($idx + 1).Trim()
                if ($val.Length -ge 2 -and (
                        ($val.StartsWith('"') -and $val.EndsWith('"')) -or
                        ($val.StartsWith("'") -and $val.EndsWith("'"))
                    )) {
                    $val = $val.Substring(1, $val.Length - 2)
                }
                $result[$key] = $val
            }
        }
    } else {
        Write-Host "   WARNING: .env not found at $Path — falling back to docker-compose.yml defaults." -ForegroundColor Yellow
    }
    return $result
}

$DotEnv = Read-DotEnv -Path $EnvFile

# -- Step 1: Find or install NSSM ---------------------------------------------
Write-Host "[1/5] Locating NSSM..."
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

# -- Step 2: Ensure a SEPARATE Python venv for the scheduler (D-07) -----------
# Deliberately NOT backend\venv — each native service gets its own
# virtualenv, even though scheduler.py installs from the same requirements.txt
# as the backend.
Write-Host "`n[2/5] Checking Python environment (separate venv: backend\scheduler_venv)..."
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
    Write-Host "   Creating virtualenv at $VenvDir ..." -ForegroundColor Yellow
    & $python -m venv $VenvDir
}
Write-Host "   Installing/updating packages from backend\requirements.txt..." -ForegroundColor Yellow
& $VenvPip install -r (Join-Path $BackendDir "requirements.txt") --quiet --upgrade

# -- Step 3: Stop & remove existing service if reinstalling -------------------
Write-Host "`n[3/5] Registering Windows Service..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Stopping existing service..." -ForegroundColor Yellow
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

# NSSM target: scheduler.py directly — no wrapper needed. Unlike the backend,
# there is no init-db/seed step to run first; scheduler.py builds its own
# Flask app internally via create_app() purely for DB access.
& $NssmExe install $ServiceName $VenvPy $Script
& $NssmExe set $ServiceName AppDirectory $BackendDir
& $NssmExe set $ServiceName AppStdout    (Join-Path $BackendDir "scheduler.log")
& $NssmExe set $ServiceName AppStderr    (Join-Path $BackendDir "scheduler_err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760   # rotate at 10 MB
& $NssmExe set $ServiceName Start SERVICE_AUTO_START   # start at boot
& $NssmExe set $ServiceName ObjectName LocalSystem     # matches print-agent precedent (accepted risk, see threat model)

# -- Step 4: Build environment block from .env (never hardcoded) -------------
Write-Host "`n[4/5] Building service environment from .env (secrets never hardcoded)..."

$PgUser     = if ($DotEnv.ContainsKey('POSTGRES_USER'))     { $DotEnv['POSTGRES_USER'] }     else { 'billiard' }
$PgPassword = if ($DotEnv.ContainsKey('POSTGRES_PASSWORD')) { $DotEnv['POSTGRES_PASSWORD'] } else { 'billiard_secret' }
$PgDb       = if ($DotEnv.ContainsKey('POSTGRES_DB'))       { $DotEnv['POSTGRES_DB'] }       else { 'billiardbar' }

$SecretKey  = if ($DotEnv.ContainsKey('SECRET_KEY'))  { $DotEnv['SECRET_KEY'] }  else { 'dev-secret-key-change-in-production' }
$Tz         = if ($DotEnv.ContainsKey('TZ'))          { $DotEnv['TZ'] }          else { 'America/Mexico_City' }
$SmtpHost   = if ($DotEnv.ContainsKey('SMTP_HOST'))    { $DotEnv['SMTP_HOST'] }   else { 'smtp.gmail.com' }
$SmtpPort   = if ($DotEnv.ContainsKey('SMTP_PORT'))    { $DotEnv['SMTP_PORT'] }   else { '587' }
$SmtpUser   = if ($DotEnv.ContainsKey('SMTP_USER'))    { $DotEnv['SMTP_USER'] }   else { '' }
$SmtpPass   = if ($DotEnv.ContainsKey('SMTP_PASSWORD')) { $DotEnv['SMTP_PASSWORD'] } else { '' }
$ReportFrom = if ($DotEnv.ContainsKey('REPORT_FROM'))  { $DotEnv['REPORT_FROM'] } else { 'bola.8gdl@gmail.com' }
$ReportTo   = if ($DotEnv.ContainsKey('REPORT_TO'))    { $DotEnv['REPORT_TO'] }   else { 'bola.8gdl@gmail.com,isc.castro@gmail.com' }

# Native Windows connects to Postgres via localhost:5432, not the Docker
# service name "postgres" — same fix as the backend's own install script.
$DatabaseUrl = "DATABASE_URL=postgresql://${PgUser}:${PgPassword}@localhost:5432/${PgDb}"

& $NssmExe set $ServiceName AppEnvironmentExtra `
    $DatabaseUrl `
    "SECRET_KEY=$SecretKey" `
    "TZ=$Tz" `
    "FLASK_APP=wsgi.py" `
    "SMTP_HOST=$SmtpHost" `
    "SMTP_PORT=$SmtpPort" `
    "SMTP_USER=$SmtpUser" `
    "SMTP_PASSWORD=$SmtpPass" `
    "REPORT_FROM=$ReportFrom" `
    "REPORT_TO=$ReportTo"

if (-not $SmtpUser -or -not $SmtpPass) {
    Write-Host "   WARNING: SMTP_USER/SMTP_PASSWORD not set in .env — daily report emails will fail until these are configured." -ForegroundColor Yellow
}

# Restart policy: restart on failure after 5s (matches print-agent precedent)
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000

Write-Host "   Service '$ServiceName' registered." -ForegroundColor Green

# -- Step 5: Start service and verify -----------------------------------------
Write-Host "`n[5/5] Starting service..."
& $NssmExe start $ServiceName
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "   Service is RUNNING [OK]" -ForegroundColor Green
} else {
    Write-Host "   Service status: $($svc.Status)" -ForegroundColor Yellow
    Write-Host "   Check log: $BackendDir\scheduler_err.log" -ForegroundColor Yellow
}

# No HTTP health check exists for this service — BlockingScheduler has no
# listening port, so Get-Service status is the only verification signal
# available (per 02-RESEARCH.md Pattern 5).

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Service management commands:"
Write-Host "   Start:   nssm start $ServiceName"
Write-Host "   Stop:    nssm stop  $ServiceName"
Write-Host "   Restart: nssm restart $ServiceName"
Write-Host "   Logs:    $BackendDir\scheduler.log"
Write-Host "   Status:  Get-Service $ServiceName"
Write-Host "============================================================"

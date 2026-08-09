# =============================================================================
# install-nssm-telegram-bot.ps1
# BilliardBar Telegram Bot - installs as a REAL Windows Service using NSSM,
# independent of the backend service (SVC-05).
#
# [OK] Starts at BOOT (no login required - even headless servers)
# [OK] Auto-restarts on crash
# [OK] Runs in its own virtualenv, separate from the backend's/scheduler's (D-07)
# [OK] Manageable via services.msc or "nssm start/stop/restart BilliardBarTelegramBot"
#
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd C:\Users\bola8lacalma\Desktop\POS\billiards
#   4. .\scripts\install-nssm-telegram-bot.ps1
#
# Secrets (TELEGRAM_TOKEN, ADMIN_CHAT_ID) are read from the repo-root .env
# file at install time and written into the service's private environment
# block — never hardcoded in this script.
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BotDir      = Join-Path $BaseDir "telegram-bot"
$VenvDir     = Join-Path $BotDir "venv"
$VenvPy      = Join-Path $VenvDir "Scripts\pythonw.exe"
$VenvPip     = Join-Path $VenvDir "Scripts\pip.exe"
$Script      = Join-Path $BotDir "bot.py"
$ServiceName = "BilliardBarTelegramBot"
$EnvFile     = Join-Path $BaseDir ".env"
$NssmExe     = $null

Write-Host "`n=== BilliardBar Telegram Bot - Windows Service Installer ===" -ForegroundColor Cyan
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
        Write-Host "   WARNING: .env not found at $Path — TELEGRAM_TOKEN/ADMIN_CHAT_ID will be empty." -ForegroundColor Yellow
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

# -- Step 2: Ensure a SEPARATE Python venv for the bot (D-07) -----------------
# telegram-bot\venv installs from telegram-bot\requirements.txt — an
# entirely different dependency set from the backend/scheduler, so this
# venv is naturally isolated (no shared packages, no shared interpreter).
Write-Host "`n[2/5] Checking Python environment (separate venv: telegram-bot\venv)..."
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
Write-Host "   Installing/updating packages from telegram-bot\requirements.txt..." -ForegroundColor Yellow
& $VenvPip install -r (Join-Path $BotDir "requirements.txt") --quiet --upgrade

# -- Step 3: Stop & remove existing service if reinstalling -------------------
Write-Host "`n[3/5] Registering Windows Service..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Stopping existing service..." -ForegroundColor Yellow
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

# NSSM target: bot.py directly — no wrapper needed.
& $NssmExe install $ServiceName $VenvPy $Script
& $NssmExe set $ServiceName AppDirectory $BotDir
& $NssmExe set $ServiceName AppStdout    (Join-Path $BotDir "bot.log")
& $NssmExe set $ServiceName AppStderr    (Join-Path $BotDir "bot_err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760   # rotate at 10 MB
& $NssmExe set $ServiceName Start SERVICE_AUTO_START   # start at boot
& $NssmExe set $ServiceName ObjectName LocalSystem     # matches print-agent precedent (accepted risk, see threat model)

# -- Step 4: Build environment block from .env (never hardcoded) -------------
Write-Host "`n[4/5] Building service environment from .env (secrets never hardcoded)..."

$PgUser     = if ($DotEnv.ContainsKey('POSTGRES_USER'))     { $DotEnv['POSTGRES_USER'] }     else { 'billiard' }
$PgPassword = if ($DotEnv.ContainsKey('POSTGRES_PASSWORD')) { $DotEnv['POSTGRES_PASSWORD'] } else { 'billiard_secret' }
$PgDb       = if ($DotEnv.ContainsKey('POSTGRES_DB'))       { $DotEnv['POSTGRES_DB'] }       else { 'billiardbar' }

$TelegramToken = if ($DotEnv.ContainsKey('TELEGRAM_TOKEN')) { $DotEnv['TELEGRAM_TOKEN'] } else { '' }
$AdminChatId   = if ($DotEnv.ContainsKey('ADMIN_CHAT_ID'))  { $DotEnv['ADMIN_CHAT_ID'] }  else { '' }

# Native Windows connects to Postgres via localhost:5432, not the Docker
# service name "postgres" — same fix as the backend's/scheduler's own
# install scripts.
$DatabaseUrl = "DATABASE_URL=postgresql://${PgUser}:${PgPassword}@localhost:5432/${PgDb}"

# bot.py raises ValueError and exits immediately at import time if
# TELEGRAM_TOKEN, ADMIN_CHAT_ID, or DATABASE_URL is missing — all three
# are mandatory here.
& $NssmExe set $ServiceName AppEnvironmentExtra `
    "TELEGRAM_TOKEN=$TelegramToken" `
    "ADMIN_CHAT_ID=$AdminChatId" `
    $DatabaseUrl

# Explicit guard: warn (do not block) if either mandatory secret is
# missing from .env. NSSM's AppExit Default Restart will keep retrying
# safely rather than leaving the machine in a half-configured state.
if (-not $TelegramToken -or -not $AdminChatId) {
    Write-Host "   TELEGRAM_TOKEN/ADMIN_CHAT_ID not set in .env — service will crash-loop until these are set" -ForegroundColor Red
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
    Write-Host "   Check log: $BotDir\bot_err.log" -ForegroundColor Yellow
}

# Secondary signal: bot.py's own startup ValueError text, if it crashed
# immediately due to missing env vars.
$errLog = Join-Path $BotDir "bot_err.log"
if (Test-Path $errLog) {
    $tail = Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue
    if ($tail -match "ValueError: Missing required env vars") {
        Write-Host "   bot_err.log shows a missing-env-var crash — set TELEGRAM_TOKEN/ADMIN_CHAT_ID in .env and re-run this script." -ForegroundColor Red
    }
}

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Service management commands:"
Write-Host "   Start:   nssm start $ServiceName"
Write-Host "   Stop:    nssm stop  $ServiceName"
Write-Host "   Restart: nssm restart $ServiceName"
Write-Host "   Logs:    $BotDir\bot.log"
Write-Host "   Status:  Get-Service $ServiceName"
Write-Host "============================================================"

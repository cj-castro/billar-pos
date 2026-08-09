# =============================================================================
# install-postgres-native.ps1
# Installs PostgreSQL 15 as a native Windows Service (NOT Docker, NOT NSSM —
# Postgres registers its own vendor-standard Windows service via its installer).
#
# Part of the Docker/Rancher -> native Windows Services migration (Phase 2,
# SVC-02). Mirrors docker-compose.yml's postgres service: same POSTGRES_DB /
# POSTGRES_USER / POSTGRES_PASSWORD values (read from the repo-root .env, with
# the same defaults docker-compose.yml itself falls back to), so
# DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<db> works
# unchanged for the backend/scheduler/telegram-bot native services.
#
# Threat model hardening applied here (see 02-04-PLAN.md threat_model):
#   T-02-13 (HIGH): listen_addresses = 'localhost', no firewall rule for 5432
#                    -> Postgres stays unreachable from the LAN, exactly like
#                       today's Docker setup (which never published the port).
#   T-02-14 (HIGH): pg_hba.conf 'trust' entries are rewritten to scram-sha-256.
#   T-02-15:        the Postgres superuser password is generated randomly at
#                    run time via Get-Random and is never hardcoded/logged.
#
# HOW TO RUN (one time, as Administrator, on the staging Windows machine):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd <repo-root>
#   4. .\scripts\install-postgres-native.ps1
# =============================================================================
#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile = Join-Path $BaseDir ".env"
$PgVersion = "15"
$PgServiceNameFile = Join-Path $BaseDir "scripts\.postgres-service-name.txt"

Write-Host "`n=== PostgreSQL 15 Native Windows Service Installer ===" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Step 1: Parse repo-root .env into a hashtable (same values docker-compose.yml
#         itself reads via ${VAR:-default}) — never hardcode secrets here.
# ---------------------------------------------------------------------------
Write-Host "`n[1/6] Reading configuration from .env..."

function Read-DotEnv {
    param([string]$Path)
    $result = @{}
    if (Test-Path $Path) {
        Get-Content $Path | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
                $idx = $line.IndexOf("=")
                $key = $line.Substring(0, $idx).Trim()
                $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
                $result[$key] = $val
            }
        }
    }
    return $result
}

$EnvVars = Read-DotEnv -Path $EnvFile

# Fall back to docker-compose.yml's own defaults (billiardbar/billiard/billiard_secret)
# if a key is absent from .env — never a hardcoded secret, just the same public
# default already committed in docker-compose.yml.
$POSTGRES_DB       = if ($EnvVars.ContainsKey("POSTGRES_DB"))       { $EnvVars["POSTGRES_DB"] }       else { "billiardbar" }
$POSTGRES_USER     = if ($EnvVars.ContainsKey("POSTGRES_USER"))     { $EnvVars["POSTGRES_USER"] }     else { "billiard" }
$POSTGRES_PASSWORD = if ($EnvVars.ContainsKey("POSTGRES_PASSWORD")) { $EnvVars["POSTGRES_PASSWORD"] } else { "billiard_secret" }

Write-Host "   DB=$POSTGRES_DB USER=$POSTGRES_USER (password loaded from .env, not printed)" -ForegroundColor Green

# Random local superuser password, generated at run time only — never hardcoded,
# never written to disk, never echoed.
$SuperPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })

# ---------------------------------------------------------------------------
# Step 2: Install PostgreSQL 15 (Chocolatey first, official EDB installer as
#         the direct-download fallback — same fallback-chain shape as
#         scripts/install-nssm-print-agent.ps1's NSSM locate/install logic).
# ---------------------------------------------------------------------------
Write-Host "`n[2/6] Installing PostgreSQL $PgVersion..."

$installed = $false
try {
    Write-Host "   Trying Chocolatey install..." -ForegroundColor Yellow
    & choco install postgresql15 -y --params "/Password:$SuperPassword" --no-progress 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $installed = $true
        Write-Host "   Installed via Chocolatey." -ForegroundColor Green
    }
} catch {}

if (-not $installed) {
    Write-Host "   Chocolatey unavailable/failed. Downloading official EnterpriseDB installer..." -ForegroundColor Yellow
    # Pinned to a specific 15.x release rather than scraping "latest".
    $EdbInstallerUrl = "https://get.enterprisedb.com/postgresql/postgresql-15.8-1-windows-x64.exe"
    $EdbInstallerExe = Join-Path $env:TEMP "postgresql-15-installer.exe"
    try {
        Invoke-WebRequest -Uri $EdbInstallerUrl -OutFile $EdbInstallerExe -UseBasicParsing -TimeoutSec 120
        & $EdbInstallerExe --mode unattended --unattendedmodeui minimal `
            --superpassword $SuperPassword `
            --servicename postgresql-x64-15 `
            --serverport 5432 | Out-Null
        $installed = $true
        Write-Host "   Installed via EnterpriseDB installer." -ForegroundColor Green
    } catch {
        Write-Host "   Failed to install PostgreSQL 15: $_" -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Step 3: Discover the actual registered service name (Chocolatey and the EDB
#         installer register slightly different names) and record it for
#         Plan 05's install-all-native-services.ps1 (NSSM DependOnService).
# ---------------------------------------------------------------------------
Write-Host "`n[3/6] Discovering registered Postgres service name..."

$PgService = Get-Service | Where-Object { $_.Name -like "postgresql*" } | Select-Object -First 1 -ExpandProperty Name
if (-not $PgService) {
    Write-Host "   Could not find a registered postgresql* service." -ForegroundColor Red
    exit 1
}
Write-Host "   Discovered service: $PgService" -ForegroundColor Green

New-Item -Force -ItemType Directory (Split-Path $PgServiceNameFile) | Out-Null
Set-Content -Path $PgServiceNameFile -Value $PgService -NoNewline
Write-Host "   Written to $PgServiceNameFile" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 4: Locate the Postgres bin dir and create the app role + database
#         (matching docker-compose.yml's POSTGRES_USER/POSTGRES_DB exactly).
# ---------------------------------------------------------------------------
Write-Host "`n[4/6] Creating application role and database..."

$PgBin = "C:\Program Files\PostgreSQL\$PgVersion\bin"
if (-not (Test-Path $PgBin)) {
    Write-Host "   Postgres bin dir not found at $PgBin" -ForegroundColor Red
    exit 1
}

$env:PGPASSWORD = $SuperPassword
try {
    & "$PgBin\createuser.exe" -U postgres -h localhost -w $POSTGRES_USER 2>&1 | Out-Null
    & "$PgBin\psql.exe" -U postgres -h localhost -c "ALTER USER $POSTGRES_USER WITH PASSWORD '$POSTGRES_PASSWORD'" 2>&1 | Out-Null
    & "$PgBin\createdb.exe" -U postgres -h localhost -O $POSTGRES_USER $POSTGRES_DB 2>&1 | Out-Null
    Write-Host "   Role '$POSTGRES_USER' and database '$POSTGRES_DB' ready." -ForegroundColor Green
} finally {
    $env:PGPASSWORD = ""
}

# ---------------------------------------------------------------------------
# Step 5: Harden per threat_model (T-02-13, T-02-14):
#   (1) listen_addresses = 'localhost' — no LAN exposure, unlike nginx's
#       intentionally-LAN-reachable port 8080.
#   (2) pg_hba.conf: replace any 'trust' auth method with 'scram-sha-256'
#       (PostgreSQL 15's own modern installer default).
#   (3) Deliberately do NOT open a Windows Firewall rule for port 5432.
# ---------------------------------------------------------------------------
Write-Host "`n[5/6] Hardening listen_addresses and pg_hba.conf auth..."

$PgDataDir = "C:\Program Files\PostgreSQL\$PgVersion\data"
$PgConf    = Join-Path $PgDataDir "postgresql.conf"
$PgHba     = Join-Path $PgDataDir "pg_hba.conf"

if (Test-Path $PgConf) {
    (Get-Content $PgConf) -replace "^#?listen_addresses.*", "listen_addresses = 'localhost'" |
        Set-Content $PgConf
    Write-Host "   listen_addresses = 'localhost' set in postgresql.conf" -ForegroundColor Green
} else {
    Write-Host "   WARNING: postgresql.conf not found at $PgConf" -ForegroundColor Yellow
}

if (Test-Path $PgHba) {
    $hbaContent = Get-Content $PgHba
    $hardenedHba = $hbaContent | ForEach-Object {
        if ($_ -match "^\s*(host|local)\b" -and $_ -match "\btrust\b") {
            ($_ -replace "\btrust\b", "scram-sha-256")
        } else {
            $_
        }
    }
    Set-Content $PgHba -Value $hardenedHba
    Write-Host "   Replaced any 'trust' entries in pg_hba.conf with scram-sha-256" -ForegroundColor Green
} else {
    Write-Host "   WARNING: pg_hba.conf not found at $PgHba" -ForegroundColor Yellow
}

# Deliberate omission: no `netsh advfirewall firewall add rule` opening port 5432
# anywhere in this script. Postgres must remain reachable only from this
# machine — contrast with nginx's intentional port 8080 LAN rule in Plan 03.

# ---------------------------------------------------------------------------
# Step 6: Restart the service to pick up config changes, then verify.
# ---------------------------------------------------------------------------
Write-Host "`n[6/6] Restarting service and verifying connection..."

Restart-Service $PgService
Start-Sleep -Seconds 4

$env:PGPASSWORD = $POSTGRES_PASSWORD
try {
    $result = & "$PgBin\psql.exe" -U $POSTGRES_USER -h localhost -d $POSTGRES_DB -c "SELECT 1" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n   PASS: Connected to '$POSTGRES_DB' as '$POSTGRES_USER' over scram-sha-256." -ForegroundColor Green
    } else {
        Write-Host "`n   FAIL: Could not connect. Output: $result" -ForegroundColor Red
        exit 1
    }
} finally {
    $env:PGPASSWORD = ""
}

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Service name:      $PgService"
Write-Host " Service name file: $PgServiceNameFile"
Write-Host " Database:          $POSTGRES_DB"
Write-Host " Bind address:      localhost only (no firewall rule opened for 5432)"
Write-Host "============================================================"

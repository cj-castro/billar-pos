# =============================================================================
# reconfigure-secrets.ps1
# Phase 3 - Reconfigure BilliardBarBackend/Scheduler/TelegramBot's NSSM
# AppEnvironmentExtra to source secrets from the DPAPI-encrypted store under
# C:\POS\secrets\ (written by migrate-secrets-to-dpapi.ps1) instead of the
# plaintext .env file.
#
# HOW TO RUN (after migrate-secrets-to-dpapi.ps1 has been run at least once,
# as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd <repo root>
#   4. .\scripts\reconfigure-secrets.ps1
#
# This script:
# - Decrypts each D-07-scoped secret needed by a given service from its
#   C:\POS\secrets\<KEY>.dat file (LocalMachine-scoped DPAPI)
# - Merges those decrypted secret values with the NON-secret values already
#   read from .env (BILLING_MODE, TZ, REPORT_FROM, etc. -- per D-08)
# - Stops each service, applies the merged AppEnvironmentExtra, verifies via
#   a non-secret marker check, and restarts it (cycle: nssm stop -> nssm set
#   AppEnvironmentExtra -> nssm get verify -> nssm start, via the resolved
#   $NssmExe path, same stop/set/verify/restart pattern as
#   reconfigure-log-paths.ps1)
#
# Does NOT edit any install-nssm-*.ps1 file (D-03's no-edit constraint
# applies here too) and touches only the 3 secret-consuming services listed
# above -- the print-agent and nginx NSSM services have no secrets in their
# AppEnvironmentExtra today and are intentionally out of scope for this
# script.
#
# SAFETY: this script NEVER prints a decrypted secret value directly. Only
# key names, booleans, and the non-secret DATABASE_URL= presence marker are
# ever printed.
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile     = Join-Path $BaseDir ".env"
$SecretsDir  = "C:\POS\secrets"
$NssmExe     = $null

Write-Host "`n=== Phase 3: Reconfigure Secrets from DPAPI Store ===" -ForegroundColor Cyan
Write-Host "   Reconfiguring BilliardBarBackend / BilliardBarScheduler / BilliardBarTelegramBot`n"

# ---------------------------------------------------------------------------
# Read-DotEnv: parses the repo-root .env into a hashtable. Used here ONLY
# for non-secret values (POSTGRES_USER/POSTGRES_DB, BILLING_MODE, TZ, etc.)
# -- secret values come from Unprotect-Secret / the DPAPI store instead.
# (Copied verbatim from scripts/install-nssm-backend.ps1.)
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

# ---------------------------------------------------------------------------
# Unprotect-Secret: reads C:\POS\secrets\<Key>.dat, base64-decodes, and
# DPAPI-decrypts (LocalMachine scope -- must match the scope used by
# migrate-secrets-to-dpapi.ps1's Protect-Secret). Returns $null (with a
# clear error) if the .dat file doesn't exist, meaning
# migrate-secrets-to-dpapi.ps1 hasn't been run for that key yet. Never
# prints the decrypted value.
# ---------------------------------------------------------------------------
function Unprotect-Secret {
    param([string]$Key)
    $datPath = Join-Path $SecretsDir "$Key.dat"
    if (-not (Test-Path $datPath)) {
        Write-Host "   ERROR: $datPath not found -- run migrate-secrets-to-dpapi.ps1 first for $Key" -ForegroundColor Red
        return $null
    }
    try {
        $base64 = Get-Content -Path $datPath -Raw
        [byte[]]$encrypted = [Convert]::FromBase64String($base64)
        [byte[]]$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted,
            $null,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        return [System.Text.Encoding]::UTF8.GetString($decrypted)
    } catch {
        Write-Host "   ERROR: Failed to decrypt $Key -- $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

# -- Step 1: Find NSSM ---------------------------------------------------------
Write-Host "[1/4] Locating NSSM..."
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                  "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                  "$BaseDir\scripts\nssm.exe")) {
    try {
        $v = & $p version 2>&1
        if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
    } catch {}
}

if (-not $NssmExe) {
    Write-Host "   NSSM not found. Install it via Phase 2 first." -ForegroundColor Red
    exit 1
}
Write-Host "   NSSM found: $NssmExe" -ForegroundColor Green

# -- Step 2: Read non-secret values from .env / defaults -----------------------
Write-Host "`n[2/4] Reading non-secret values from .env..."
$DotEnv = Read-DotEnv -Path $EnvFile

$PgUser   = if ($DotEnv.ContainsKey('POSTGRES_USER') -and $DotEnv['POSTGRES_USER']) { $DotEnv['POSTGRES_USER'] } else { 'billiard' }
$PgDb     = if ($DotEnv.ContainsKey('POSTGRES_DB') -and $DotEnv['POSTGRES_DB'])     { $DotEnv['POSTGRES_DB'] }   else { 'billiardbar' }

$BillingMode       = if ($DotEnv.ContainsKey('BILLING_MODE') -and $DotEnv['BILLING_MODE'])                     { $DotEnv['BILLING_MODE'] }             else { 'PER_MINUTE' }
$PoolRateCents     = if ($DotEnv.ContainsKey('POOL_RATE_CENTS') -and $DotEnv['POOL_RATE_CENTS'])               { $DotEnv['POOL_RATE_CENTS'] }           else { '150' }
$HappyHourStart    = if ($DotEnv.ContainsKey('HAPPY_HOUR_START') -and $DotEnv['HAPPY_HOUR_START'])             { $DotEnv['HAPPY_HOUR_START'] }          else { '17:00' }
$HappyHourEnd      = if ($DotEnv.ContainsKey('HAPPY_HOUR_END') -and $DotEnv['HAPPY_HOUR_END'])                 { $DotEnv['HAPPY_HOUR_END'] }            else { '20:00' }
$HappyHourDiscount = if ($DotEnv.ContainsKey('HAPPY_HOUR_DISCOUNT_PCT') -and $DotEnv['HAPPY_HOUR_DISCOUNT_PCT']) { $DotEnv['HAPPY_HOUR_DISCOUNT_PCT'] } else { '20' }
$Currency          = if ($DotEnv.ContainsKey('CURRENCY') -and $DotEnv['CURRENCY'])                             { $DotEnv['CURRENCY'] }                  else { 'MXN' }
$Tz                = if ($DotEnv.ContainsKey('TZ') -and $DotEnv['TZ'])                                         { $DotEnv['TZ'] }                        else { 'America/Mexico_City' }
$LogLevel          = if ($DotEnv.ContainsKey('LOG_LEVEL') -and $DotEnv['LOG_LEVEL'])                           { $DotEnv['LOG_LEVEL'] }                 else { 'INFO' }
$FlaskEnv          = if ($DotEnv.ContainsKey('FLASK_ENV') -and $DotEnv['FLASK_ENV'])                           { $DotEnv['FLASK_ENV'] }                 else { 'production' }
$ReportFrom        = if ($DotEnv.ContainsKey('REPORT_FROM') -and $DotEnv['REPORT_FROM'])                       { $DotEnv['REPORT_FROM'] }               else { 'bola.8gdl@gmail.com' }
$ReportTo          = if ($DotEnv.ContainsKey('REPORT_TO') -and $DotEnv['REPORT_TO'])                           { $DotEnv['REPORT_TO'] }                 else { 'bola.8gdl@gmail.com,isc.castro@gmail.com' }
$AdminChatId       = if ($DotEnv.ContainsKey('ADMIN_CHAT_ID') -and $DotEnv['ADMIN_CHAT_ID'])                   { $DotEnv['ADMIN_CHAT_ID'] }             else { '' }

# The native Postgres install's port is auto-discovered from
# scripts\.postgres-port.txt (written by install-postgres-native.ps1), never
# assumed to be the Postgres-standard 5432 -- same as every Phase 2 script.
$PgPortFile = Join-Path $BaseDir "scripts\.postgres-port.txt"
$PgPort     = if (Test-Path $PgPortFile) { (Get-Content $PgPortFile -Raw).Trim() } else { '5432' }

Write-Host "   Non-secret values loaded (Postgres port: $PgPort)." -ForegroundColor Green

# -- Step 3: Build DATABASE_URL using the DPAPI-decrypted Postgres password --
Write-Host "`n[3/4] Decrypting POSTGRES_PASSWORD and building DATABASE_URL..."
$PgPassword = Unprotect-Secret -Key 'POSTGRES_PASSWORD'
if ($null -eq $PgPassword) {
    Write-Host "   FATAL: POSTGRES_PASSWORD could not be decrypted -- cannot build DATABASE_URL for any service." -ForegroundColor Red
    Write-Host "   Run .\scripts\migrate-secrets-to-dpapi.ps1 first, then retry." -ForegroundColor Yellow
    exit 1
}
$DatabaseUrl = "DATABASE_URL=postgresql://${PgUser}:${PgPassword}@localhost:${PgPort}/${PgDb}"
Write-Host "   DATABASE_URL built (password sourced from DPAPI store, not printed)." -ForegroundColor Green

# -- Step 4: Reconfigure each of the 3 secret-consuming services -------------
Write-Host "`n[4/4] Reconfiguring services..."

$reconfigured = @()
$skippedSvcs  = @()

# --- BilliardBarBackend --------------------------------------------------
$svcName = "BilliardBarBackend"
Write-Host "`n   [*] $svcName..." -ForegroundColor Yellow
if (-not (Get-Service -Name $svcName -ErrorAction SilentlyContinue)) {
    Write-Host "       Service not installed -- skipping." -ForegroundColor Gray
    $skippedSvcs += $svcName
} else {
    $secretKeys = @('SECRET_KEY', 'JWT_REFRESH_SECRET', 'ADMIN_PASSWORD', 'ADMIN_PIN',
                     'MANAGER_PASSWORD', 'MANAGER_PIN', 'WAITER1_PASSWORD', 'WAITER2_PASSWORD',
                     'KITCHEN_PASSWORD', 'BARSTAFF_PASSWORD', 'SMTP_HOST', 'SMTP_PORT',
                     'SMTP_USER', 'SMTP_PASSWORD')
    $secretValues = @{}
    $missingKey = $null
    foreach ($k in $secretKeys) {
        $v = Unprotect-Secret -Key $k
        if ($null -eq $v) { $missingKey = $k; break }
        $secretValues[$k] = $v
    }

    if ($missingKey) {
        Write-Host "       Missing secret '$missingKey' in DPAPI store -- skipping $svcName (not partially applying)." -ForegroundColor Red
        $skippedSvcs += $svcName
    } else {
        $envArgs = @(
            $DatabaseUrl,
            "SECRET_KEY=$($secretValues['SECRET_KEY'])",
            "JWT_REFRESH_SECRET=$($secretValues['JWT_REFRESH_SECRET'])",
            "ADMIN_PASSWORD=$($secretValues['ADMIN_PASSWORD'])",
            "ADMIN_PIN=$($secretValues['ADMIN_PIN'])",
            "MANAGER_PASSWORD=$($secretValues['MANAGER_PASSWORD'])",
            "MANAGER_PIN=$($secretValues['MANAGER_PIN'])",
            "WAITER1_PASSWORD=$($secretValues['WAITER1_PASSWORD'])",
            "WAITER2_PASSWORD=$($secretValues['WAITER2_PASSWORD'])",
            "KITCHEN_PASSWORD=$($secretValues['KITCHEN_PASSWORD'])",
            "BARSTAFF_PASSWORD=$($secretValues['BARSTAFF_PASSWORD'])",
            "SMTP_HOST=$($secretValues['SMTP_HOST'])",
            "SMTP_PORT=$($secretValues['SMTP_PORT'])",
            "SMTP_USER=$($secretValues['SMTP_USER'])",
            "SMTP_PASSWORD=$($secretValues['SMTP_PASSWORD'])",
            "BILLING_MODE=$BillingMode",
            "POOL_RATE_CENTS=$PoolRateCents",
            "HAPPY_HOUR_START=$HappyHourStart",
            "HAPPY_HOUR_END=$HappyHourEnd",
            "HAPPY_HOUR_DISCOUNT_PCT=$HappyHourDiscount",
            "CURRENCY=$Currency",
            "TZ=$Tz",
            "LOG_LEVEL=$LogLevel",
            "FLASK_ENV=$FlaskEnv",
            "PRINT_AGENT_URL=http://localhost:9191",
            "FLASK_APP=wsgi.py",
            "REPORT_FROM=$ReportFrom",
            "REPORT_TO=$ReportTo"
        )

        Write-Host "       Stopping..." -ForegroundColor Yellow
        & $NssmExe stop $svcName confirm 2>&1 | Out-Null
        Start-Sleep -Seconds 2

        & $NssmExe set $svcName AppEnvironmentExtra $envArgs

        $verify = & $NssmExe get $svcName AppEnvironmentExtra
        if ($verify -match 'DATABASE_URL=') {
            Write-Host "       Verified: AppEnvironmentExtra contains DATABASE_URL marker." -ForegroundColor Green
        } else {
            Write-Host "       WARNING: AppEnvironmentExtra verification did not find DATABASE_URL marker." -ForegroundColor Yellow
        }

        Write-Host "       Starting..." -ForegroundColor Yellow
        & $NssmExe start $svcName 2>&1 | Out-Null
        Start-Sleep -Seconds 3
        $status = (Get-Service -Name $svcName -ErrorAction SilentlyContinue).Status
        Write-Host "       Status: $status" -ForegroundColor $(if ($status -eq 'Running') { 'Green' } else { 'Yellow' })
        $reconfigured += $svcName
    }
}

# --- BilliardBarScheduler -------------------------------------------------
$svcName = "BilliardBarScheduler"
Write-Host "`n   [*] $svcName..." -ForegroundColor Yellow
if (-not (Get-Service -Name $svcName -ErrorAction SilentlyContinue)) {
    Write-Host "       Service not installed -- skipping." -ForegroundColor Gray
    $skippedSvcs += $svcName
} else {
    $secretKeys = @('SECRET_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD')
    $secretValues = @{}
    $missingKey = $null
    foreach ($k in $secretKeys) {
        $v = Unprotect-Secret -Key $k
        if ($null -eq $v) { $missingKey = $k; break }
        $secretValues[$k] = $v
    }

    if ($missingKey) {
        Write-Host "       Missing secret '$missingKey' in DPAPI store -- skipping $svcName (not partially applying)." -ForegroundColor Red
        $skippedSvcs += $svcName
    } else {
        $envArgs = @(
            $DatabaseUrl,
            "SECRET_KEY=$($secretValues['SECRET_KEY'])",
            "TZ=$Tz",
            "FLASK_APP=wsgi.py",
            "SMTP_HOST=$($secretValues['SMTP_HOST'])",
            "SMTP_PORT=$($secretValues['SMTP_PORT'])",
            "SMTP_USER=$($secretValues['SMTP_USER'])",
            "SMTP_PASSWORD=$($secretValues['SMTP_PASSWORD'])",
            "REPORT_FROM=$ReportFrom",
            "REPORT_TO=$ReportTo"
        )

        Write-Host "       Stopping..." -ForegroundColor Yellow
        & $NssmExe stop $svcName confirm 2>&1 | Out-Null
        Start-Sleep -Seconds 2

        & $NssmExe set $svcName AppEnvironmentExtra $envArgs

        $verify = & $NssmExe get $svcName AppEnvironmentExtra
        if ($verify -match 'DATABASE_URL=') {
            Write-Host "       Verified: AppEnvironmentExtra contains DATABASE_URL marker." -ForegroundColor Green
        } else {
            Write-Host "       WARNING: AppEnvironmentExtra verification did not find DATABASE_URL marker." -ForegroundColor Yellow
        }

        Write-Host "       Starting..." -ForegroundColor Yellow
        & $NssmExe start $svcName 2>&1 | Out-Null
        Start-Sleep -Seconds 3
        $status = (Get-Service -Name $svcName -ErrorAction SilentlyContinue).Status
        Write-Host "       Status: $status" -ForegroundColor $(if ($status -eq 'Running') { 'Green' } else { 'Yellow' })
        $reconfigured += $svcName
    }
}

# --- BilliardBarTelegramBot ------------------------------------------------
$svcName = "BilliardBarTelegramBot"
Write-Host "`n   [*] $svcName..." -ForegroundColor Yellow
if (-not (Get-Service -Name $svcName -ErrorAction SilentlyContinue)) {
    Write-Host "       Service not installed -- skipping." -ForegroundColor Gray
    $skippedSvcs += $svcName
} else {
    $telegramToken = Unprotect-Secret -Key 'TELEGRAM_TOKEN'
    if ($null -eq $telegramToken) {
        Write-Host "       Missing secret 'TELEGRAM_TOKEN' in DPAPI store -- skipping $svcName (not partially applying)." -ForegroundColor Red
        $skippedSvcs += $svcName
    } else {
        $envArgs = @(
            "TELEGRAM_TOKEN=$telegramToken",
            "ADMIN_CHAT_ID=$AdminChatId",
            $DatabaseUrl
        )

        Write-Host "       Stopping..." -ForegroundColor Yellow
        & $NssmExe stop $svcName confirm 2>&1 | Out-Null
        Start-Sleep -Seconds 2

        & $NssmExe set $svcName AppEnvironmentExtra $envArgs

        $verify = & $NssmExe get $svcName AppEnvironmentExtra
        if ($verify -match 'DATABASE_URL=') {
            Write-Host "       Verified: AppEnvironmentExtra contains DATABASE_URL marker." -ForegroundColor Green
        } else {
            Write-Host "       WARNING: AppEnvironmentExtra verification did not find DATABASE_URL marker." -ForegroundColor Yellow
        }

        Write-Host "       Starting..." -ForegroundColor Yellow
        & $NssmExe start $svcName 2>&1 | Out-Null
        Start-Sleep -Seconds 3
        $status = (Get-Service -Name $svcName -ErrorAction SilentlyContinue).Status
        Write-Host "       Status: $status" -ForegroundColor $(if ($status -eq 'Running') { 'Green' } else { 'Yellow' })
        $reconfigured += $svcName
    }
}

# -- Summary --------------------------------------------------------------
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "   Reconfigured ($($reconfigured.Count)/3):" -ForegroundColor Green
foreach ($s in $reconfigured) { Write-Host "     - $s" -ForegroundColor Green }
if ($skippedSvcs.Count -gt 0) {
    Write-Host "   Skipped ($($skippedSvcs.Count)/3):" -ForegroundColor Yellow
    foreach ($s in $skippedSvcs) { Write-Host "     - $s" -ForegroundColor Yellow }
}

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Reconfigured services now source secrets from the DPAPI store"
Write-Host " under C:\POS\secrets\, not from .env. .env's secret values are"
Write-Host " no longer relied upon for these three services going forward."
Write-Host "============================================================"

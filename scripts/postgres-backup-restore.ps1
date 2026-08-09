# =============================================================================
# postgres-backup-restore.ps1
# Proves the Docker-to-native PostgreSQL logical dump/restore procedure
# (D-08/D-09) works end-to-end, using only backend/seed.py's synthetic demo
# data (D-09 — real production data is explicitly out of scope for Phase 2,
# deferred to Phase 5's cutover per D-10).
#
# Flow:
#   1. New-SyntheticSourceBackup  — spin up a throwaway `docker compose`
#      postgres+backend stack (backend's entrypoint.sh runs `flask init-db`
#      then `seed.py` automatically), pg_dump it, copy the dump out, then
#      tear the throwaway stack + volume down completely.
#   2. Restore-NativePostgres     — pg_restore that dump into the native
#      Postgres install created by scripts/install-postgres-native.ps1.
#   3. Test-RestoredData          — verify row counts match what seed.py
#      actually produces (6 users, 17 menu_items, resources > 0).
#
# Reusable unchanged in Phase 5 against real data (only the source of the
# dump changes — from this throwaway synthetic Docker stack to the live bar
# machine's Postgres container).
#
# HOW TO RUN (as Administrator, after scripts/install-postgres-native.ps1):
#   1. cd <repo-root>
#   2. .\scripts\postgres-backup-restore.ps1
# =============================================================================
#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$BaseDir     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile     = Join-Path $BaseDir ".env"
$BackupsDir  = Join-Path $BaseDir "backups"
$DumpFile    = Join-Path $BackupsDir "billiardbar_staging.dump"
$PgVersion   = "15"
$PgBin       = "C:\Program Files\PostgreSQL\$PgVersion\bin"

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
# Same POSTGRES_USER/DB/PASSWORD source as scripts/install-postgres-native.ps1 —
# never hardcode the password anywhere in this script.
$POSTGRES_DB       = if ($EnvVars.ContainsKey("POSTGRES_DB"))       { $EnvVars["POSTGRES_DB"] }       else { "billiardbar" }
$POSTGRES_USER     = if ($EnvVars.ContainsKey("POSTGRES_USER"))     { $EnvVars["POSTGRES_USER"] }     else { "billiard" }
$POSTGRES_PASSWORD = if ($EnvVars.ContainsKey("POSTGRES_PASSWORD")) { $EnvVars["POSTGRES_PASSWORD"] } else { "billiard_secret" }

# -----------------------------------------------------------------------------
# New-SyntheticSourceBackup (D-08/D-09)
#   Spins up a throwaway `docker compose` postgres+backend stack, waits for
#   seed.py to finish inside it, pg_dumps it, copies the dump to .\backups\,
#   then tears the throwaway stack and its volume down completely. This
#   synthetic source must never persist — it is not the native Postgres
#   instance being migrated to.
# -----------------------------------------------------------------------------
function New-SyntheticSourceBackup {
    Write-Host "`n[Backup] Starting throwaway synthetic Docker stack..." -ForegroundColor Cyan

    Push-Location $BaseDir
    try {
        docker compose up -d postgres backend
        if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

        Write-Host "   Waiting for seed.py to finish inside the throwaway container..." -ForegroundColor Yellow
        $seeded = $false
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            $count = (docker compose exec -T postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT COUNT(*) FROM users" 2>$null).Trim()
            if ($count -eq "6") { $seeded = $true; break }
            Start-Sleep -Seconds 3
        }
        if (-not $seeded) {
            throw "Timed out waiting for seed.py to seed 6 users into the throwaway stack."
        }
        Write-Host "   Synthetic seed data confirmed (6 users)." -ForegroundColor Green

        New-Item -Force -ItemType Directory $BackupsDir | Out-Null

        Write-Host "   Running pg_dump inside the throwaway container..." -ForegroundColor Yellow
        docker compose exec -T postgres pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc -f /tmp/billiardbar_staging.dump
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed inside the throwaway container" }

        Write-Host "   Copying dump out to $DumpFile ..." -ForegroundColor Yellow
        docker compose cp postgres:/tmp/billiardbar_staging.dump $DumpFile
        if ($LASTEXITCODE -ne 0) { throw "docker compose cp failed" }

        Write-Host "   Dump extracted successfully." -ForegroundColor Green
    } finally {
        Write-Host "   Tearing down throwaway synthetic stack + volume (docker compose down -v)..." -ForegroundColor Yellow
        docker compose down -v | Out-Null
        Pop-Location
    }
}

# -----------------------------------------------------------------------------
# Restore-NativePostgres
#   Restores the extracted dump into the native install's already-created
#   empty billiardbar database (created by install-postgres-native.ps1).
# -----------------------------------------------------------------------------
function Restore-NativePostgres {
    Write-Host "`n[Restore] Restoring dump into native Postgres..." -ForegroundColor Cyan

    if (-not (Test-Path $DumpFile)) {
        throw "Dump file not found at $DumpFile — run New-SyntheticSourceBackup first."
    }

    $env:PGPASSWORD = $POSTGRES_PASSWORD
    try {
        & "$PgBin\pg_restore.exe" -U $POSTGRES_USER -d $POSTGRES_DB -h localhost --no-acl --no-owner -v $DumpFile
        if ($LASTEXITCODE -ne 0) {
            Write-Host "   WARNING: pg_restore exited non-zero (some notices are expected on an empty target DB); continuing to verification." -ForegroundColor Yellow
        } else {
            Write-Host "   Restore completed." -ForegroundColor Green
        }
    } finally {
        $env:PGPASSWORD = ""
    }
}

# -----------------------------------------------------------------------------
# Test-RestoredData
#   Verifies row counts match backend/seed.py's actual synthetic data:
#     users        == 6
#     menu_items   >= 17
#     resources    >  0
# -----------------------------------------------------------------------------
function Test-RestoredData {
    Write-Host "`n[Verify] Checking restored row counts..." -ForegroundColor Cyan

    $allPass = $true
    $env:PGPASSWORD = $POSTGRES_PASSWORD
    try {
        $usersCount = (& "$PgBin\psql.exe" -U $POSTGRES_USER -d $POSTGRES_DB -h localhost -tAc "SELECT COUNT(*) FROM users").Trim()
        if ($usersCount -eq "6") {
            Write-Host "   PASS: users count == 6" -ForegroundColor Green
        } else {
            Write-Host "   FAIL: users count == $usersCount (expected 6)" -ForegroundColor Red
            $allPass = $false
        }

        $menuItemsCount = (& "$PgBin\psql.exe" -U $POSTGRES_USER -d $POSTGRES_DB -h localhost -tAc "SELECT COUNT(*) FROM menu_items").Trim()
        if ([int]$menuItemsCount -ge 17) {
            Write-Host "   PASS: menu_items count == $menuItemsCount (>= 17)" -ForegroundColor Green
        } else {
            Write-Host "   FAIL: menu_items count == $menuItemsCount (expected >= 17)" -ForegroundColor Red
            $allPass = $false
        }

        $resourcesCount = (& "$PgBin\psql.exe" -U $POSTGRES_USER -d $POSTGRES_DB -h localhost -tAc "SELECT COUNT(*) FROM resources").Trim()
        if ([int]$resourcesCount -gt 0) {
            Write-Host "   PASS: resources count == $resourcesCount (> 0)" -ForegroundColor Green
        } else {
            Write-Host "   FAIL: resources count == $resourcesCount (expected > 0)" -ForegroundColor Red
            $allPass = $false
        }
    } finally {
        $env:PGPASSWORD = ""
    }

    return $allPass
}

# -----------------------------------------------------------------------------
# Test-PostgresBackupRestoreProcedure
#   Driver: runs all three steps in sequence, exits non-zero on any failure.
# -----------------------------------------------------------------------------
function Test-PostgresBackupRestoreProcedure {
    Write-Host "`n=== Postgres Docker-to-Native Backup/Restore Procedure (synthetic data only) ===" -ForegroundColor Cyan

    New-SyntheticSourceBackup
    Restore-NativePostgres
    $ok = Test-RestoredData

    if ($ok) {
        Write-Host "`n=== PASS: dump/restore procedure verified against synthetic seed.py data ===" -ForegroundColor Green
        return $true
    } else {
        Write-Host "`n=== FAIL: one or more row-count checks did not match ===" -ForegroundColor Red
        return $false
    }
}

# Note: .\backups\ is created with default NTFS permissions here — no special
# ACL hardening, since this dump is synthetic-only per D-09 (T-02-17: accepted
# risk, zero real customer/business data). DATA-01's real-data backup handling
# in Phase 5 will need an actual access-control review; this script's synthetic
# dump deliberately does not attempt that.

if ($MyInvocation.InvocationName -ne '.') {
    $result = Test-PostgresBackupRestoreProcedure
    if (-not $result) { exit 1 }
}

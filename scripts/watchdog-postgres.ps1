# =============================================================================
# watchdog-postgres.ps1
# Minimal safety-net watchdog for the native PostgreSQL Windows service
# (SUP-01 parity, closing the residual gap `sc.exe failure`/`sc.exe
# failureflag` cannot cover on their own — see
# configure-postgres-failure-recovery.ps1's Step 2b comment block for the
# full root-cause explanation).
#
# WHY THIS EXISTS (found via a real live kill test, Plan 04-05 Task 1):
# Postgres's native Windows service is `pg_ctl.exe runservice -w`, which
# supervises the actual postmaster (postgres.exe) as its own child. When the
# postmaster dies unexpectedly, `pg_ctl.exe runservice` detects this and
# exits *itself* with exit code 0 -- a "clean" self-report from pg_ctl's own
# perspective. Windows Service Control Manager never invokes Recovery
# actions on a literal ERROR_SUCCESS (0) exit, regardless of
# `sc.exe failure`/`sc.exe failureflag` configuration -- confirmed live on
# staging: even with FAILURE_ACTIONS_ON_NONCRASH_FAILURES enabled, a real
# postmaster kill left the service `Stopped` for 30+ seconds with no
# auto-restart. This script is the pragmatic fallback: a short-interval
# polling check (registered via install-postgres-watchdog-task.ps1 as a
# repeating Task Scheduler task) that starts the service back up if it's
# ever found not Running.
#
# DELIBERATELY MINIMAL (per explicit scope): this is a safety net, not a
# full monitoring system. It does one thing -- check Get-Service status,
# Start-Service if not Running, log the action -- and nothing else. No
# alerting, no retries-with-backoff, no metrics. Matches the "warn/act
# quietly, never build more than what's needed" precedent set by
# check-health.ps1 (D-03) and configure-postgres-failure-recovery.ps1 (SUP-01).
#
# Only logs when it actually takes action (service found not Running) --
# deliberately silent on every healthy check, since this runs every 1
# minute forever and an entry-per-check would make C:\POS\logs\ grow
# unboundedly for no operational benefit (mirrors D-13's warn-never-spam
# philosophy).
#
# HOW TO RUN:
#   Manual one-off check (e.g. to test): .\scripts\watchdog-postgres.ps1
#   Continuous protection: register via install-postgres-watchdog-task.ps1
#   (runs this script automatically every ~1 minute via Task Scheduler).
# =============================================================================

$ErrorActionPreference = "Continue"

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PgServiceNameFile = Join-Path $BaseDir "scripts\.postgres-service-name.txt"
$LogDir = "C:\POS\logs"
$LogFile = Join-Path $LogDir "postgres-watchdog.log"

function Write-WatchdogLog([string]$Line) {
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    Add-Content -Path $LogFile -Value "$timestamp $Line"
}

# ---------------------------------------------------------------------------
# Read the Postgres service name the same way configure-postgres-failure-
# recovery.ps1 does -- reuse the persisted value install-postgres-native.ps1
# wrote, never re-scan "postgresql*" (a machine can have other, unrelated
# Postgres installations present).
# ---------------------------------------------------------------------------
if (-not (Test-Path $PgServiceNameFile)) {
    Write-WatchdogLog "WARNING watchdog-postgres: $PgServiceNameFile not found -- skipping check (Postgres not installed via install-postgres-native.ps1 yet?)."
    exit 0
}

$PgServiceName = (Get-Content $PgServiceNameFile -Raw -ErrorAction SilentlyContinue)
if ($PgServiceName) { $PgServiceName = $PgServiceName.Trim() }

if (-not $PgServiceName) {
    Write-WatchdogLog "WARNING watchdog-postgres: $PgServiceNameFile exists but is empty -- skipping check."
    exit 0
}

$svc = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-WatchdogLog "WARNING watchdog-postgres: no Windows service named '$PgServiceName' exists on this machine (stale $PgServiceNameFile?) -- skipping check."
    exit 0
}

# ---------------------------------------------------------------------------
# The actual check: if Postgres is not Running, start it and log the action.
# Nothing is logged on a healthy check -- see file header.
# ---------------------------------------------------------------------------
if ($svc.Status -ne 'Running') {
    Write-WatchdogLog "WARNING watchdog-postgres: service '$PgServiceName' was NOT Running (status=$($svc.Status)) -- issuing Start-Service."
    try {
        Start-Service -Name $PgServiceName -ErrorAction Stop
        Start-Sleep -Seconds 2
        $after = (Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue).Status
        Write-WatchdogLog "INFO watchdog-postgres: Start-Service issued for '$PgServiceName' -- status now $after."
    } catch {
        Write-WatchdogLog "ERROR watchdog-postgres: Start-Service failed for '$PgServiceName': $_"
    }
}

exit 0

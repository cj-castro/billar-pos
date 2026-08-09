# =============================================================================
# configure-postgres-failure-recovery.ps1
# Applies a crash-restart policy to the native PostgreSQL Windows service via
# `sc.exe failure`, closing the one supervision gap Phase 2 left open:
# Postgres is installed as its own vendor-standard Windows service (NOT
# NSSM-wrapped like backend/scheduler/telegram-bot/nginx/print-agent), so it
# never picked up the `AppExit Default Restart` + `AppRestartDelay 5000`
# crash-restart behavior every other native service already has
# (scripts/install-nssm-backend.ps1:199-200, install-nssm-nginx.ps1,
# install-nssm-telegram-bot.ps1, install-nssm-print-agent.ps1:138-139,
# install-nssm-scheduler.ps1) -- SUP-01 parity.
#
# `sc.exe failure` is the correct, standard Windows mechanism for a plain
# (non-NSSM) service's crash-restart policy -- see 04-RESEARCH.md's "Don't
# Hand-Roll" table entry for "Service auto-restart on crash": do not build a
# custom watchdog, use the OS-native primitive.
#
# Threat model (T-04-10, Denial of Service): a naive infinite fast-restart
# loop could pin CPU if Postgres is fundamentally broken (e.g. corrupt data
# directory). The policy below is deliberately bounded: 3 restart actions,
# each with a 5-second delay (matching NSSM's AppRestartDelay 5000 exactly),
# inside a 1-hour failure-counter reset window -- after 3 failed restarts
# within that hour, the Windows Service Control Manager stops retrying
# instead of looping forever.
#
# Safe to re-run: reapplying the same `sc.exe failure` configuration is a
# no-op (SCM simply overwrites the prior policy with an identical one).
#
# HOW TO RUN (one time, as Administrator, on the staging or bar machine,
# AFTER install-postgres-native.ps1 has already run at least once so
# scripts\.postgres-service-name.txt exists):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd <repo-root>
#   4. .\scripts\configure-postgres-failure-recovery.ps1
#
# Also called automatically at the end of install-postgres-native.ps1, so
# every fresh Postgres install gets this applied without a separate manual
# step.
# =============================================================================
#Requires -RunAsAdministrator

$ErrorActionPreference = "Continue"

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PgServiceNameFile = Join-Path $BaseDir "scripts\.postgres-service-name.txt"

Write-Host "`n=== PostgreSQL Native Service -- Failure Recovery Policy (SUP-01) ===" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Step 1: Read the already-discovered Postgres service name. Deliberately
# reuse the persisted value install-postgres-native.ps1 wrote, rather than
# re-scanning "postgresql*" via a fresh Get-Service wildcard -- a machine can
# have other, unrelated Postgres installations present (confirmed on the
# real staging machine, 2026-08-08: an unrelated Postgres 17 install already
# existed there), so guessing again here could silently apply this policy to
# the wrong service.
# ---------------------------------------------------------------------------
Write-Host "`n[1/3] Reading Postgres service name from $PgServiceNameFile..."

if (-not (Test-Path $PgServiceNameFile)) {
    Write-Host "   FAILED: $PgServiceNameFile not found. Run install-postgres-native.ps1 first -- the Postgres service name is always auto-discovered by that script, never assumed here." -ForegroundColor Yellow
    exit 0
}

$PgServiceName = (Get-Content $PgServiceNameFile -Raw -ErrorAction SilentlyContinue)
if ($PgServiceName) { $PgServiceName = $PgServiceName.Trim() }

if (-not $PgServiceName) {
    Write-Host "   FAILED: $PgServiceNameFile exists but is empty." -ForegroundColor Yellow
    exit 0
}

if (-not (Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue)) {
    Write-Host "   FAILED: no Windows service named '$PgServiceName' exists on this machine (stale $PgServiceNameFile?)." -ForegroundColor Yellow
    exit 0
}

Write-Host "   Target service: $PgServiceName" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 2: Apply the bounded restart policy via sc.exe failure.
#   reset= 3600            -- failure counter resets after 1 hour with no
#                              further failures
#   actions= restart/5000/restart/5000/restart/5000
#                           -- 3 restart attempts, each after a 5-second
#                              delay (matches NSSM's AppRestartDelay 5000
#                              exactly); after the 3rd failure within the
#                              reset window, SCM stops retrying (T-04-10).
#
# This is a non-blocking, best-effort configuration step: per this script
# family's existing convention (install-postgres-native.ps1,
# postgres-backup-restore.ps1), a failure here is reported clearly but never
# treated as a fatal `exit 1` -- Postgres itself is already installed and
# running; this only adds crash-recovery behavior on top of that.
# ---------------------------------------------------------------------------
Write-Host "`n[2/3] Applying sc.exe failure restart policy..."

& sc.exe failure "$PgServiceName" reset= 3600 actions= restart/5000/restart/5000/restart/5000 | Out-Null
$failureExitCode = $LASTEXITCODE

if ($failureExitCode -eq 0) {
    Write-Host "   Applied: reset=3600s, 3x restart actions with 5000ms delay (matches NSSM AppRestartDelay parity)." -ForegroundColor Green
} else {
    Write-Host "   WARNING: 'sc.exe failure' returned exit code $failureExitCode. Postgres itself is unaffected -- it just won't have automatic crash-restart configured yet. Re-run this script to try again." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Step 2b: Set the failure-actions flag so the restart policy above also
# fires on a "clean" (exit code 0) service termination, not only on a
# genuine crash exit code.
#
# WHY THIS IS REQUIRED (found via a real live kill test, Plan 04-05 Task 1):
# Postgres's native Windows service is NOT postgres.exe directly -- it's
# `pg_ctl.exe runservice -w`, which launches and supervises the actual
# postmaster (postgres.exe) as its own child. When the postmaster dies
# unexpectedly (e.g. `Stop-Process -Force` on the real postmaster PID, or
# any real OS-level crash), `pg_ctl.exe runservice` detects the child is
# gone and exits *itself* with exit code 0 -- from pg_ctl's own perspective
# this looks like a normal/expected shutdown, not a failure. Windows SCM's
# `sc.exe failure` recovery actions only apply to *non-zero* (crash) exit
# codes by default (`FAILURE_ACTIONS_ON_NONCRASH_FAILURES: FALSE`, confirmed
# via `sc.exe qfailureflag`) -- so a real Postgres crash was silently NOT
# triggering the restart policy configured in Step 2 above, leaving Postgres
# permanently down until a human manually ran `Start-Service`. This is
# exactly the gap `sc.exe failureflag <service> 1` exists to close: it tells
# SCM to apply the configured failure actions even when the service process
# exits with code 0, which is the only way to get genuine SUP-01 parity for
# Postgres given how `pg_ctl.exe runservice` reports its own exit status.
# ---------------------------------------------------------------------------
Write-Host "`n[2b/3] Enabling failure actions on non-crash (exit code 0) terminations..."

& sc.exe failureflag "$PgServiceName" 1 | Out-Null
$failureFlagExitCode = $LASTEXITCODE

if ($failureFlagExitCode -eq 0) {
    Write-Host "   Applied: FAILURE_ACTIONS_ON_NONCRASH_FAILURES enabled -- the restart policy above now also fires when pg_ctl.exe's monitored postmaster dies and pg_ctl exits with code 0 (its normal self-reported exit path on an unexpected postmaster death)." -ForegroundColor Green
} else {
    Write-Host "   WARNING: 'sc.exe failureflag' returned exit code $failureFlagExitCode. The restart policy from Step 2 will only apply to non-zero-exit-code failures, not the pg_ctl.exe clean-exit-on-crashed-child case. Re-run this script to try again." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Step 3: Print the applied policy so an operator can visually confirm it.
# ---------------------------------------------------------------------------
Write-Host "`n[3/3] Current failure policy (sc.exe qfailure / qfailureflag):"
& sc.exe qfailure "$PgServiceName"
& sc.exe qfailureflag "$PgServiceName"

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Service:       $PgServiceName"
Write-Host " Reset window:  3600 seconds (1 hour)"
Write-Host " Actions:       restart / 5000ms x3 (bounded -- prevents infinite fast-restart loop)"
Write-Host " Non-crash flag: enabled (restart policy also applies to pg_ctl.exe's own clean exit-code-0 when its postmaster child dies)"
Write-Host "============================================================"

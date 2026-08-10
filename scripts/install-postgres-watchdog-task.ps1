# =============================================================================
# install-postgres-watchdog-task.ps1
# Registers a Windows Task Scheduler task that runs watchdog-postgres.ps1
# every ~1 minute, indefinitely, as SYSTEM -- the safety-net fix for the
# residual SUP-01 gap `sc.exe failure`/`sc.exe failureflag` cannot close on
# their own (see watchdog-postgres.ps1's header and
# configure-postgres-failure-recovery.ps1's Step 2b comment for the full
# root-cause explanation: `pg_ctl.exe runservice` self-reports exit code 0
# when its supervised postmaster dies, which Windows SCM never treats as a
# failure worth a Recovery action, regardless of failure-actions config).
#
# 1-minute granularity is the realistic floor for a Task Scheduler
# repeating trigger on Windows -- shorter intervals are not reliably
# supported by the Task Scheduler engine. This is a coarse safety net (up
# to ~60s of downtime before the watchdog notices), not a replacement for
# NSSM's <10s AppExit restart on the 5 wrapped services; it exists because
# Postgres has no equivalent fast, in-process restart hook available to it.
#
# Idempotent: safe to re-run any time (e.g. after this script itself
# changes) -- unregisters any existing task with the same name first, then
# re-registers fresh, matching the pattern of other install-*.ps1/
# configure-*.ps1 scripts in this directory.
#
# HOW TO RUN (one time, as Administrator, on the staging or bar machine,
# AFTER install-postgres-native.ps1 has already run at least once so
# scripts\.postgres-service-name.txt exists and watchdog-postgres.ps1 has
# something to check):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd <repo-root>
#   4. .\scripts\install-postgres-watchdog-task.ps1
#
# Also called automatically at the end of install-postgres-native.ps1, so
# every fresh Postgres install gets watchdog protection without a separate
# manual step (same wiring pattern Plan 04-03 used for
# configure-postgres-failure-recovery.ps1).
# =============================================================================
#Requires -RunAsAdministrator

$ErrorActionPreference = "Continue"

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$WatchdogScript = Join-Path $BaseDir "scripts\watchdog-postgres.ps1"
$TaskName = "BilliardBarPostgresWatchdog"

Write-Host "`n=== PostgreSQL Watchdog -- Task Scheduler Registration (SUP-01) ===" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Step 1: Confirm the watchdog script this task will run actually exists.
# ---------------------------------------------------------------------------
Write-Host "`n[1/3] Confirming $WatchdogScript exists..."
if (-not (Test-Path $WatchdogScript)) {
    Write-Host "   FAILED: $WatchdogScript not found. Deploy watchdog-postgres.ps1 first." -ForegroundColor Red
    exit 1
}
Write-Host "   Found." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 2: Unregister any existing task with the same name (idempotent --
# always re-register fresh rather than skipping, so a re-run after this
# script's own logic changes actually picks up the new configuration).
# ---------------------------------------------------------------------------
Write-Host "`n[2/3] Registering Scheduled Task '$TaskName'..."

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Host "   Existing task found -- unregistering before re-registering." -ForegroundColor Gray
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$WatchdogScript`""

# Two triggers:
#   (1) AtStartup -- fires once as soon as possible after the machine boots,
#       so a crashed-then-rebooted Postgres gets checked immediately rather
#       than waiting up to 60s for the first repeating tick.
#   (2) A repeating "-Once -At <now> -RepetitionInterval 1min
#       -RepetitionDuration <N years>" trigger -- the standard PowerShell
#       ScheduledTasks-module pattern for "run every N minutes, effectively
#       indefinitely" (there is no direct "-Indefinitely" switch).
#       [TimeSpan]::MaxValue was tried first and rejected by
#       Register-ScheduledTask ("task XML contains a value which is
#       incorrectly formatted or out of range" -- P99999999D exceeds the
#       Task Scheduler XML schema's accepted duration range, confirmed live
#       on staging). 10 years is comfortably within the schema's range and
#       is "indefinite" for any realistic operational lifetime of this
#       machine -- re-running this installer (e.g. as part of a future
#       re-provision) resets the 10-year window anyway.
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$repeatingTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# StartWhenAvailable: if the machine was asleep/off at a scheduled tick,
# run it as soon as possible instead of skipping. AllowStartIfOnBatteries /
# DontStopIfGoingOnBatteries: this is a desktop-class always-on POS/staging
# machine, not a laptop expected to run on battery -- but setting these
# defensively costs nothing and avoids a surprise "watchdog silently
# stopped running" if the machine ever is briefly on battery power.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $TaskName `
    -Action $action `
    -Trigger @($startupTrigger, $repeatingTrigger) `
    -Principal $principal `
    -Settings $settings `
    -Description "SUP-01 safety net: checks the native PostgreSQL service every ~1 minute and restarts it if not Running (Phase 4, Plan 04-05 -- closes the pg_ctl.exe exit-code-0 gap sc.exe failure/failureflag cannot cover)." `
    | Out-Null

Write-Host "   Registered '$TaskName': AtStartup + every 1 minute indefinitely, as SYSTEM." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 3: Print the registered task so an operator can visually confirm it.
# ---------------------------------------------------------------------------
Write-Host "`n[3/3] Current task registration:"
Get-ScheduledTask -TaskName $TaskName | Format-List TaskName, State
(Get-ScheduledTask -TaskName $TaskName).Triggers | Format-List

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Task name:   $TaskName"
Write-Host " Runs:        $WatchdogScript"
Write-Host " Schedule:    at startup, then every 1 minute indefinitely"
Write-Host " Account:     SYSTEM"
Write-Host " Log:         C:\POS\logs\postgres-watchdog.log (only written on action, not every check)"
Write-Host "============================================================"

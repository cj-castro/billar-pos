# =============================================================================
# reconfigure-log-paths.ps1
# Phase 3 - Repoints all 5 Phase 2 NSSM services' stdout/stderr logs to the
# shared, ACL-restricted C:\POS\logs\ directory (LOG-01/D-01), preserving each
# service's existing AppRotateFiles/AppRotateBytes rotation settings (LOG-02).
#
# Does NOT edit any install-nssm-*.ps1 file (D-03) -- it only reconfigures
# already-installed NSSM services in place via `nssm set`.
#
# Per-service flow: nssm stop -> nssm set AppStdout/AppStderr/AppRotate* ->
# nssm get (verify) -> nssm start. AppStdout/AppStderr only take effect on a
# stopped service, so each service is always stopped before reconfiguration.
#
# HOW TO RUN (one time, as Administrator, after all 5 Phase 2 services are
# installed and running):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd <repo root>
#   4. .\scripts\reconfigure-log-paths.ps1
#
# Safe to re-run: each service is skipped if not installed, and AppStdout is
# verified via `nssm get` after every `nssm set` before restarting.
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogsDir = "C:\POS\logs"
$NssmExe = $null

Write-Host "`n=== Phase 3: Reconfigure NSSM Log Paths to $LogsDir ===" -ForegroundColor Cyan

# -- Step 1: Ensure the shared log directory exists and is ACL-restricted -----
Write-Host "`n[1/3] Ensuring $LogsDir exists and is ACL-restricted..."
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
    Write-Host "   Created $LogsDir" -ForegroundColor Green
} else {
    Write-Host "   Log directory already exists: $LogsDir" -ForegroundColor Gray
}

# T-03-01 mitigation: restrict the directory to Administrators + SYSTEM only,
# breaking inheritance so it is never accidentally world-readable. Run before
# any service writes to it.
& icacls $LogsDir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
Write-Host "   ACL restricted to Administrators + SYSTEM (icacls /inheritance:r)" -ForegroundColor Green

# -- Step 2: Locate NSSM (reuse Phase 2's exact fallback chain) ---------------
Write-Host "`n[2/3] Locating NSSM..."
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

# -- Step 3: Reconfigure each Phase 2 service ----------------------------------
Write-Host "`n[3/3] Reconfiguring service log paths..."

# Service names must match Phase 2's install-nssm-*.ps1 exactly. RotateBytes
# values are carried over verbatim from each service's current Phase 2
# install script (print-agent is the one outlier at 1MB; the other four use
# 10MB) -- this script sets them explicitly rather than reading them back via
# `nssm get`, so the values are preserved even if never previously set.
$services = @(
    @{ Name = "BilliardBarBackend";     Stdout = "backend.log";        Stderr = "backend_err.log";        RotateBytes = 10485760 },
    @{ Name = "BilliardBarScheduler";   Stdout = "scheduler.log";      Stderr = "scheduler_err.log";      RotateBytes = 10485760 },
    @{ Name = "BilliardBarTelegramBot"; Stdout = "telegram_bot.log";   Stderr = "telegram_bot_err.log";   RotateBytes = 10485760 },
    @{ Name = "BilliardBarPrintAgent";  Stdout = "print_agent.log";    Stderr = "print_agent_err.log";    RotateBytes = 1048576  },
    @{ Name = "BilliardBarNginx";       Stdout = "nginx_service.log";  Stderr = "nginx_service_err.log";  RotateBytes = 10485760 }
)

$summary = @()

foreach ($svc in $services) {
    $serviceName = $svc.Name
    Write-Host "`n[*] $serviceName" -ForegroundColor Yellow

    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "    Service not installed -- skipping (run Phase 2 install-nssm-*.ps1 first)." -ForegroundColor Gray
        continue
    }

    $oldStdout = & $NssmExe get $serviceName AppStdout 2>$null
    $stdoutPath = Join-Path $LogsDir $svc.Stdout
    $stderrPath = Join-Path $LogsDir $svc.Stderr

    # AppStdout/AppStderr only take effect once the service is stopped --
    # Pitfall 1 / T-03-02: nssm set on a running service silently no-ops
    # until restart, so we always stop first.
    Write-Host "    Stopping service..." -ForegroundColor Yellow
    & $NssmExe stop $serviceName confirm 2>&1 | Out-Null
    Start-Sleep -Seconds 2

    Write-Host "    Setting AppStdout: $stdoutPath" -ForegroundColor Green
    & $NssmExe set $serviceName AppStdout $stdoutPath 2>&1 | Out-Null
    Write-Host "    Setting AppStderr: $stderrPath" -ForegroundColor Green
    & $NssmExe set $serviceName AppStderr $stderrPath 2>&1 | Out-Null
    & $NssmExe set $serviceName AppRotateFiles 1 2>&1 | Out-Null
    & $NssmExe set $serviceName AppRotateBytes $svc.RotateBytes 2>&1 | Out-Null

    # Verify AppStdout was actually applied before proceeding -- do not report
    # false success if nssm set failed for any reason.
    $verifyStdout = & $NssmExe get $serviceName AppStdout
    if ($verifyStdout -ne $stdoutPath) {
        Write-Host "    ERROR: AppStdout verification failed! Expected '$stdoutPath', got '$verifyStdout'" -ForegroundColor Red
        exit 1
    }

    Write-Host "    Starting service..." -ForegroundColor Yellow
    & $NssmExe start $serviceName 2>&1 | Out-Null
    Start-Sleep -Seconds 3

    $svcStatus = (Get-Service -Name $serviceName -ErrorAction SilentlyContinue).Status
    if ($svcStatus -eq "Running") {
        Write-Host "    $serviceName is running" -ForegroundColor Green
    } else {
        Write-Host "    WARNING: $serviceName status is '$svcStatus' -- check $stderrPath" -ForegroundColor Yellow
    }

    $summary += [PSCustomObject]@{
        Service = $serviceName
        OldPath = $oldStdout
        NewPath = $stdoutPath
    }
}

Write-Host "`n=== Reconfiguration Summary ===" -ForegroundColor Cyan
$summary | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "All reconfigured service logs now live under: $LogsDir" -ForegroundColor Green
Write-Host "Run .\scripts\tail-logs.ps1 next to watch them live." -ForegroundColor Cyan

# =============================================================================
# rotate-nginx-logs.ps1
# Phase 3 - Daily rotation + pruning of nginx's native access/error logs
# (C:\POS\logs\nginx_access.log / nginx_error.log). nginx has no built-in log
# rotation on Windows (no logrotate equivalent), so this fills that gap
# (D-02's follow-on, T-03-03).
#
# HOW TO RUN:
#   Default (one rotation pass, as Administrator):
#     .\scripts\rotate-nginx-logs.ps1
#
#   Register as a daily 02:00 Windows Scheduled Task running as SYSTEM
#   (one-time setup, as Administrator):
#     .\scripts\rotate-nginx-logs.ps1 -Register
#
# What the default pass does:
#   - Renames nginx_access.log / nginx_error.log to a dated archive name
#   - Restarts BilliardBarNginx so nginx reopens fresh log files (Windows
#     cannot free disk space from a renamed-but-still-open file -- a restart,
#     not just a signal, is required; see Pitfall 3 in 03-RESEARCH.md)
#   - Prunes archived nginx_access.log.*/nginx_error.log.* files older than
#     $MaxDays days
# =============================================================================
#Requires -RunAsAdministrator

param(
    [switch]$Register
)

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir  = "C:\POS\logs"
$MaxDays = 30
$TaskName = "BilliardBarNginxLogRotation"
$NssmExe = $null

if ($Register) {
    Write-Host "`n=== Registering Scheduled Task: $TaskName ===" -ForegroundColor Cyan

    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Write-Host "Scheduled Task '$TaskName' already exists -- skipping re-registration (idempotent)." -ForegroundColor Gray
        exit 0
    }

    $scriptPath = $MyInvocation.MyCommand.Path
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
                 -Argument "-ExecutionPolicy Bypass -File `"$scriptPath`""
    $trigger = New-ScheduledTaskTrigger -Daily -At "02:00"
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Description "Daily rotation + prune of nginx's native access/error logs (Phase 3)" | Out-Null

    Write-Host "Registered '$TaskName' to run daily at 02:00 as SYSTEM." -ForegroundColor Green
    Write-Host "Action: powershell.exe -ExecutionPolicy Bypass -File `"$scriptPath`"" -ForegroundColor Gray
    exit 0
}

# -- Default (non-register) path: one rotation pass ---------------------------
Write-Host "`n=== Rotating nginx logs in $LogDir ===" -ForegroundColor Cyan

$date = Get-Date -Format "yyyy-MM-dd"
$rotatedAny = $false

if (Test-Path "$LogDir\nginx_access.log") {
    Move-Item "$LogDir\nginx_access.log" "$LogDir\nginx_access.log.$date" -Force
    Write-Host "Rotated nginx_access.log -> nginx_access.log.$date" -ForegroundColor Green
    $rotatedAny = $true
}

if (Test-Path "$LogDir\nginx_error.log") {
    Move-Item "$LogDir\nginx_error.log" "$LogDir\nginx_error.log.$date" -Force
    Write-Host "Rotated nginx_error.log -> nginx_error.log.$date" -ForegroundColor Green
    $rotatedAny = $true
}

if (-not $rotatedAny) {
    Write-Host "No active nginx_access.log/nginx_error.log found -- nothing to rotate." -ForegroundColor Gray
}

# Windows cannot free disk space from a renamed-but-still-open file -- nginx
# must be restarted so it reopens fresh log file handles at the original
# paths (Pitfall 3). Reuse the NSSM-locate fallback chain.
if ($rotatedAny) {
    foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                      "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                      "$BaseDir\scripts\nssm.exe")) {
        try {
            $v = & $p version 2>&1
            if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
        } catch {}
    }

    if ($NssmExe -and (Get-Service -Name "BilliardBarNginx" -ErrorAction SilentlyContinue)) {
        Write-Host "Restarting BilliardBarNginx to reopen log files..." -ForegroundColor Yellow
        & $NssmExe restart BilliardBarNginx 2>&1 | Out-Null
        Write-Host "BilliardBarNginx restarted." -ForegroundColor Green
    } else {
        Write-Host "WARNING: NSSM or BilliardBarNginx service not found -- nginx will keep writing to the renamed file handle until manually restarted." -ForegroundColor Yellow
    }
}

# -- Prune archived logs older than $MaxDays days ------------------------------
$old = Get-ChildItem "$LogDir\nginx_access.log.*", "$LogDir\nginx_error.log.*" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$MaxDays) }

if ($old.Count -gt 0) {
    $old | Remove-Item -Force
    Write-Host "Pruned $($old.Count) archived log file(s) older than $MaxDays days." -ForegroundColor Green
} else {
    Write-Host "No archived logs older than $MaxDays days to prune." -ForegroundColor Gray
}

Write-Host "`nDone." -ForegroundColor Green

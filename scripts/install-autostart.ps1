# =============================================================================
# setup-windows.ps1
# Billiard Bar POS — Windows Task Scheduler setup
#
# Registers TWO scheduled tasks:
#   1. BilliardBarPOS-Start  → auto-starts the stack at login
#   2. BilliardBarPOS-Backup → daily database backup at 3:00 AM
#
# HOW TO RUN (one time only, on the Windows machine):
#   1. Open PowerShell as Administrator
#   2. Navigate to the project folder, e.g.:
#        cd C:\Users\YourName\billiards
#   3. Allow script execution (if needed):
#        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   4. Run:
#        .\scripts\setup-windows.ps1
# =============================================================================

# ── CONFIGURATION — edit these two lines to match your environment ────────────
$wslDistro   = "Ubuntu"          # Run `wsl -l` in PowerShell to see your distro name
$projectPath = "/opt/billiards"  # Path to the project INSIDE WSL (Linux path)
# ─────────────────────────────────────────────────────────────────────────────

# Require Administrator
if (-not ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(`
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "❌ Please run this script as Administrator."
    exit 1
}

$wslExe = "$env:SystemRoot\System32\wsl.exe"

# ── 1. AUTO-START on login ────────────────────────────────────────────────────
Write-Host "`n[1/2] Registering auto-start task..."

$startAction = New-ScheduledTaskAction `
    -Execute $wslExe `
    -Argument "-d $wslDistro bash $projectPath/scripts/start.sh"

$startTrigger = New-ScheduledTaskTrigger -AtLogOn

$startSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 2) `
    -StartWhenAvailable $true

Register-ScheduledTask `
    -TaskName    "BilliardBarPOS-Start" `
    -Description "Auto-start Billiard Bar POS stack on user login" `
    -Action      $startAction `
    -Trigger     $startTrigger `
    -Settings    $startSettings `
    -RunLevel    Highest `
    -Force | Out-Null

Write-Host "   ✅ BilliardBarPOS-Start registered (runs at login)"

# ── 2. DAILY BACKUP at 03:00 AM ───────────────────────────────────────────────
Write-Host "`n[2/2] Registering daily backup task..."

$backupAction = New-ScheduledTaskAction `
    -Execute $wslExe `
    -Argument "-d $wslDistro bash $projectPath/scripts/backup.sh"

$backupTrigger = New-ScheduledTaskTrigger -Daily -At "03:00AM"

$backupSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -StartWhenAvailable $true `
    -WakeToRun $false

Register-ScheduledTask `
    -TaskName    "BilliardBarPOS-Backup" `
    -Description "Daily PostgreSQL backup for Billiard Bar POS (keeps 7 days)" `
    -Action      $backupAction `
    -Trigger     $backupTrigger `
    -Settings    $backupSettings `
    -RunLevel    Highest `
    -Force | Out-Null

Write-Host "   ✅ BilliardBarPOS-Backup registered (runs daily at 3:00 AM)"

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host "`n=============================================="
Write-Host " Setup complete! Two tasks registered:"
Write-Host "   • BilliardBarPOS-Start  → runs at every login"
Write-Host "   • BilliardBarPOS-Backup → runs daily at 3:00 AM"
Write-Host ""
Write-Host " To verify, open Task Scheduler and look under:"
Write-Host "   Task Scheduler Library → BilliardBarPOS-*"
Write-Host ""
Write-Host " To run the backup right now (test it):"
Write-Host "   Start-ScheduledTask -TaskName 'BilliardBarPOS-Backup'"
Write-Host "=============================================="

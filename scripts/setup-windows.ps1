# Billiard Bar POS - Windows Task Scheduler Setup
# Run as Administrator:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\scripts\setup-windows.ps1

$proj = "C:\Users\bola8lacalma\Desktop\POS\billiards"
$scr  = Join-Path $proj "scripts"

New-Item -Force -ItemType Directory (Join-Path $proj "backups") | Out-Null

# Remove old broken tasks if any
Unregister-ScheduledTask -TaskName "BilliardBarPOS-Start"  -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "BilliardBarPOS-Backup" -Confirm:$false -ErrorAction SilentlyContinue

# Task 1: Auto-start at login
$startFile = Join-Path $scr "start-pos.ps1"
$a1 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NonInteractive -WindowStyle Hidden -File " + $startFile)
Register-ScheduledTask -TaskName "BilliardBarPOS-Start" -Action $a1 -Trigger (New-ScheduledTaskTrigger -AtLogOn) -RunLevel Highest -Force | Out-Null
Write-Host "OK: BilliardBarPOS-Start registered (runs at login)"

# Task 2: Daily backup at 3 AM
$backupFile = Join-Path $scr "backup-pos.ps1"
$a2 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NonInteractive -WindowStyle Hidden -File " + $backupFile)
Register-ScheduledTask -TaskName "BilliardBarPOS-Backup" -Action $a2 -Trigger (New-ScheduledTaskTrigger -Daily -At "03:00AM") -RunLevel Highest -Force | Out-Null
Write-Host "OK: BilliardBarPOS-Backup registered (runs daily at 3 AM)"

# Test backup right now
Write-Host ""
Write-Host "Running backup test..."
& $backupFile

Write-Host ""
Write-Host "All done!"
Write-Host "Backups saved to: $(Join-Path $proj 'backups')"

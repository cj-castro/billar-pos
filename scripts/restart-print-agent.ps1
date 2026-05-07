# restart-print-agent.ps1
# Kills zombie print agent processes, restarts the NSSM service.
# Options:
#   .\restart-print-agent.ps1            - normal restart
#   .\restart-print-agent.ps1 -NoLogo   - disable logo (fallback)
#   .\restart-print-agent.ps1 -Rollback - restore last backup

param([switch]$NoLogo, [switch]$Rollback)

$ServiceName = 'BilliardBarPrintAgent'
$Port        = 9191
$AgentDir    = "$PSScriptRoot\print_agent"
$AgentFile   = "$AgentDir\print_agent.py"
$BackupFile  = "$AgentDir\print_agent.py.bak"

Write-Host ""
Write-Host "=== Bola 8 Print Agent Recovery ===" -ForegroundColor Cyan

if ($Rollback) {
    if (Test-Path $BackupFile) {
        Copy-Item $BackupFile $AgentFile -Force
        Write-Host "[ROLLBACK] Restored print_agent.py from backup." -ForegroundColor Yellow
    } else {
        Write-Host "[!] No backup found. Cannot rollback." -ForegroundColor Red
        exit 1
    }
}

if (-not $Rollback -and (Test-Path $AgentFile)) {
    Copy-Item $AgentFile $BackupFile -Force
    Write-Host "[0] Backup saved: print_agent.py.bak" -ForegroundColor Gray
}

if ($NoLogo) {
    [System.Environment]::SetEnvironmentVariable('DISABLE_LOGO', '1', 'Machine')
    Write-Host "[!] Logo DISABLED via DISABLE_LOGO=1" -ForegroundColor Yellow
} else {
    [System.Environment]::SetEnvironmentVariable('DISABLE_LOGO', $null, 'Machine')
}

Write-Host "[1] Stopping service..." -ForegroundColor Yellow
Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "[2] Killing processes on port $Port..." -ForegroundColor Yellow
$lines = netstat -ano | Select-String ":$Port\s"
$pids  = $lines | ForEach-Object { ($_ -split "\s+")[-1] } | Sort-Object -Unique
foreach ($p in $pids) {
    if ($p -match "^\d+$" -and $p -ne "0") {
        try   { Stop-Process -Id ([int]$p) -Force -ErrorAction Stop; Write-Host "  Killed PID $p" -ForegroundColor Gray }
        catch { Write-Host "  PID $p already gone" -ForegroundColor Gray }
    }
}
Start-Sleep -Seconds 1

$still = netstat -ano | Select-String ":$Port\s"
if ($still) {
    Write-Host "[!] Port $Port still in use!" -ForegroundColor Red
} else {
    Write-Host "[2] Port $Port is clear." -ForegroundColor Green
}

Write-Host "[3] Starting service..." -ForegroundColor Yellow
Start-Service $ServiceName
Start-Sleep -Seconds 3

Write-Host "[4] Health check..." -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "[OK] Agent is up: $($r.Content)" -ForegroundColor Green
} catch {
    Write-Host "[!] Health check FAILED. Check: http://localhost:$Port/health" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
if ($Rollback) { Write-Host "    Rolled back to previous version." -ForegroundColor Yellow }
if ($NoLogo)   { Write-Host "    Logo is OFF. Run without -NoLogo to re-enable." -ForegroundColor Yellow }

# restart-print-agent.ps1
# Kills all zombie print agent processes on port 9191, then restarts the NSSM service.
# Run as Administrator if Stop-Service requires elevation.

$ServiceName = 'BilliardBarPrintAgent'
$Port        = 9191

Write-Host "`n=== Bola 8 Print Agent Recovery ===" -ForegroundColor Cyan

# 1. Stop the NSSM service (ignore error if already stopped)
Write-Host "`n[1] Stopping service '$ServiceName'..." -ForegroundColor Yellow
Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 2. Kill every process still bound to port 9191
Write-Host "[2] Killing any process on port $Port..." -ForegroundColor Yellow
$netstat = netstat -ano | Select-String ":$Port\s"
$pids = $netstat | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Sort-Object -Unique

foreach ($p in $pids) {
    if ($p -match '^\d+$' -and $p -ne '0') {
        try {
            Stop-Process -Id ([int]$p) -Force -ErrorAction Stop
            Write-Host "  Killed PID $p" -ForegroundColor Gray
        } catch {
            Write-Host "  PID $p already gone" -ForegroundColor Gray
        }
    }
}
Start-Sleep -Seconds 1

# 3. Verify port is clear
$still = netstat -ano | Select-String ":$Port\s"
if ($still) {
    Write-Host "[!] WARNING: port $Port still in use:" -ForegroundColor Red
    $still | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "[2] Port $Port is clear." -ForegroundColor Green
}

# 4. Start the service
Write-Host "[3] Starting service '$ServiceName'..." -ForegroundColor Yellow
Start-Service $ServiceName
Start-Sleep -Seconds 3

# 5. Health check
Write-Host "[4] Health check..." -ForegroundColor Yellow
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "[OK] Print agent is up: $($resp.Content)" -ForegroundColor Green
} catch {
    Write-Host "[!] Health check FAILED — service may still be starting. Try again in 5s." -ForegroundColor Red
    Write-Host "    Manual check: http://localhost:$Port/health"
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan

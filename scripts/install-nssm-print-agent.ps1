# =============================================================================
# install-nssm-print-agent.ps1
# Bola 8 Print Agent - installs as a REAL Windows Service using NSSM
#
# [OK] Starts at BOOT (no login required - even headless servers)
# [OK] Auto-restarts on crash
# [OK] Manageable via services.msc or "nssm start/stop/restart BilliardBarPrintAgent"
#
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd C:\Users\bola8lacalma\Desktop\POS\billiards
#   4. .\scripts\install-nssm-print-agent.ps1
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AgentDir  = Join-Path $BaseDir "scripts\print_agent"
$VenvPy    = Join-Path $AgentDir "venv\Scripts\pythonw.exe"
$Script    = Join-Path $AgentDir "print_agent.py"
$ServiceName = "BilliardBarPrintAgent"
$NssmExe   = $null

Write-Host "`n=== Bola 8 Print Agent - Windows Service Installer ===" -ForegroundColor Cyan
Write-Host "   Service will start at BOOT - no login required.`n"

# -- Step 1: Find or install NSSM ---------------------------------------------
Write-Host "[1/6] Locating NSSM..."
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                  "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                  "$BaseDir\scripts\nssm.exe")) {
    try {
        $v = & $p version 2>&1
        if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
    } catch {}
}

if (-not $NssmExe) {
    Write-Host "   NSSM not found. Trying to install via Chocolatey..." -ForegroundColor Yellow
    $chocoOk = $false
    try {
        & choco install nssm -y --no-progress 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $NssmExe = "nssm"; $chocoOk = $true }
    } catch {}

    if (-not $chocoOk) {
        Write-Host "   Chocolatey not available. Downloading NSSM directly..." -ForegroundColor Yellow
        $nssmZip  = "$env:TEMP\nssm.zip"
        $nssmDir  = "$env:TEMP\nssm_extract"
        $nssmDest = "$BaseDir\scripts\nssm.exe"
        try {
            Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" `
                -OutFile $nssmZip -UseBasicParsing -TimeoutSec 30
            Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force
            $exe = Get-ChildItem -Path $nssmDir -Recurse -Filter "nssm.exe" |
                   Where-Object { $_.FullName -match 'win64' } |
                   Select-Object -First 1
            if (-not $exe) {
                $exe = Get-ChildItem -Path $nssmDir -Recurse -Filter "nssm.exe" |
                       Select-Object -First 1
            }
            Copy-Item $exe.FullName -Destination $nssmDest -Force
            $NssmExe = $nssmDest
            Write-Host "   NSSM downloaded to $nssmDest" -ForegroundColor Green
        } catch {
            Write-Host "   Failed to download NSSM: $_" -ForegroundColor Red
            Write-Host "   Manual install: https://nssm.cc/download -> copy nssm.exe to scripts\" -ForegroundColor Yellow
            exit 1
        }
    }
}
Write-Host "   NSSM found: $NssmExe" -ForegroundColor Green

# -- Step 2: Ensure Python venv + packages ------------------------------------
Write-Host "`n[2/6] Checking Python environment..."
$python = $null
foreach ($p in @("python", "python3", "py")) {
    try {
        $v = & $p --version 2>&1
        if ($LASTEXITCODE -eq 0) { $python = $p; break }
    } catch {}
}
if (-not $python) {
    Write-Host "   Python not found. Run: winget install Python.Python.3.11" -ForegroundColor Red; exit 1
}
Write-Host "   Python: $python" -ForegroundColor Green

if (-not (Test-Path $VenvPy)) {
    Write-Host "   Creating virtualenv..." -ForegroundColor Yellow
    & $python -m venv "$AgentDir\venv"
}
Write-Host "   Installing/updating packages..." -ForegroundColor Yellow
& "$AgentDir\venv\Scripts\pip.exe" install flask pywin32 --quiet --upgrade

# -- Step 3: Remove old Task Scheduler task if it exists ----------------------
Write-Host "`n[3/6] Cleaning up old Task Scheduler task (if any)..."
$oldTask = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
if ($oldTask) {
    Stop-ScheduledTask  -TaskName $ServiceName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
    Write-Host "   Old scheduled task removed." -ForegroundColor Yellow
} else {
    Write-Host "   No old task found - OK." -ForegroundColor Gray
}

# -- Step 4: Stop & remove existing service if reinstalling -------------------
Write-Host "`n[4/6] Registering Windows Service..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Stopping existing service..." -ForegroundColor Yellow
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

# Register the service
& $NssmExe install $ServiceName $VenvPy $Script
& $NssmExe set $ServiceName AppDirectory $AgentDir
& $NssmExe set $ServiceName AppStdout    (Join-Path $AgentDir "print_agent.log")
& $NssmExe set $ServiceName AppStderr    (Join-Path $AgentDir "print_agent_err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 1048576   # rotate at 1 MB
& $NssmExe set $ServiceName Start SERVICE_AUTO_START  # start at boot
& $NssmExe set $ServiceName ObjectName LocalSystem    # run as SYSTEM (has printer access)

# Restart policy: restart on failure after 5s, up to 3 times
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000

Write-Host "   Service '$ServiceName' registered." -ForegroundColor Green

# -- Step 5: Open Windows Firewall port 9191 -----------------------------------
Write-Host "`n[5/6] Opening firewall port 9191 (LAN/mobile access)..."
$ruleName = "BilliardBarPrintAgent"
$ruleExists = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ($LASTEXITCODE -ne 0) {
    netsh advfirewall firewall add rule `
        name="$ruleName" dir=in action=allow protocol=TCP localport=9191 | Out-Null
    Write-Host "   Firewall rule added (port 9191 open)." -ForegroundColor Green
} else {
    Write-Host "   Firewall rule already exists." -ForegroundColor Gray
}

# -- Step 6: Start service and verify -----------------------------------------
Write-Host "`n[6/6] Starting service..."
& $NssmExe start $ServiceName
Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "   Service is RUNNING [OK]" -ForegroundColor Green
} else {
    Write-Host "   Service status: $($svc.Status)" -ForegroundColor Yellow
    Write-Host "   Check log: $AgentDir\print_agent_err.log" -ForegroundColor Yellow
}

try {
    $r = Invoke-RestMethod -Uri "http://localhost:9191/health" -TimeoutSec 8
    Write-Host "   Health check: status=$($r.status) printer='$($r.printer)'" -ForegroundColor Green
    Write-Host "`n   Run .\scripts\test-print-agent.ps1 to verify printers + LAN access." -ForegroundColor Cyan
} catch {
    Write-Host "   Health check failed - wait 10s and retry: Invoke-RestMethod http://localhost:9191/health" -ForegroundColor Yellow
}

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Service management commands:"
Write-Host "   Start:   nssm start $ServiceName"
Write-Host "   Stop:    nssm stop  $ServiceName"
Write-Host "   Restart: nssm restart $ServiceName"
Write-Host "   Logs:    $AgentDir\print_agent.log"
Write-Host "   Status:  Get-Service $ServiceName"
Write-Host "============================================================"
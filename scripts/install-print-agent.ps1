$BaseDir  = "C:\Users\bola8lacalma\Desktop\POS\billiards"
$AgentDir = "$BaseDir\scripts\print_agent"
$VenvPy   = "$AgentDir\venv\Scripts\python.exe"
$Script   = "$AgentDir\print_agent.py"
$TaskName = "BilliardBarPrintAgent"

Write-Host "=== Bola 8 Print Agent Installer ===" -ForegroundColor Cyan

$python = $null
foreach ($p in @("python", "python3", "py")) {
    try {
        $v = & $p --version 2>&1
        if ($LASTEXITCODE -eq 0) { $python = $p; break }
    } catch {}
}

if (-not $python) {
    Write-Host "Python not found." -ForegroundColor Red
    Write-Host "Run: winget install Python.Python.3.11" -ForegroundColor Yellow
    exit 1
}

Write-Host "Python: $python" -ForegroundColor Green

if (-not (Test-Path $VenvPy)) {
    Write-Host "Creating venv..." -ForegroundColor Yellow
    & $python -m venv "$AgentDir\venv"
}

Write-Host "Installing packages..." -ForegroundColor Yellow
& "$AgentDir\venv\Scripts\pip.exe" install flask pywin32 --quiet

$Action   = New-ScheduledTaskAction -Execute $VenvPy -Argument $Script -WorkingDirectory $AgentDir
$Trigger  = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)

$old = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($old) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Highest -Force | Out-Null
Write-Host "Task registered." -ForegroundColor Green

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

try {
    $r = Invoke-WebRequest -Uri "http://localhost:9191/health" -TimeoutSec 5 -UseBasicParsing
    Write-Host "Agent running!" -ForegroundColor Green
    Write-Host $r.Content
} catch {
    Write-Host "Check: http://localhost:9191/health" -ForegroundColor Yellow
}

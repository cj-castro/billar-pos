$AgentDir = "C:\Users\bola8lacalma\Desktop\POS\billiards\scripts\print_agent"
$exe = "$AgentDir\venv\Scripts\pythonw.exe"
$script = "$AgentDir\print_agent.py"
Start-Process -FilePath $exe -ArgumentList $script -WorkingDirectory $AgentDir -WindowStyle Hidden
Start-Sleep -Seconds 3
try {
    $r = Invoke-WebRequest -Uri "http://localhost:9191/health" -TimeoutSec 5 -UseBasicParsing
    Write-Host "Print agent running!" -ForegroundColor Green
    Write-Host $r.Content
} catch {
    Write-Host "Not responding yet - wait 5s and check http://localhost:9191/health" -ForegroundColor Yellow
}

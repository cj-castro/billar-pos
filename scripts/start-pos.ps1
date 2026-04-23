$proj = "C:\Users\bola8lacalma\Desktop\POS\billiards"
Set-Location $proj
$w = 0
while (-not (docker info 2>$null)) {
    if ($w -ge 60) { Write-Host "Docker not ready after 60s"; exit 1 }
    Start-Sleep -Seconds 3
    $w += 3
}
docker compose up -d --remove-orphans
Write-Host "Billiard Bar POS started."

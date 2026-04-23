$proj = "C:\Users\bola8lacalma\Desktop\POS\billiards"
$back = Join-Path $proj "backups"
New-Item -Force -ItemType Directory $back | Out-Null
$ts  = Get-Date -f "yyyyMMdd_HHmmss"
$sql = Join-Path $back ("db_" + $ts + ".sql")
$zip = Join-Path $back ("db_" + $ts + ".zip")
docker exec billiards-postgres-1 pg_dump -U billiard billiardbar | Out-File $sql -Encoding UTF8
Compress-Archive -Path $sql -DestinationPath $zip -Force
Remove-Item $sql
Write-Host "Backup created:" (Get-Item $zip).Name
Get-ChildItem (Join-Path $back "*.zip") | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force
Write-Host "Old backups pruned."

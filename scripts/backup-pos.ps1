# ─────────────────────────────────────────────────────────────────────────────
# backup-pos.ps1 — PostgreSQL backup for Bola 8 POS
# Usage:  powershell -File scripts\backup-pos.ps1
# Auto:   runs via Task Scheduler (see install-autostart.ps1)
# ─────────────────────────────────────────────────────────────────────────────
param(
    [int]$KeepDays = 7,
    [switch]$Quiet
)

$proj      = "C:\Users\bola8lacalma\Desktop\POS\billiards"
$back      = Join-Path $proj "backups"
$container = "billiards-postgres-1"
$db        = "billiardbar"
$user      = "billiard"

New-Item -Force -ItemType Directory $back | Out-Null

$ts  = Get-Date -f "yyyyMMdd_HHmmss"
$sql = Join-Path $back ("db_$ts.sql")
$zip = Join-Path $back ("db_$ts.zip")

function Log($msg) { if (-not $Quiet) { Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" } }

# ── 1. Check container is running ─────────────────────────────────────────
Log "Checking postgres container..."
$running = docker ps --filter "name=$container" --filter "status=running" --format "{{.Names}}"
if ($running -ne $container) {
    Write-Host "ERROR: $container is not running. Start it first:" -ForegroundColor Red
    Write-Host "  docker compose up -d" -ForegroundColor Yellow
    exit 1
}

# ── 2. Dump ───────────────────────────────────────────────────────────────
Log "Dumping database → $sql"
docker exec $container pg_dump -U $user $db | Out-File $sql -Encoding UTF8

if (-not (Test-Path $sql) -or (Get-Item $sql).Length -lt 1000) {
    Write-Host "ERROR: Backup file is empty or missing!" -ForegroundColor Red
    Remove-Item $sql -ErrorAction SilentlyContinue
    exit 1
}

# ── 3. Compress ───────────────────────────────────────────────────────────
Log "Compressing..."
Compress-Archive -Path $sql -DestinationPath $zip -Force
Remove-Item $sql

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Log "✅ Backup created: $(Split-Path $zip -Leaf) ($size KB)"

# ── 4. Prune old backups ──────────────────────────────────────────────────
$old = Get-ChildItem (Join-Path $back "db_*.zip") |
       Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
if ($old) {
    $old | Remove-Item -Force
    Log "🗑️  Removed $($old.Count) backup(s) older than $KeepDays days"
}

# ── 5. List recent backups ─────────────────────────────────────────────────
Log ""
Log "Recent backups:"
Get-ChildItem (Join-Path $back "db_*.zip") | Sort-Object LastWriteTime -Descending | Select-Object -First 5 |
    ForEach-Object { Log ("  " + $_.Name + "  " + [math]::Round($_.Length/1KB,1) + " KB") }

<#
.SYNOPSIS
    Roll the POS database back to a dump produced by Backup-Database.ps1.

.DESCRIPTION
    Drops and recreates the database, then pg_restore's the archive. Dropping is
    cleaner than `pg_restore --clean`: the migrations create triggers, views and
    reference tables that have dependency chains, and --clean drops them in an
    order that can leave orphans behind. An empty database has no such problem.

    The app containers MUST be stopped first, or their connections block the
    DROP and the restore fails halfway. The script stops them for you and leaves
    them stopped -- you restart them once you have verified the restore, not
    before.

    Every byte moves via docker cp. Nothing passes through the PowerShell
    pipeline. See Backup-Database.ps1 for why that matters.

.PARAMETER DumpFile
    Path to the .dump file (custom format, from Backup-Database.ps1).

.PARAMETER Force
    Skip the confirmation prompt. For scripted rollback only.

.EXAMPLE
    .\Restore-Database.ps1 -DumpFile "C:\...\backups\db_pre-027_20260808_143000.dump"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DumpFile,
    [string]$ProjectDir = "C:\Users\bola8lacalma\Desktop\POS\billiards",
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" -ForegroundColor Cyan }

if (-not (Test-Path $DumpFile)) { Fail "dump not found: $DumpFile" }
if (-not (Test-Path (Join-Path $ProjectDir 'docker-compose.yml'))) {
    Fail "no docker-compose.yml in $ProjectDir"
}
Set-Location $ProjectDir

# Captured into an array rather than piped through `Select-Object -First 1`,
# which stops the upstream pipeline and can kill docker mid-write. Same idiom
# as Backup-Database.ps1 and Invoke-Migrations.ps1.
$ids = @(docker compose ps -q postgres 2>$null)
if ($ids.Count -eq 0 -or [string]::IsNullOrWhiteSpace($ids[0])) {
    Fail "postgres container not running. Start it: docker compose up -d postgres"
}
$container = $ids[0].Trim()

$dbUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'billiard' }
$dbName = if ($env:POSTGRES_DB)   { $env:POSTGRES_DB }   else { 'billiardbar' }

Write-Host ""
Write-Host "  This DESTROYS the current '$dbName' database and replaces it with" -ForegroundColor Red
Write-Host "  $(Split-Path $DumpFile -Leaf)" -ForegroundColor Red
Write-Host "  Anything sold since that dump was taken is lost." -ForegroundColor Red
Write-Host ""

if (-not $Force) {
    $answer = Read-Host "Type RESTORE to continue"
    if ($answer -cne 'RESTORE') { Write-Host "Aborted."; exit 0 }
}

# ── Stop everything that holds a connection ──────────────────────────────────
Step "stopping backend, scheduler, telegram-bot..."
docker compose stop backend scheduler telegram-bot 2>&1 | Out-Null

# ── Copy the archive in ──────────────────────────────────────────────────────
Step "copying dump into container..."
docker cp $DumpFile "${container}:/tmp/restore.dump"
if ($LASTEXITCODE -ne 0) { Fail "docker cp failed" }

# ── Terminate stragglers, then swap the database ─────────────────────────────
Step "terminating remaining connections..."
docker exec $container psql -U $dbUser -d postgres -v ON_ERROR_STOP=1 -c @"
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = '$dbName' AND pid <> pg_backend_pid();
"@ | Out-Null

Step "dropping and recreating $dbName..."
docker exec $container psql -U $dbUser -d postgres -v ON_ERROR_STOP=1 `
    -c "DROP DATABASE IF EXISTS $dbName;"
if ($LASTEXITCODE -ne 0) { Fail "DROP DATABASE failed -- something still holds a connection" }

docker exec $container psql -U $dbUser -d postgres -v ON_ERROR_STOP=1 `
    -c "CREATE DATABASE $dbName OWNER $dbUser;"
if ($LASTEXITCODE -ne 0) { Fail "CREATE DATABASE failed" }

Step "restoring (this takes a minute or two)..."
docker exec $container pg_restore -U $dbUser -d $dbName --no-owner --no-privileges /tmp/restore.dump
$restoreCode = $LASTEXITCODE
docker exec $container rm -f /tmp/restore.dump | Out-Null

# pg_restore exits 1 on non-fatal warnings (missing role grants and the like).
# Treat that as "check the counts", not as success or failure.
if ($restoreCode -ne 0) {
    Write-Host "pg_restore exited $restoreCode (warnings). Verify the counts below." -ForegroundColor Yellow
}

Step "verifying..."
docker exec $container psql -U $dbUser -d $dbName -tA -c @"
SELECT 'tickets            : '||count(*) FROM tickets;
SELECT 'inventory items    : '||count(*) FROM inventory_items;
SELECT 'movements          : '||count(*) FROM inventory_movements;
SELECT 'migrations applied : '||count(*) FROM schema_migrations;
"@

Write-Host ""
Write-Host "  Restore complete. Containers are still STOPPED on purpose." -ForegroundColor Green
Write-Host "  Check the counts above, then start them:" -ForegroundColor Yellow
Write-Host "    docker compose up -d" -ForegroundColor Yellow
Write-Host ""
Write-Host "  NOTE: if 'migrations applied' is 0, the backend will re-apply all 27" -ForegroundColor Yellow
Write-Host "  on startup. That is correct behaviour for a pre-027 dump." -ForegroundColor Yellow

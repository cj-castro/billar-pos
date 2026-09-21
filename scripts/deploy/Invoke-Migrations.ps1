<#
.SYNOPSIS
    Apply the 027-038 SQL migrations to the POS database on Windows.

.DESCRIPTION
    Reads backend\migrations\sql\manifest.txt for the order -- the same file
    run_all.sh and `flask apply-migrations` read, so the three runners cannot
    drift apart.

    HOW THE SQL REACHES POSTGRES, AND WHY IT MATTERS

    Not this:
        Get-Content 027.sql | docker exec -i $c psql ...
        docker exec -i $c psql ... < 027.sql

    Both route the file through the PowerShell pipeline, which re-encodes it
    using the console code page. Migrations 027b, 031c and 034b match rows by
    accented Spanish names ('Naranjada', 'Porción'). If those names arrive
    mangled, the UPDATEs match zero rows and quietly do nothing. The assertions
    would catch most of it -- at the bar, at night, with the POS down.

    Instead: docker cp the whole folder into the container, then `psql -f`
    against the copies. The bytes are never interpreted by PowerShell.

    Each file is one transaction with its own assertions, so a failure rolls
    that file back completely. This script stops at the first failure, which
    leaves the database at the last good migration -- consistent, just older.

.PARAMETER ProjectDir
    Folder containing docker-compose.yml.

.PARAMETER DryRun
    Show what would be applied. Touches nothing.

.PARAMETER SkipBackup
    Skip the automatic pre-flight backup. Only when you just took one manually.

.EXAMPLE
    .\Invoke-Migrations.ps1 -DryRun
    .\Invoke-Migrations.ps1
#>
[CmdletBinding()]
param(
    [string]$ProjectDir = "C:\Users\bola8lacalma\Desktop\POS\billiards",
    [switch]$DryRun,
    [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" -ForegroundColor Cyan }

if (-not (Test-Path (Join-Path $ProjectDir 'docker-compose.yml'))) {
    Fail "no docker-compose.yml in $ProjectDir. Pass -ProjectDir."
}
Set-Location $ProjectDir

$sqlDir = Join-Path $ProjectDir 'backend\migrations\sql'
if (-not (Test-Path $sqlDir)) { Fail "migration folder missing: $sqlDir" }

$manifestPath = Join-Path $sqlDir 'manifest.txt'
if (-not (Test-Path $manifestPath)) { Fail "manifest.txt missing in $sqlDir" }

# manifest.txt is plain ASCII, so Get-Content is safe here. The .sql files are
# never read by PowerShell -- only their names are.
$stems = Get-Content $manifestPath |
    ForEach-Object { ($_ -split '#')[0].Trim() } |
    Where-Object   { $_ -ne '' }

if (-not $stems -or $stems.Count -eq 0) { Fail "manifest.txt yielded no migrations" }
Step "$($stems.Count) migrations in manifest"

# Every file must exist before we touch the database. Finding a missing file
# halfway through is a bad way to learn the copy was incomplete.
$missing = @()
foreach ($s in $stems) {
    if (-not (Test-Path (Join-Path $sqlDir "$s.sql"))) { $missing += $s }
}
if ($missing.Count -gt 0) {
    Fail "these files are in the manifest but not on disk:`n  $($missing -join "`n  ")`nThe copy from the Mac was incomplete."
}

# ── Resolve container via compose, never by hardcoded name ───────────────────
$container = (docker compose ps -q postgres 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($container)) {
    Fail "postgres container not running. Start it: docker compose up -d postgres"
}
$container = $container.Trim()

$dbUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'billiard' }
$dbName = if ($env:POSTGRES_DB)   { $env:POSTGRES_DB }   else { 'billiardbar' }

Step "container $($container.Substring(0,12))  db $dbName"

function Invoke-Psql([string]$sql) {
    docker exec $container psql -U $dbUser -d $dbName -tA -c $sql 2>&1
}

# ── What is already applied ──────────────────────────────────────────────────
$hasTable = (Invoke-Psql "SELECT to_regclass('public.schema_migrations') IS NOT NULL") -join ''
$applied = @()
if ($hasTable.Trim() -eq 't') {
    $applied = @(Invoke-Psql "SELECT version FROM schema_migrations" |
                 ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}
Step "$($applied.Count) migrations already applied"

$pending = @($stems | Where-Object { $applied -notcontains ($_ -split '_')[0] })

if ($pending.Count -eq 0) {
    Write-Host ""
    Write-Host "  Nothing to do -- all $($stems.Count) migrations already applied." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "  Pending ($($pending.Count)):" -ForegroundColor Yellow
$pending | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
Write-Host ""

if ($DryRun) { Write-Host "  -DryRun: nothing was changed." -ForegroundColor Cyan; exit 0 }

# ── Pre-flight backup ────────────────────────────────────────────────────────
if (-not $SkipBackup) {
    Step "taking a pre-migration backup..."
    & (Join-Path $PSScriptRoot 'Backup-Database.ps1') `
        -ProjectDir $ProjectDir -Label 'pre-migration' -KeepDays 0
    if ($LASTEXITCODE -ne 0) { Fail "backup failed -- refusing to migrate without one" }
} else {
    Write-Host "  -SkipBackup: no safety net is being created." -ForegroundColor Yellow
}

# ── Copy the SQL in ──────────────────────────────────────────────────────────
# rm -rf first so docker cp creates /tmp/mig as a copy of the folder rather than
# nesting it inside an existing /tmp/mig.
Step "copying SQL into the container..."
docker exec -u root $container rm -rf /tmp/mig | Out-Null
docker cp $sqlDir "${container}:/tmp/mig"
if ($LASTEXITCODE -ne 0) { Fail "docker cp of $sqlDir failed" }
docker exec -u root $container chmod -R a+r /tmp/mig | Out-Null

# Prove the bytes survived. If checksums matched on the Mac and match here, the
# accented characters are intact and any later name-match failure is a data
# question, not a transport question.
$sample = Join-Path $sqlDir '031c_bottle_service_options.sql'
if (Test-Path $sample) {
    $localHash  = (Get-FileHash $sample -Algorithm MD5).Hash.ToLower()
    $remoteHash = ((docker exec $container md5sum /tmp/mig/031c_bottle_service_options.sql) -split '\s+')[0]
    if ($localHash -ne $remoteHash) {
        Fail "checksum mismatch after copy (local $localHash, container $remoteHash). The file was altered in transit."
    }
    Step "checksum verified -- files copied byte-for-byte"
}

# ── Apply ────────────────────────────────────────────────────────────────────
Write-Host ""
$okCount = 0
foreach ($stem in $pending) {
    $label = $stem.PadRight(38)
    Write-Host -NoNewline "  $label"

    $output = docker exec -e PGCLIENTENCODING=UTF8 $container `
        psql -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -f "/tmp/mig/$stem.sql" 2>&1
    $code = $LASTEXITCODE

    if ($code -ne 0) {
        Write-Host "FAILED" -ForegroundColor Red
        Write-Host ""
        ($output | Select-String -Pattern 'ERROR|HINT|DETAIL' | Select-Object -First 6) |
            ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "  This file rolled back completely. The database is consistent at" -ForegroundColor Yellow
        Write-Host "  the last successful migration -- nothing is half-applied." -ForegroundColor Yellow
        Write-Host "  $okCount migration(s) applied before this one." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Send the error above to CJ before retrying." -ForegroundColor Yellow
        exit 1
    }

    $ok = ($output | Select-String -Pattern '\d+[a-z]? OK' | Select-Object -First 1)
    if ($ok) {
        Write-Host ($ok.ToString() -replace '^.*NOTICE:\s*', '') -ForegroundColor Green
    } else {
        Write-Host "OK" -ForegroundColor Green
    }
    $okCount++
}

docker exec -u root $container rm -rf /tmp/mig | Out-Null

# ── Invariants ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== invariants (every number must be 0) ===" -ForegroundColor Cyan
Invoke-Psql @"
SELECT 'drift               : '||count(*) FROM v_ledger_reconciliation WHERE is_drifted;
SELECT 'chain breaks        : '||count(*) FROM fn_ledger_scan_chain();
SELECT 'unresolved warnings : '||count(*) FROM ledger_violations WHERE resolved_at IS NULL;
SELECT 'double deductions   : '||count(*) FROM v_recipe_modifier_overlap;
SELECT 'modifier gaps       : '||count(*) FROM v_modifier_coverage_gaps;
SELECT 'legacy recipe rows  : '||count(*) FROM menu_item_ingredients;
"@

Write-Host ""
Write-Host "  $okCount migration(s) applied." -ForegroundColor Green
Write-Host ""
Write-Host "  NEXT: rebuild and restart, then run this script again." -ForegroundColor Yellow
Write-Host "  It must report 'Nothing to do' and the same zeros. init-db STEP 16" -ForegroundColor Yellow
Write-Host "  is the one step that can undo migration 032, so restart-survival is" -ForegroundColor Yellow
Write-Host "  a required check, not an optional one." -ForegroundColor Yellow

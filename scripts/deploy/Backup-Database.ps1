<#
.SYNOPSIS
    Byte-exact PostgreSQL backup for the Bola 8 POS. Replaces backup-pos.ps1.

.DESCRIPTION
    WHY THIS EXISTS -- the old script corrupts accented text.

    scripts\backup-pos.ps1 does this:

        docker exec $container pg_dump -U $user $db | Out-File $sql -Encoding UTF8

    Windows PowerShell 5.1 decodes docker's stdout using the console's OEM code
    page (437 or 850 on a Mexican Windows install), so every UTF-8 byte becomes
    its own character. Out-File then re-encodes those characters as UTF-8. The
    result is classic double-encoding: 'Porción' becomes 'PorciÃ³n'. It also
    prepends a BOM, which makes `psql -f` fail with a misleading "relation does
    not exist".

    That is the same damage signature as the 11 mojibake rows migration 031 had
    to repair, which points at a backup/restore round-trip as the origin.

    The fix is structural, not a matter of picking a better -Encoding value:
    never let the bytes enter the PowerShell pipeline. pg_dump writes to a file
    INSIDE the container; docker cp moves the file out. PowerShell only ever
    handles the filename.

    Output is pg_dump's custom format (-Fc): compressed, restored with
    pg_restore, and immune to text encoding end to end.

.PARAMETER ProjectDir
    Folder containing docker-compose.yml.

.PARAMETER BackupDir
    Where dumps land. Defaults to <ProjectDir>\backups.

.PARAMETER Label
    Filename tag, e.g. -Label pre-027. Produces db_pre-027_20260808_143000.dump.

.PARAMETER KeepDays
    Prune dumps older than this. 0 disables pruning. Use 0 before a migration —
    you do not want the safety net pruned by the script that creates it.

.PARAMETER AlsoPlain
    Additionally write a plain .sql for grepping. Not the restore path.

.EXAMPLE
    .\Backup-Database.ps1 -Label pre-027 -KeepDays 0
#>
[CmdletBinding()]
param(
    [string]$ProjectDir = "C:\Users\bola8lacalma\Desktop\POS\billiards",
    [string]$BackupDir,
    [string]$Label = "manual",
    [int]$KeepDays = 7,
    [switch]$AlsoPlain
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# See Invoke-Migrations.ps1: Windows PowerShell 5.1 escalates a native command's
# stderr to a terminating error under $ErrorActionPreference='Stop'.
function Invoke-Native([scriptblock]$Cmd) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Cmd 2>&1 } finally { $ErrorActionPreference = $prev }
}
function Step($msg) { Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" -ForegroundColor Cyan }

if (-not (Test-Path (Join-Path $ProjectDir 'docker-compose.yml'))) {
    Fail "no docker-compose.yml in $ProjectDir. Pass -ProjectDir."
}
Set-Location $ProjectDir

if (-not $BackupDir) { $BackupDir = Join-Path $ProjectDir 'backups' }
New-Item -Force -ItemType Directory $BackupDir | Out-Null

# ── Resolve the container by compose service, not by name ────────────────────
# The container is 'billiards-postgres-1' only because the folder is named
# 'billiards'. Compose derives the project name from the folder, so a renamed
# folder silently changes every container name AND the volume name. Asking
# compose keeps this correct no matter what the folder is called.
# Captured into an array rather than piped through `Select-Object -First 1`:
# -First stops the upstream pipeline, which kills docker before PowerShell
# records its exit code, leaving $LASTEXITCODE UNSET. The guard below then sees
# $null -ne 0 and refuses to back up a perfectly healthy database.
$ids = @(docker compose ps -q postgres 2>$null)
if ($LASTEXITCODE -ne 0 -or $ids.Count -eq 0 -or [string]::IsNullOrWhiteSpace($ids[0])) {
    Fail "postgres container not running. Start it: docker compose up -d postgres"
}
$container = $ids[0].Trim()

$dbUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'billiard' }
$dbName = if ($env:POSTGRES_DB)   { $env:POSTGRES_DB }   else { 'billiardbar' }

Step "container $($container.Substring(0,12))  db $dbName  user $dbUser"

$ts      = Get-Date -f 'yyyyMMdd_HHmmss'
$stem    = "db_${Label}_${ts}"
$inside  = "/tmp/$stem.dump"
$outside = Join-Path $BackupDir "$stem.dump"

# ── Dump inside the container ────────────────────────────────────────────────
Step "pg_dump -Fc -> $inside (inside container)"
docker exec $container pg_dump -U $dbUser -d $dbName -Fc -f $inside
if ($LASTEXITCODE -ne 0) { Fail "pg_dump failed with exit code $LASTEXITCODE" }

# ── Move it out as bytes ─────────────────────────────────────────────────────
Step "docker cp -> $outside"
docker cp "${container}:$inside" $outside
if ($LASTEXITCODE -ne 0) { Fail "docker cp failed with exit code $LASTEXITCODE" }
docker exec $container rm -f $inside | Out-Null

if (-not (Test-Path $outside)) { Fail "backup file did not appear at $outside" }
$size = (Get-Item $outside).Length
if ($size -lt 10000) { Fail "backup is only $size bytes -- refusing to trust it" }

# ── Verify the dump is readable before calling it a backup ───────────────────
# An unverified backup is a guess. pg_restore --list parses the archive's table
# of contents; if that works, the file is structurally intact.
Step "verifying archive is readable..."
docker cp $outside "${container}:/tmp/verify.dump" | Out-Null
$toc = Invoke-Native { docker exec $container pg_restore --list /tmp/verify.dump }
docker exec $container rm -f /tmp/verify.dump | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "pg_restore --list could not read the dump:`n$toc" }
$objects = ($toc | Select-String -NotMatch '^;').Count
Step "archive OK -- $objects objects"

Write-Host ""
Write-Host "  Backup: $outside" -ForegroundColor Green
Write-Host "  Size:   $([math]::Round($size/1MB,1)) MB" -ForegroundColor Green
Write-Host ""
Write-Host "  Restore with:" -ForegroundColor Yellow
Write-Host "    .\Restore-Database.ps1 -DumpFile `"$outside`"" -ForegroundColor Yellow
Write-Host ""

# ── Prune ────────────────────────────────────────────────────────────────────
if ($KeepDays -gt 0) {
    $old = Get-ChildItem (Join-Path $BackupDir 'db_*.dump') -ErrorAction SilentlyContinue |
           Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
    if ($old) {
        $old | Remove-Item -Force
        Step "pruned $($old.Count) dump(s) older than $KeepDays days"
    }
} else {
    Step "pruning disabled (-KeepDays 0)"
}

if ($AlsoPlain) {
    $plainInside  = "/tmp/$stem.sql"
    $plainOutside = Join-Path $BackupDir "$stem.sql"
    Step "also writing plain SQL (for reading, not for restoring)"
    docker exec $container pg_dump -U $dbUser -d $dbName -f $plainInside
    if ($LASTEXITCODE -eq 0) {
        docker cp "${container}:$plainInside" $plainOutside | Out-Null
        docker exec $container rm -f $plainInside | Out-Null
        Write-Host "  Plain:  $plainOutside" -ForegroundColor Gray
    }
}

Write-Host "Recent backups:" -ForegroundColor Gray
Get-ChildItem (Join-Path $BackupDir 'db_*.dump') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 5 |
    ForEach-Object { Write-Host ("  {0}  {1} MB" -f $_.Name, [math]::Round($_.Length/1MB,1)) -ForegroundColor Gray }

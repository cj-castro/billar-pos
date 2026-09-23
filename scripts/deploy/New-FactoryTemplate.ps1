<#
.SYNOPSIS
    Builds a factory template from the live database: the real menu, no history.

.DESCRIPTION
    A new machine cannot be provisioned by seeding demo data. Migrations
    029b/031*/032*/034*/035b assert against the real Bola 8 menu ("exactly 11
    Servicio options"), so a demo-seeded database can never satisfy them -- see
    the FRESH INSTALLS note in app/migrations_runner.py.

    This produces the alternative: a dump carrying the real menu, recipes,
    modifiers, resources and schema_migrations, with every ticket, movement and
    credential removed. Restoring it gives a working POS whose migrations are
    already recorded as applied, so nothing re-runs and 027's wrong-database
    guard never fires.

    The live database is never modified. Everything happens in a temporary
    database that is dropped on the way out, including on failure.

    Regenerate whenever the menu changes; the menu is never maintained twice.

.EXAMPLE
    .\New-FactoryTemplate.ps1
    .\New-FactoryTemplate.ps1 -OutFile D:\billiards\factory-2026-09.dump
#>
[CmdletBinding()]
param(
    [string]$ProjectDir = "C:\Users\bola8lacalma\Desktop\POS\billiards",
    [string]$OutFile,
    [string]$TempDb = "factory_build"
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" -ForegroundColor Cyan }

# See Invoke-Migrations.ps1: Windows PowerShell 5.1 escalates a native command's
# stderr to a terminating error under $ErrorActionPreference='Stop'.
function Invoke-Native([scriptblock]$Cmd) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Cmd 2>&1 } finally { $ErrorActionPreference = $prev }
}

if (-not (Test-Path (Join-Path $ProjectDir 'docker-compose.yml'))) {
    Fail "no docker-compose.yml in $ProjectDir. Pass -ProjectDir."
}
Set-Location $ProjectDir

$sqlFile = Join-Path $PSScriptRoot 'factory_template.sql'
if (-not (Test-Path $sqlFile)) { Fail "factory_template.sql not found beside this script." }

$dbName = if ($env:POSTGRES_DB)   { $env:POSTGRES_DB }   else { 'billiardbar' }
$dbUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'billiard' }

if (-not $OutFile) {
    $stamp   = Get-Date -f 'yyyyMMdd_HHmmss'
    $dir     = Join-Path $ProjectDir 'backups'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $OutFile = Join-Path $dir "factory-template_$stamp.dump"
}

# Assignment, not `| Select-Object -First 1`: piping kills docker before
# PowerShell records its exit code, leaving $LASTEXITCODE unset.
$ids = @(docker compose ps -q postgres 2>$null)
if ($LASTEXITCODE -ne 0 -or $ids.Count -eq 0 -or -not $ids[0]) {
    Fail "postgres container not running. Start it: docker compose up -d postgres"
}
$container = $ids[0]

$ready = Invoke-Native { docker exec $container pg_isready -U $dbUser -d $dbName }
if ($LASTEXITCODE -ne 0) { Fail "postgres is not accepting connections yet.`n$ready" }

Step "container $($container.Substring(0,12))  source db $dbName  temp db $TempDb"

function Remove-TempDb {
    Invoke-Native {
        docker exec $container psql -U $dbUser -d postgres -q -c "DROP DATABASE IF EXISTS $TempDb;"
    } | Out-Null
}

try {
    # ── 1. Snapshot the live database (read-only) ───────────────────────────
    Step "dumping $dbName..."
    $out = Invoke-Native { docker exec $container pg_dump -U $dbUser -d $dbName -Fc -f /tmp/factory_src.dump }
    if ($LASTEXITCODE -ne 0) { Fail "pg_dump failed:`n$out" }

    # ── 2. Rebuild it as a throwaway copy ───────────────────────────────────
    Step "restoring into $TempDb..."
    Remove-TempDb
    $out = Invoke-Native {
        docker exec $container psql -U $dbUser -d postgres -q -c "CREATE DATABASE $TempDb OWNER $dbUser;"
    }
    if ($LASTEXITCODE -ne 0) { Fail "could not create $TempDb`:`n$out" }

    # pg_restore reports benign ownership/extension notices on a fresh database;
    # the sanitiser's own guards are what actually prove the copy is complete.
    Invoke-Native { docker exec $container pg_restore -U $dbUser -d $TempDb /tmp/factory_src.dump } | Out-Null

    # ── 3. Strip history, stock and credentials ─────────────────────────────
    Step "sanitizing (truncating history, zeroing stock, scrubbing credentials)..."
    docker cp $sqlFile "${container}:/tmp/factory_template.sql" | Out-Null
    $out = Invoke-Native {
        docker exec $container psql -U $dbUser -d $TempDb -v ON_ERROR_STOP=1 -f /tmp/factory_template.sql
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        ($out | Select-String -Pattern 'ERROR|DETAIL|HINT' | Select-Object -First 6) |
            ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        Fail "sanitize failed. The live database was NOT touched."
    }
    ($out | Select-String -Pattern 'factory OK') |
        ForEach-Object { Write-Host "  $($_.ToString() -replace '^.*NOTICE:\s*','')" -ForegroundColor Green }

    # ── 4. Emit and verify ──────────────────────────────────────────────────
    Step "dumping template..."
    $out = Invoke-Native { docker exec $container pg_dump -U $dbUser -d $TempDb -Fc -f /tmp/factory_out.dump }
    if ($LASTEXITCODE -ne 0) { Fail "template pg_dump failed:`n$out" }

    docker cp "${container}:/tmp/factory_out.dump" $OutFile | Out-Null
    if (-not (Test-Path $OutFile)) { Fail "docker cp produced no file at $OutFile" }

    # An unverified template is a guess, and it is only ever restored on a day
    # when something has already gone wrong.
    Step "verifying archive is readable..."
    $toc = Invoke-Native { docker exec $container pg_restore --list /tmp/factory_out.dump }
    if ($LASTEXITCODE -ne 0) { Fail "pg_restore --list could not read the template:`n$toc" }
    $objects = ($toc | Select-String -NotMatch '^;').Count

    $sizeMb = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
    Write-Host ""
    Write-Host "  Template: $OutFile" -ForegroundColor Green
    Write-Host "  Size:     $sizeMb MB   Objects: $objects" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Provision a new machine with:" -ForegroundColor Yellow
    Write-Host "    .\Restore-Database.ps1 -DumpFile `"$OutFile`"" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Credentials come from that machine's .env on first boot." -ForegroundColor Yellow
    Write-Host "  Stock ships at zero: count it in before trading." -ForegroundColor Yellow
}
finally {
    Step "cleaning up..."
    Remove-TempDb
    Invoke-Native {
        docker exec $container rm -f /tmp/factory_src.dump /tmp/factory_out.dump /tmp/factory_template.sql
    } | Out-Null
}

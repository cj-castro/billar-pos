# Restore-Native.ps1 -- native port of scripts/deploy/Restore-Database.ps1. Takes a safety dump of the CURRENT db
# first (aborts if that fails), stops the POS services, drops and recreates the db, pg_restores the dump, prints
# row counts. Services are left STOPPED on purpose. -OutDir (required) = where the pre-restore safety dump goes;
# pass the normal backups folder so it sits next to the regular dumps.
param(
    [Parameter(Mandatory)][string]$EnvFile,
    [Parameter(Mandatory)][string]$PgBin,
    [Parameter(Mandatory)][string]$DumpFile,
    [Parameter(Mandatory)][string]$OutDir,
    [string]$Prefix = 'BilliardsPOS',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\PosCommon.psm1') -Force
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Fail([string]$m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-PosLog "restore: $m" }
function QIdent([string]$s) { '"' + $s.Replace('"', '""') + '"' }
function QLit([string]$s) { "'" + $s.Replace("'", "''") + "'" }

# Native exe with stderr merged; returns @{rc; out}. PGPASSWORD is set by the caller.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$StdIn) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $o = if ($PSBoundParameters.ContainsKey('StdIn')) { $StdIn | & $Exe @Arguments 2>&1 } else { & $Exe @Arguments 2>&1 }
        @{ rc = $LASTEXITCODE; out = @($o | ForEach-Object { "$_" }) }
    } finally { $ErrorActionPreference = $prev }
}

if (-not (Test-Path $DumpFile)) { Fail "dump not found: $DumpFile" }
Import-PosEnv -Path $EnvFile
foreach ($k in 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD') {
    if (-not [Environment]::GetEnvironmentVariable($k, 'Process')) { Fail "missing $k in $EnvFile" }
}
$db = $env:POSTGRES_DB; $user = $env:POSTGRES_USER
$pgHost = if ($env:PG_HOST) { $env:PG_HOST } else { '127.0.0.1' }
$pgPort = if ($env:PG_PORT) { $env:PG_PORT } else { '5433' }

Write-Host ""
Write-Host "  This DESTROYS the current '$db' database and replaces it with" -ForegroundColor Red
Write-Host "  $(Split-Path $DumpFile -Leaf)" -ForegroundColor Red
Write-Host "  Anything sold since that dump was taken is lost." -ForegroundColor Red
Write-Host ""
if (-not $Force) {
    $answer = Read-Host 'Type RESTORE to continue'
    if ($answer -cne 'RESTORE') { Write-Host 'Aborted.'; exit 0 }
}

try {
    # --- safety dump of what is there now; no safety dump, no restore ---
    Step 'safety dump of the current database (pre-restore, never pruned)'
    $self = (Get-Process -Id $PID).Path
    $r = Invoke-Native $self @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $PSScriptRoot 'Backup-Native.ps1'), '-EnvFile', $EnvFile, '-PgBin', $PgBin, '-OutDir', $OutDir,
        '-Label', 'pre-restore', '-KeepDays', '0')
    $r.out | ForEach-Object { Write-Output $_ }
    if ($r.rc -ne 0) { throw 'safety dump failed -- database left untouched' }

    # --- refuse an unreadable dump BEFORE dropping anything ---
    $r = Invoke-Native (Join-Path $PgBin 'pg_restore.exe') @('--list', $DumpFile)
    if ($r.rc -ne 0) { throw "pg_restore --list could not read $DumpFile -- database left untouched" }

    # --- stop whatever holds connections (only services that exist) ---
    foreach ($n in "$Prefix-Backend", "$Prefix-Scheduler") {
        if (Get-Service -Name $n -ErrorAction SilentlyContinue) {
            Step "stopping $n"
            Stop-Service -Name $n -Force -ErrorAction Stop
        }
    }

    $env:PGPASSWORD = $env:POSTGRES_PASSWORD
    $conn = @('-X', '-h', $pgHost, '-p', $pgPort, '-U', $user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1')
    $psql = Join-Path $PgBin 'psql.exe'
    $qdb = QIdent $db
    Step 'terminating remaining connections'
    $r = Invoke-Native $psql ($conn + @('-c', "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $(QLit $db) AND pid <> pg_backend_pid()"))
    if ($r.rc -ne 0) { throw "terminating connections failed: $($r.out)" }
    Step "dropping and recreating $db"
    $r = Invoke-Native $psql ($conn + @('-c', "DROP DATABASE IF EXISTS $qdb"))
    if ($r.rc -ne 0) { throw "DROP DATABASE failed -- something still holds a connection: $($r.out)" }
    $r = Invoke-Native $psql ($conn + @('-c', "CREATE DATABASE $qdb TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'en-US' OWNER $(QIdent $user)"))
    if ($r.rc -ne 0) { throw "CREATE DATABASE failed: $($r.out)" }

    Step 'restoring (this takes a minute or two)'
    $r = Invoke-Native (Join-Path $PgBin 'pg_restore.exe') @('-h', $pgHost, '-p', $pgPort, '-U', $user, '-d', $db, '--no-owner', '--no-privileges', $DumpFile)
    $restoreRc = $r.rc
    if ($restoreRc -ne 0) {
        $r.out | ForEach-Object { Write-Output $_ }
        Write-Host "pg_restore exited $restoreRc (warnings/errors above). Verify the counts below." -ForegroundColor Yellow
    }

    Step 'verifying'
    $sql = "SELECT 'tickets            : '||count(*) FROM tickets;`n" +
           "SELECT 'inventory items    : '||count(*) FROM inventory_items;`n" +
           "SELECT 'migrations applied : '||count(*) FROM schema_migrations;`n"
    $r = Invoke-Native $psql @('-X', '-h', $pgHost, '-p', $pgPort, '-U', $user, '-d', $db, '-tA', '-v', 'ON_ERROR_STOP=1') -StdIn $sql
    $r.out | ForEach-Object { Write-Output $_ }
    if ($r.rc -ne 0) { throw 'verification queries failed' }
    if ($restoreRc -ne 0) { throw "pg_restore exited $restoreRc" }

    Write-Host ""
    Write-Host "  Restore complete. $Prefix services are still STOPPED on purpose." -ForegroundColor Green
    Write-Host "  Check the counts above, then start them." -ForegroundColor Yellow
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    $env:PGPASSWORD = $null
}

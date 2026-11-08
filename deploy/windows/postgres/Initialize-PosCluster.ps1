<#
Creates (or verifies) the POS PostgreSQL cluster. Idempotent: if PG_VERSION exists, data is left untouched
and only the config is re-applied and the settings verified. Exit 0 on success.
Effects: initdb -E UTF8 --locale=C --lc-ctype=en-US (bootstrap superuser = DbUser, SUPERUSER LOGIN as in the
container), pos-postgresql.conf included from postgresql.conf, scram pg_hba on loopback, database created with
ENCODING UTF8 LC_COLLATE C LC_CTYPE en-US.
#>
param(
    [Parameter(Mandatory)][string]$PgBin,
    [Parameter(Mandatory)][string]$DataDir,
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][string]$DbUser,
    [Parameter(Mandatory)][string]$DbPassword,
    [Parameter(Mandatory)][string]$DbName
)
$ErrorActionPreference = 'Stop'
$PgBin = (Resolve-Path $PgBin).Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$env:PGPASSWORD = $DbPassword
$env:PGCLIENTENCODING = 'UTF8'

function Exe($name, [string[]]$a) {
    $out = & (Join-Path $PgBin "$name.exe") @a 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$name failed ($LASTEXITCODE): $out" }
    return ($out | Out-String).Trim()
}
function Sql($db, $sql) {
    Exe 'psql' @('-X', '-h', '127.0.0.1', '-p', "$Port", '-U', $DbUser, '-d', $db, '-v', 'ON_ERROR_STOP=1', '-Atc', $sql)
}
function Test-Up {
    & (Join-Path $PgBin 'pg_isready.exe') -h 127.0.0.1 -p $Port | Out-Null
    return ($LASTEXITCODE -eq 0)
}

$fresh = -not (Test-Path (Join-Path $DataDir 'PG_VERSION'))
if ($fresh) {
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    $pw = Join-Path ([IO.Path]::GetTempPath()) ("pgpw_" + [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($pw, $DbPassword, $utf8)
    try {
        Exe 'initdb' @('-D', $DataDir, '-U', $DbUser, '--pwfile', $pw, '-E', 'UTF8', '--locale=C', '--lc-ctype=en-US',
                       '--auth-host=scram-sha-256', '--auth-local=scram-sha-256')
    } finally { Remove-Item $pw -Force -ErrorAction SilentlyContinue }
}

# config: copy pos-postgresql.conf next to postgresql.conf, (re)write one marked block, rewrite pg_hba
Copy-Item (Join-Path $PSScriptRoot 'pos-postgresql.conf') (Join-Path $DataDir 'pos-postgresql.conf') -Force
$confPath = Join-Path $DataDir 'postgresql.conf'
$conf = [IO.File]::ReadAllText($confPath)
$conf = [regex]::Replace($conf, '(?s)\r?\n# BEGIN POS.*?# END POS\r?\n?', '')
$conf = $conf.TrimEnd() + "`n`n# BEGIN POS`nport = $Port`ninclude_if_exists = 'pos-postgresql.conf'`n# END POS`n"
[IO.File]::WriteAllText($confPath, $conf, $utf8)
[IO.File]::WriteAllText((Join-Path $DataDir 'pg_hba.conf'),
    "host all all 127.0.0.1/32 scram-sha-256`nhost all all ::1/128 scram-sha-256`n", $utf8)

# need a running server to create/verify; start it only if it is not already up
$startedHere = $false
if (Test-Up) {
    Exe 'pg_ctl' @('reload', '-D', $DataDir) | Out-Null
    Start-Sleep -Milliseconds 500
} else {
    # Not `& pg_ctl` and not Start-Process -Wait: the postmaster inherits our stdout pipe (hangs capture) and
    # -Wait also waits for descendants. Redirect to files and wait on pg_ctl alone.
    $log = Join-Path $DataDir 'pos-init.log'
    $p = Start-Process (Join-Path $PgBin 'pg_ctl.exe') -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err" `
        -ArgumentList @('start', '-D', "`"$DataDir`"", '-w', '-t', '60', '-l', "`"$log`"")
    $null = $p.Handle   # cache the handle, else ExitCode is $null after WaitForExit
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "pg_ctl start failed ($($p.ExitCode)); see pos-init.log" }
    $startedHere = $true
}
try {
    $exists = Sql 'postgres' "select 1 from pg_database where datname='$DbName'"
    if (-not $exists) {
        Sql 'postgres' "create database `"$DbName`" encoding 'UTF8' lc_collate 'C' lc_ctype 'en-US' template template0" | Out-Null
    }
    $loc = Sql 'postgres' "select pg_encoding_to_char(encoding)||'/'||datcollate||'/'||datctype from pg_database where datname='$DbName'"
    $tz = Sql $DbName 'show timezone'
    $ds = Sql $DbName 'show datestyle'
    $su = Sql 'postgres' "select rolsuper::text from pg_roles where rolname='$DbUser'"
    $bad = @()
    if ($loc -ne 'UTF8/C/en-US') { $bad += "locale=$loc" }
    if ($tz -ne 'UTC') { $bad += "timezone=$tz" }
    if ($ds -ne 'ISO, MDY') { $bad += "datestyle=$ds" }
    if ($su -ne 'true') { $bad += "superuser=$su" }
    if ($bad) { throw "cluster verification failed: $($bad -join ', ')" }
    Write-Host "OK cluster $(if ($fresh) {'created'} else {'verified'}): port=$Port db=$DbName locale=$loc tz=$tz"
} finally {
    if ($startedHere) { Exe 'pg_ctl' @('stop', '-D', $DataDir, '-m', 'fast', '-w') | Out-Null }
}
exit 0

# backup-s3.ps1 -- native port of backup/backup.sh + the catch-up part of backup/entrypoint.sh.
# One pg_dump -Fc of the POS database, uploaded to S3. Run by a scheduled task (02:00 + missed-run
# trigger / service start with -CatchUp) and by hand. Success touches StateDir\last_success;
# failure leaves it alone and exits 1.
param(
    [Parameter(Mandatory)][string]$EnvFile,
    [Parameter(Mandatory)][string]$PgBin,
    [Parameter(Mandatory)][string]$AwsExe,
    [Parameter(Mandatory)][string]$StateDir,
    [switch]$CatchUp
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\PosCommon.psm1') -Force
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

$MinBytes = 10240
$Marker = Join-Path $StateDir 'last_success'

function Log([string]$m) { Write-PosLog "backup: $m" }

$lock = $null
$tmp = $null
$code = 0
try {
    # Everything is inside the try: whatever fails, the log gets `BACKUP FAILED: <reason>` and the exit code is 1.
    # --- entrypoint.sh: required environment (`KEY=` empty in the env file unsets the var) ---
    Import-PosEnv -Path $EnvFile
    $missing = @('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_BUCKET',
                 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB') |
        Where-Object { -not [Environment]::GetEnvironmentVariable($_, 'Process') }
    if ($missing) { throw "missing required environment: $($missing -join ' ')" }

    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

    # --- entrypoint.sh: catch-up only when no success in the last 24h ---
    if ($CatchUp) {
        if ((Test-Path $Marker) -and (Get-Item $Marker).LastWriteTime -gt (Get-Date).AddMinutes(-1440)) {
            Log 'recent backup present, skipping'
            exit 0                       # the finally block still runs
        }
        Log 'no successful backup in the last 24h, running catch-up'
    }

    # One run at a time (schedule vs. manual vs. catch-up): exclusive open, held until finally.
    try {
        $lock = [IO.File]::Open((Join-Path $StateDir 'lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
        throw 'another backup is already running'
    }

    $prefix = $env:S3_PREFIX
    if (-not $prefix) { $prefix = 'billiardbar' }
    $key = "$prefix/billiardbar_$(Get-Date -Format 'yyyy-MM-dd_HHmm').dump"
    $tmp = Join-Path $env:TEMP ("billiardbar." + [Guid]::NewGuid().ToString('N'))
    $pgHost = if ($env:PG_HOST) { $env:PG_HOST } else { '127.0.0.1' }
    $pgPort = if ($env:PG_PORT) { $env:PG_PORT } else { '5433' }

    Log "dumping $($env:POSTGRES_DB)"
    $env:PGPASSWORD = $env:POSTGRES_PASSWORD
    $ErrorActionPreference = 'Continue'      # native stderr must not throw under 5.1
    $o = & (Join-Path $PgBin 'pg_dump.exe') -Fc -h $pgHost -p $pgPort -U $env:POSTGRES_USER -d $env:POSTGRES_DB -f $tmp 2>&1
    $rc = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($rc -ne 0) { $o | ForEach-Object { Log "$_" }; throw 'pg_dump exited non-zero' }

    $size = if (Test-Path $tmp) { (Get-Item $tmp).Length } else { 0 }
    if ($size -le $MinBytes) { throw "dump is only $size bytes (need > $MinBytes)" }

    $ErrorActionPreference = 'Continue'
    $o = & (Join-Path $PgBin 'pg_restore.exe') --list $tmp 2>&1
    $rc = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($rc -ne 0) { $o | ForEach-Object { Log "$_" }; throw 'pg_restore --list rejected the dump' }

    # Write-only IAM key: upload, never list or read back. No ACL flags.
    $ErrorActionPreference = 'Continue'
    $o = & $AwsExe s3 cp --only-show-errors $tmp "s3://$($env:S3_BUCKET)/$key" 2>&1
    $rc = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($rc -ne 0) { $o | ForEach-Object { Log "$_" }; throw "upload to s3://$($env:S3_BUCKET)/$key failed" }

    if (Test-Path $Marker) { (Get-Item $Marker).LastWriteTime = Get-Date } else { New-Item -ItemType File -Path $Marker | Out-Null }
    Log "OK: $size bytes -> s3://$($env:S3_BUCKET)/$key"
} catch {
    Log "BACKUP FAILED: $($_.Exception.Message)"
    $code = 1
} finally {
    $env:PGPASSWORD = $null
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    if ($lock) { $lock.Dispose() }
}
exit $code

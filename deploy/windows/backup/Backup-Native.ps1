# Backup-Native.ps1 -- native port of scripts/deploy/Backup-Database.ps1. One pg_dump -Fc into OutDir, verified with
# pg_restore --list and a size floor, then old db_*.dump files are pruned. Prints the dump path as the LAST line.
param(
    [Parameter(Mandatory)][string]$EnvFile,
    [Parameter(Mandatory)][string]$PgBin,
    [Parameter(Mandatory)][string]$OutDir,
    [string]$Label = 'manual',
    [int]$KeepDays = 30,          # 0 = never prune (use before a migration/restore)
    [string]$LogDir               # when given (scheduled run): also delete *.log* files in it older than 30 days
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\PosCommon.psm1') -Force
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

$MinBytes = 10000
$out = $null
$verified = $false          # once true, the dump is kept whatever happens later
$code = 0
try {
    Import-PosEnv -Path $EnvFile
    foreach ($k in 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD') {
        if (-not [Environment]::GetEnvironmentVariable($k, 'Process')) { throw "missing $k in $EnvFile" }
    }
    $pgHost = if ($env:PG_HOST) { $env:PG_HOST } else { '127.0.0.1' }
    $pgPort = if ($env:PG_PORT) { $env:PG_PORT } else { '5433' }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

    $out = Join-Path $OutDir ("db_{0}_{1}.dump" -f $Label, (Get-Date -Format 'yyyyMMdd_HHmmss'))
    Write-PosLog "backup: pg_dump -Fc $($env:POSTGRES_DB) -> $out"
    $env:PGPASSWORD = $env:POSTGRES_PASSWORD
    $ErrorActionPreference = 'Continue'      # native stderr must not throw under 5.1
    $o = & (Join-Path $PgBin 'pg_dump.exe') -Fc -h $pgHost -p $pgPort -U $env:POSTGRES_USER -d $env:POSTGRES_DB -f $out 2>&1
    $rc = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($rc -ne 0) { $o | ForEach-Object { Write-PosLog "$_" }; throw "pg_dump exited $rc" }

    $size = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }
    if ($size -lt $MinBytes) { throw "backup is only $size bytes -- refusing to trust it" }

    $ErrorActionPreference = 'Continue'
    $toc = & (Join-Path $PgBin 'pg_restore.exe') --list $out 2>&1
    $rc = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($rc -ne 0) { throw "pg_restore --list could not read the dump: $toc" }
    $objects = @($toc | Where-Object { "$_" -notmatch '^;' }).Count
    Write-PosLog "backup: archive OK -- $objects objects, $([math]::Round($size / 1MB, 1)) MB"
    $verified = $true

    # Prune is best effort: a locked/undeletable old file must never cost us the fresh, verified dump.
    if ($KeepDays -gt 0) {
        try {
            $old = @(Get-ChildItem -Path $OutDir -Filter 'db_*.dump' -File |
                     Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) -and $_.FullName -ne $out })
            $n = 0
            foreach ($f in $old) {
                try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $n++ }
                catch { Write-PosLog "backup: WARN: prune failed: $($_.Exception.Message)" }
            }
            if ($n) { Write-PosLog "backup: pruned $n dump(s) older than $KeepDays days" }
        } catch {
            Write-PosLog "backup: WARN: prune failed: $($_.Exception.Message)"
        }
    } else {
        Write-PosLog 'backup: pruning disabled (-KeepDays 0)'
    }
    # Log housekeeping, same best-effort rule (NSSM keeps the live log open: that one is young anyway).
    if ($LogDir -and (Test-Path -LiteralPath $LogDir)) {
        $n = 0
        foreach ($f in @(Get-ChildItem -LiteralPath $LogDir -Filter '*.log*' -File -ErrorAction SilentlyContinue |
                         Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) })) {
            try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $n++ }
            catch { Write-PosLog "backup: WARN: log prune failed: $($_.Exception.Message)" }
        }
        if ($n) { Write-PosLog "backup: pruned $n log file(s) older than 30 days" }
    }
} catch {
    Write-PosLog "BACKUP FAILED: $($_.Exception.Message)"
    if ($out -and -not $verified -and (Test-Path $out)) { Remove-Item -Force $out -ErrorAction SilentlyContinue }
    $code = 1
} finally {
    $env:PGPASSWORD = $null
}
if ($code -eq 0) { Write-Output $out }
exit $code

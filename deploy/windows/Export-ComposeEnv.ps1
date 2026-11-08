<#
Writes backend.env / scheduler.env / backup.env: exactly what `docker compose config` resolves for each
container's environment, plus the native-host overrides. The last step locks OutDir to SYSTEM + Administrators
(-SkipAcl is for tests running non-elevated, which would otherwise lock themselves out).
#>
param(
    [Parameter(Mandatory)][string]$ComposeDir,
    [Parameter(Mandatory)][string]$OutDir,
    [Parameter(Mandatory)][int]$PgPort,
    [string]$EnvFile,
    [switch]$SkipAcl
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'docker not found'; exit 1 }
if (-not $EnvFile) { $EnvFile = Join-Path $ComposeDir '.env' }

# native exe: stderr is harmless noise under 'Stop', so check the exit code instead
$ErrorActionPreference = 'Continue'
$json = & docker compose --project-directory $ComposeDir --env-file $EnvFile config --format json 2>$null
$rc = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($rc -ne 0 -or -not $json) { Write-Error "docker compose config failed (exit $rc)"; exit 1 }
$svc = ($json -join "`n") | ConvertFrom-Json

function Get-ServiceEnv($name) {
    $h = [ordered]@{}
    foreach ($p in $svc.services.$name.environment.PSObject.Properties) { $h[$p.Name] = [string]$p.Value }
    $h
}

function Set-DbHost($h) {
    $new = $h['DATABASE_URL'] -replace '@postgres:5432/', "@127.0.0.1:$PgPort/"
    if ($new -eq $h['DATABASE_URL']) { throw 'DATABASE_URL does not contain @postgres:5432/' }
    $h['DATABASE_URL'] = $new
}

$backend = Get-ServiceEnv 'backend'
Set-DbHost $backend
$backend['PRINT_AGENT_URL'] = 'http://127.0.0.1:9191'

$scheduler = Get-ServiceEnv 'scheduler'
Set-DbHost $scheduler

foreach ($h in $backend, $scheduler) {
    $h.Remove('TZ')   # a Windows TZ makes naive time UTC; the Docker TZ must not leak
    $h['PYTHONUTF8'] = '1'
    $h['PYTHONUNBUFFERED'] = '1'
}

$backup = Get-ServiceEnv 'backup'   # TZ kept: log stamps only
$backup['PG_HOST'] = '127.0.0.1'
$backup['PG_PORT'] = "$PgPort"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($pair in @(@('backend', $backend), @('scheduler', $scheduler), @('backup', $backup))) {
    $lines = foreach ($k in $pair[1].Keys) { "$k=$($pair[1][$k])" }
    [IO.File]::WriteAllText((Join-Path $OutDir "$($pair[0]).env"), (($lines -join "`n") + "`n"), $utf8)
}

if (-not $SkipAcl) {   # LAST step: nothing may need to read the dir as a normal user after this
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -Path $OutDir -AclObject $acl
}
Write-Output "wrote backend.env scheduler.env backup.env to $OutDir"

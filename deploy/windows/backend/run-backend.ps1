<# Native replacement for backend/entrypoint.sh (set -e): init-db -> seed -> factory-finalize -> apply-migrations -> server.
   Order matters, see entrypoint.sh. Any failing step logs "STARTUP FAILED at <step>" and exits 1 (the service manager restarts). #>
param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$EnvFile)
. (Join-Path $PSScriptRoot '_PosLaunch.ps1') -Root $Root -EnvFile $EnvFile

$steps = @(
    @{ n = 'init-db';          m = 'Creating database tables...';    a = @('-m', 'flask', 'init-db') },
    @{ n = 'seed';             m = 'Seeding initial data...';        a = @('seed.py') },
    @{ n = 'factory-finalize'; m = 'Finalizing provisioning...';     a = @('-m', 'flask', 'factory-finalize') },
    @{ n = 'apply-migrations'; m = 'Applying SQL migrations...';     a = @('-m', 'flask', 'apply-migrations') }
)
foreach ($s in $steps) {
    Write-PosLog $s.m
    & $Py @($s.a)
    if ($LASTEXITCODE -ne 0) { Write-PosLog "STARTUP FAILED at $($s.n)"; exit 1 }
}
Write-PosLog 'Starting server...'
& $Py (Join-Path $PSScriptRoot 'serve_windows.py')
exit $LASTEXITCODE

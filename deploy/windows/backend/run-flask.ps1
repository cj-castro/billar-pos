<# One-shot `flask <Command>` with the service environment (e.g. the daily-report task). #>
param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$EnvFile, [Parameter(Mandatory)][string]$Command)
. (Join-Path $PSScriptRoot '_PosLaunch.ps1') -Root $Root -EnvFile $EnvFile
& $Py -m flask @($Command -split '\s+')
exit $LASTEXITCODE

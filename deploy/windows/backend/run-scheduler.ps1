param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$EnvFile)
. (Join-Path $PSScriptRoot '_PosLaunch.ps1') -Root $Root -EnvFile $EnvFile
& $Py 'scheduler.py'
exit $LASTEXITCODE

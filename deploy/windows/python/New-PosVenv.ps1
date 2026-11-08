<#
.SYNOPSIS  Create the backend venv and install the pinned lock (no dependency resolution).
.PARAMETER Wheelhouse  Optional offline wheel directory (--no-index --find-links).
#>
param(
    [Parameter(Mandatory)][string]$Python,
    [Parameter(Mandatory)][string]$VenvDir,
    [Parameter(Mandatory)][string]$Lock,
    [string]$Wheelhouse
)
$ErrorActionPreference = 'Continue'   # native stderr must not throw (PS 5.1); check $LASTEXITCODE

& $Python -m venv $VenvDir
if ($LASTEXITCODE -ne 0) { Write-Error "venv creation failed ($LASTEXITCODE)"; exit 1 }

$pip = @('-m', 'pip', 'install', '--no-deps', '--disable-pip-version-check', '-r', $Lock)
if ($Wheelhouse) { $pip += @('--no-index', '--find-links', $Wheelhouse) }
& (Join-Path $VenvDir 'Scripts\python.exe') @pip
if ($LASTEXITCODE -ne 0) { Write-Error "pip install failed ($LASTEXITCODE)"; exit 1 }
exit 0

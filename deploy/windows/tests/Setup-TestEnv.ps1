<#
Downloads/reuses test tooling into deploy\windows\.native-test\ (gitignored):
  pgsql\ (PG 15 zip), nginx\ (1.27.5), python\ (uv 3.11), venv\, bin\nssm.exe, bin\aws\ (AWS CLI v2, admin-extracted).
Reuses a downloads\ dir when -SpikeDownloads (default: $env:POS_SPIKE_DOWNLOADS) points at one. A failed download is reported, not fatal.
#>
param(
    [string]$SpikeDownloads = $env:POS_SPIKE_DOWNLOADS
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path (Split-Path $PSScriptRoot -Parent) '.native-test'
$dl = Join-Path $root 'dl'
New-Item -ItemType Directory -Force $root, $dl | Out-Null
$failed = @()

function Get-File($name, $url) {
    $dest = Join-Path $dl $name
    if (Test-Path $dest) { return $dest }
    $spike = if ($SpikeDownloads) { Join-Path $SpikeDownloads $name }
    if ($spike -and (Test-Path $spike)) { Copy-Item $spike $dest; return $dest }
    for ($i = 1; $i -le 4; $i++) {
        try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; break }
        catch { if ($i -eq 4) { Remove-Item $dest -ErrorAction SilentlyContinue; throw }; Start-Sleep 5 }
    }
    return $dest
}
function Step($label, [scriptblock]$body) {
    try { & $body; Write-Host "OK   $label" }
    catch { Write-Host "FAIL $label : $($_.Exception.Message)"; $script:failed += $label }
}

Step 'postgres' {
    if (-not (Test-Path "$root\pgsql\bin\postgres.exe")) {
        $z = Get-File 'pg.zip' 'https://get.enterprisedb.com/postgresql/postgresql-15.19-1-windows-x64-binaries.zip'
        Expand-Archive $z "$root\pg_tmp" -Force
        Move-Item "$root\pg_tmp\pgsql" "$root\pgsql"; Remove-Item "$root\pg_tmp" -Recurse -Force
    }
}
Step 'nginx' {
    if (-not (Test-Path "$root\nginx\nginx.exe")) {
        $z = Get-File 'nginx.zip' 'https://nginx.org/download/nginx-1.27.5.zip'
        Expand-Archive $z "$root\nginx_tmp" -Force
        Move-Item (Get-ChildItem "$root\nginx_tmp" -Directory | Select-Object -First 1).FullName "$root\nginx"
        Remove-Item "$root\nginx_tmp" -Recurse -Force
    }
}
Step 'nssm 2.24' {
    if (-not (Test-Path "$root\bin\nssm.exe")) {
        $z = Get-File 'nssm-2.24.zip' 'https://nssm.cc/release/nssm-2.24.zip'
        Expand-Archive $z "$root\nssm_tmp" -Force
        New-Item -ItemType Directory -Force "$root\bin" | Out-Null
        Copy-Item "$root\nssm_tmp\nssm-2.24\win64\nssm.exe" "$root\bin\nssm.exe"
        Remove-Item "$root\nssm_tmp" -Recurse -Force
    }
}
Step 'aws cli v2' {
    $awsExe = "$root\bin\aws\Amazon\AWSCLIV2\aws.exe"
    if (-not (Test-Path $awsExe)) {
        $msi = Get-File 'AWSCLIV2.msi' 'https://awscli.amazonaws.com/AWSCLIV2.msi'
        New-Item -ItemType Directory -Force "$root\bin\aws" | Out-Null
        $p = Start-Process msiexec -ArgumentList '/a', "`"$msi`"", '/qn', "TARGETDIR=`"$root\bin\aws`"" -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "msiexec exit $($p.ExitCode)" }
        if (-not (Test-Path $awsExe)) { throw 'aws.exe not found after extract' }
    }
}
Step 'python 3.11 + venv' {
    $env:UV_PYTHON_INSTALL_DIR = "$root\python"
    if (-not (Test-Path "$root\venv\Scripts\python.exe")) {
        & uv python install 3.11; if ($LASTEXITCODE) { throw 'uv python install failed' }
        & uv venv --python 3.11 "$root\venv"; if ($LASTEXITCODE) { throw 'uv venv failed' }
    }
    & uv pip install --python "$root\venv\Scripts\python.exe" -r (Join-Path $PSScriptRoot 'requirements-test.txt')
    if ($LASTEXITCODE) { throw 'uv pip install failed' }
}
if ($failed) { Write-Host "Setup finished with failures: $($failed -join ', ')"; exit 1 }
Write-Host 'Setup complete.'

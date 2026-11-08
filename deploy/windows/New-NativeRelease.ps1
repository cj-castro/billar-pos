<#
Builds the offline release bundle that Install-NativePOS.ps1 consumes (-ReleaseDir). Run on any Windows PC with
internet (or feed local copies); the result is copied to the bar PC and installed with no network needed.

  app\backend   app\dist   app\frontend-nginx.conf
  bin\pgsql  bin\nginx  bin\python  bin\nssm.exe  bin\AWSCLIV2.msi
  wheelhouse\   deploy\   SHA256SUMS.txt

backend, deploy and frontend-nginx.conf come from `git archive <Ref>` (commit first; default HEAD of this checkout).
Binary sources default to a download; each can instead be a local copy (-PgDir -NginxDir -PythonDir -NssmExe -AwsMsi),
which is what the tests do. -PythonDir must be a full CPython 3.11 (venv + pip), e.g. a `uv python install 3.11` dir.
The frontend is built with VITE_API_URL=/api/v1 VITE_SOCKET_URL=/ unless -DistDir is given (at cutover, use
`docker cp <frontend-container>:/usr/share/nginx/html <dir>` so the bar serves exactly what it served before).
-VerifyDir <release> only checks SHA256SUMS.txt (exit 1 on any mismatch/missing/extra file).
#>
param(
    [string]$OutDir,
    [string]$DistDir,
    [string]$Ref = 'HEAD',
    [string]$PgDir, [string]$NginxDir, [string]$PythonDir, [string]$NssmExe, [string]$AwsMsi,
    [string]$VerifyDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Get-Sums([string]$Dir) {
    $Dir = (Resolve-Path $Dir).Path.TrimEnd('\')
    Get-ChildItem $Dir -Recurse -File -Force | Where-Object { $_.FullName -ne (Join-Path $Dir 'SHA256SUMS.txt') } |
        Sort-Object FullName | ForEach-Object {
            '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.FullName.Substring($Dir.Length + 1).Replace('\', '/')
        }
}

if ($VerifyDir) {
    $want = @(Get-Content -Encoding UTF8 (Join-Path $VerifyDir 'SHA256SUMS.txt'))
    $got = @(Get-Sums $VerifyDir)
    $diff = Compare-Object $want $got
    if ($diff) { $diff | ForEach-Object { Write-Host "MISMATCH $($_.SideIndicator) $($_.InputObject)" }; exit 1 }
    Write-Host "OK: $($got.Count) files verified"; exit 0
}
if (-not $OutDir) { throw '-OutDir is required' }

function Native([string]$exe, [string[]]$a, [string]$cwd) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    if ($cwd) { Push-Location $cwd }
    try { & $exe @a 2>&1 | ForEach-Object { Write-Host "  $_" } } finally { if ($cwd) { Pop-Location }; $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ') failed ($LASTEXITCODE)" }
}
function Download([string]$url, [string]$dest) {
    for ($i = 1; $i -le 4; $i++) {
        try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; return }
        catch { if ($i -eq 4) { throw }; Start-Sleep 5 }
    }
}
function Copy-Dir([string]$src, [string]$dst) {
    New-Item -ItemType Directory -Force $dst | Out-Null
    & robocopy.exe $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $src -> $dst failed ($LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}
# git archive <ref>[:subdir] [paths] -> extract into $dst
function Git-Export([string]$tree, [string[]]$paths, [string]$dst) {
    $tar = Join-Path $tmp ([guid]::NewGuid().ToString('N') + '.tar')      # tar, not zip: Expand-Archive chokes on dotfiles
    Native 'git' (@('-C', $Repo, 'archive', '--format=tar', '-o', $tar, $tree) + $paths)
    New-Item -ItemType Directory -Force $dst | Out-Null
    Native (Join-Path $env:SystemRoot "System32/tar.exe") @('-xf', $tar, '-C', $dst)
    Remove-Item $tar
}

$Out = [IO.Path]::GetFullPath($OutDir)
if ((Test-Path $Out) -and (Get-ChildItem $Out -Force)) { throw "OutDir is not empty: $Out" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('posrel-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp, $Out | Out-Null
try {
    Write-Host "== app (git archive $Ref)"
    Git-Export $Ref @('backend') (Join-Path $Out 'app')
    Git-Export $Ref @('frontend/nginx.conf') (Join-Path $tmp 'fe')
    Copy-Item (Join-Path $tmp 'fe\frontend\nginx.conf') (Join-Path $Out 'app\frontend-nginx.conf')
    Git-Export "${Ref}:deploy/windows" @() (Join-Path $Out 'deploy')
    # tests and local test tooling never ship (the installer excludes them as well)
    Remove-Item (Join-Path $Out 'deploy\tests') -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host '== frontend dist'
    if ($DistDir) { Copy-Dir (Resolve-Path $DistDir).Path (Join-Path $Out 'app\dist') }
    else {
        Git-Export $Ref @('frontend') (Join-Path $tmp 'fesrc')
        $fe = Join-Path $tmp 'fesrc\frontend'
        $env:VITE_API_URL = '/api/v1'; $env:VITE_SOCKET_URL = '/'
        Native 'npm.cmd' @('ci') $fe
        Native 'npm.cmd' @('run', 'build') $fe
        Copy-Dir (Join-Path $fe 'dist') (Join-Path $Out 'app\dist')
    }

    Write-Host '== bin'
    $bin = Join-Path $Out 'bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    if (-not $PgDir) {
        $z = Join-Path $tmp 'pg.zip'; Download 'https://get.enterprisedb.com/postgresql/postgresql-15.19-1-windows-x64-binaries.zip' $z
        Expand-Archive $z (Join-Path $tmp 'pg'); $PgDir = Join-Path $tmp 'pg\pgsql'
    }
    Copy-Dir $PgDir (Join-Path $bin 'pgsql')
    foreach ($d in 'pgAdmin 4', 'StackBuilder', 'doc', 'include') { Remove-Item (Join-Path $bin "pgsql\$d") -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not $NginxDir) {
        $z = Join-Path $tmp 'nginx.zip'; Download 'https://nginx.org/download/nginx-1.27.5.zip' $z
        Expand-Archive $z (Join-Path $tmp 'ng'); $NginxDir = (Get-ChildItem (Join-Path $tmp 'ng') -Directory | Select-Object -First 1).FullName
    }
    Copy-Dir $NginxDir (Join-Path $bin 'nginx')
    foreach ($d in 'html', 'docs', 'logs', 'temp') { Remove-Item (Join-Path $bin "nginx\$d") -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not $PythonDir) {                                       # R: full CPython 3.11 (venv + pip) via uv
        $env:UV_PYTHON_INSTALL_DIR = Join-Path $tmp 'uvpy'
        Native 'uv' @('python', 'install', '3.11')
        $PythonDir = (Get-ChildItem $env:UV_PYTHON_INSTALL_DIR -Directory -Filter 'cpython-3.11*' | Select-Object -First 1).FullName
    }
    Copy-Dir $PythonDir (Join-Path $bin 'python')
    if (-not $NssmExe) {                                         # R7: NSSM is downloaded, never committed
        $z = Join-Path $tmp 'nssm.zip'; Download 'https://nssm.cc/release/nssm-2.24.zip' $z
        Expand-Archive $z (Join-Path $tmp 'nssm'); $NssmExe = Join-Path $tmp 'nssm\nssm-2.24\win64\nssm.exe'
    }
    Copy-Item $NssmExe (Join-Path $bin 'nssm.exe')
    if (-not $AwsMsi) { $AwsMsi = Join-Path $tmp 'AWSCLIV2.msi'; Download 'https://awscli.amazonaws.com/AWSCLIV2.msi' $AwsMsi }
    Copy-Item $AwsMsi (Join-Path $bin 'AWSCLIV2.msi')
    foreach ($f in 'pgsql\bin\pg_ctl.exe', 'nginx\nginx.exe', 'nginx\conf\mime.types', 'python\python.exe', 'nssm.exe', 'AWSCLIV2.msi') {
        if (-not (Test-Path (Join-Path $bin $f))) { throw "bin\$f missing after assembly (bad source dir?)" }
    }

    Write-Host '== wheelhouse'
    $wh = Join-Path $Out 'wheelhouse'
    New-Item -ItemType Directory -Force $wh | Out-Null
    Native (Join-Path $bin 'python\python.exe') @('-m', 'pip', 'download', '-r', (Join-Path $Out 'deploy\python\requirements-backend.lock.txt'),
        '--only-binary=:all:', '--platform', 'win_amd64', '--python-version', '3.11', '--no-deps', '-d', $wh, '--disable-pip-version-check')

    Write-Host '== SHA256SUMS.txt'
    $sums = Get-Sums $Out
    [IO.File]::WriteAllLines((Join-Path $Out 'SHA256SUMS.txt'), [string[]]$sums, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Release built: $Out ($($sums.Count) files, $Ref @ $(& git -C $Repo rev-parse --short $Ref))"
} catch {
    Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue      # never leave a partial release that looks usable
    throw
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

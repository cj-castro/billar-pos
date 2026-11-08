<#
Derives the native nginx site from the production frontend/nginx.conf with exactly three substitutions
(listen port, backend address, web root) and renders nginx.conf (from nginx.conf.template) beside it.
Throws if any pattern is missing, so a changed production config can never be converted silently.
Logs go to <Out dir>\..\logs.
#>
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Out,
    [Parameter(Mandatory)][int]$ListenPort,
    [Parameter(Mandatory)][int]$BackendPort,
    [Parameter(Mandatory)][string]$DistDir
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$text = [IO.File]::ReadAllText($Source, $utf8)
$dist = $DistDir.Replace('\', '/').TrimEnd('/')

$subs = @(
    @{ From = 'listen 80;';                      To = "listen $ListenPort;" },
    @{ From = 'http://backend:5000';             To = "http://127.0.0.1:$BackendPort" },
    @{ From = 'root /usr/share/nginx/html;';     To = "root $dist;" }
)
foreach ($s in $subs) {
    if (-not $text.Contains($s.From)) { throw "pattern not found in ${Source}: $($s.From)" }
    $text = $text.Replace($s.From, $s.To)
}

$outDir = Split-Path -Parent $Out
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
[IO.File]::WriteAllText($Out, $text, $utf8)

$logDir = (Join-Path (Split-Path -Parent $outDir) 'logs').Replace('\', '/')
$tpl = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'nginx.conf.template'), $utf8)
[IO.File]::WriteAllText((Join-Path $outDir 'nginx.conf'), $tpl.Replace('{{LOG_DIR}}', $logDir), $utf8)

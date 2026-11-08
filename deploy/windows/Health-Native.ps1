<#
One line per check ([OK] / [FAIL] / [SKIP]); exit 0 only if nothing FAILed.
Checks: each <Prefix> service Running (unless -SkipServices); GET http://127.0.0.1:<WebPort>/api/v1/health = 200 (through nginx);
StateDir\last_success younger than 26 h; free space on the system drive above -MinFreeGB (default 5).
#>
param(
    [string]$Prefix = 'BilliardsPOS',
    [int]$WebPort = 8080,
    [string]$StateDir = 'C:\BilliardsPOS\state',
    [switch]$SkipServices,      # lets the non-service checks be tested without installed services
    [double]$MinFreeGB = 5
)
$ErrorActionPreference = 'Stop'
$script:bad = 0
function Report([bool]$ok, [string]$name, [string]$detail) {
    if (-not $ok) { $script:bad++ }
    Write-Output ("[{0}] {1}: {2}" -f $(if ($ok) { 'OK' } else { 'FAIL' }), $name, $detail)
}

if ($SkipServices) { Write-Output '[SKIP] services: -SkipServices' } else {
    foreach ($s in 'Postgres', 'Backend', 'Scheduler', 'Web') {
        $n = "$Prefix-$s"
        $svc = Get-Service -Name $n -ErrorAction SilentlyContinue
        if (-not $svc) { Report $false "service $n" 'not installed' } else { Report ($svc.Status -eq 'Running') "service $n" "$($svc.Status)" }
    }
}

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/api/v1/health" -UseBasicParsing -TimeoutSec 10
    Report ($r.StatusCode -eq 200) 'health endpoint' "HTTP $($r.StatusCode)"
} catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
    Report $false 'health endpoint' $(if ($code) { "HTTP $code" } else { "unreachable: $($_.Exception.Message)" })
}

$marker = Join-Path $StateDir 'last_success'
if (-not (Test-Path $marker)) { Report $false 'last_success' "missing ($marker)" } else {
    $age = (Get-Date) - (Get-Item $marker).LastWriteTime
    Report ($age.TotalHours -lt 26) 'last_success' ("{0:N1} h ago (limit 26 h)" -f $age.TotalHours)
}

$drive = (Get-PSDrive -Name $env:SystemDrive.TrimEnd(':'))
$free = $drive.Free / 1GB
Report ($free -gt $MinFreeGB) "disk $($env:SystemDrive)" ("{0:N1} GB free (need > {1:N0} GB)" -f $free, $MinFreeGB)

exit $(if ($script:bad -eq 0) { 0 } else { 1 })

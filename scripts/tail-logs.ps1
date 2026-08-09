# =============================================================================
# tail-logs.ps1
# Phase 3 - Live merged tail of every service log in C:\POS\logs\, prefixed
# with a timestamp and the source service name (LOG-03, D-04/D-05).
#
# No admin requirement -- reading log files needs no elevation once the
# directory's ACL grants the running user read access (see
# reconfigure-log-paths.ps1's icacls step).
#
# Usage:
#   .\scripts\tail-logs.ps1                  # watch every *.log in C:\POS\logs\
#   .\scripts\tail-logs.ps1 -Service backend  # watch only backend*.log
#   .\scripts\tail-logs.ps1 -LogDir D:\other\logs
#
# PowerShell 5.1 has no native concurrent multi-file Get-Content -Wait, so
# each file is tailed by its own background Start-Job; the main thread polls
# Receive-Job on all of them once per second and prints merged, prefixed
# output. Ctrl+C is handled via try/finally, which stops and removes every
# background job so nothing is left orphaned.
# =============================================================================

param(
    [string]$Service = $null,
    [string]$LogDir = "C:\POS\logs"
)

Write-Host "Tailing logs from $LogDir" -ForegroundColor Cyan
if ($Service) {
    Write-Host "Filter: $Service*.log only" -ForegroundColor Cyan
}

# Resolve the file set to tail.
$pattern = if ($Service) { "$LogDir\${Service}*.log" } else { "$LogDir\*.log" }
$files = @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue)

if ($files.Count -eq 0) {
    Write-Host "No log files found matching '$pattern' -- has scripts\reconfigure-log-paths.ps1 been run yet?" -ForegroundColor Yellow
    exit 1
}

Write-Host "`nWatching $($files.Count) file(s):" -ForegroundColor Green
foreach ($file in $files) {
    Write-Host "  - $($file.Name)" -ForegroundColor Green
}
Write-Host "`nPress Ctrl+C to stop.`n" -ForegroundColor Gray

# Derive a readable service name from the log filename, stripping a trailing
# "_err" suffix so stdout/stderr pairs share the same displayed name.
function Get-ServiceNameFromFile {
    param([string]$FileName)
    $name = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
    if ($name.EndsWith("_err")) {
        $name = $name.Substring(0, $name.Length - 4)
    }
    return $name
}

$jobs = @()

try {
    foreach ($file in $files) {
        $serviceName = Get-ServiceNameFromFile -FileName $file.Name
        $job = Start-Job -ScriptBlock {
            param($Path, $Name)
            Get-Content -Path $Path -Wait -Tail 0 -ErrorAction SilentlyContinue | ForEach-Object {
                "[$(Get-Date -Format 'HH:mm:ss')] [$Name] $_"
            }
        } -ArgumentList $file.FullName, $serviceName
        $jobs += $job
    }

    while ($true) {
        foreach ($job in $jobs) {
            $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
            if ($output) {
                $output | ForEach-Object { Write-Host $_ }
            }
        }
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Host "`nStopping background tail jobs..." -ForegroundColor Yellow
    foreach ($job in $jobs) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Host "Cleaned up $($jobs.Count) job(s)." -ForegroundColor Gray
}

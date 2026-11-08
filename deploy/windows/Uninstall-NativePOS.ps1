<#
Stops (and removes) the <Prefix>-* services and scheduled tasks. Exact names only (a prefix that is a prefix of another
install, e.g. BilliardsPOS vs BilliardsPOS-Test, never matches). Never deletes <Root>\pgdata, backups, config or logs.
  -StopOnly  stop + disable services and tasks, keep the registrations (rollback to Docker / maintenance)
  -DryRun    print the plan (`PLAN: ` lines) for all four services and all tasks; executes nothing, needs no elevation
#>
param([Parameter(Mandatory)][string]$Prefix, [switch]$StopOnly, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
if (-not $DryRun) {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'run from an elevated shell (or use -DryRun)' }
}
$services = 'Web', 'Scheduler', 'Backend', 'Postgres' | ForEach-Object { "$Prefix-$_" }     # stop order
$tasks = 'S3Backup', 'S3Backup-Catchup', 'LocalBackup', 'DailyReport' | ForEach-Object { "$Prefix-$_" }

function Act([string]$text, [scriptblock]$act) {
    if ($DryRun) { Write-Host "PLAN: $text"; return }
    Write-Host "RUN: $text"; & $act
}
function ScCmd([string[]]$a) {
    Act ('sc ' + ($a -join ' ')) { $o = & sc.exe @a 2>&1; if ($LASTEXITCODE -ne 0) { throw "sc $($a -join ' ') failed ($LASTEXITCODE): $o" } }
}
function Wait-State([string]$n, [string]$state) {
    $end = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $end) {
        $s = Get-Service -Name $n -ErrorAction SilentlyContinue
        if (-not $s -or $s.Status -eq $state) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "timeout waiting for $n to reach $state"
}

foreach ($n in $services) {
    if (-not $DryRun -and -not (Get-Service -Name $n -ErrorAction SilentlyContinue)) { continue }
    Act "sc stop $n" {
        if ((Get-Service -Name $n).Status -ne 'Stopped') { & sc.exe stop $n | Out-Null; Wait-State $n 'Stopped' }
    }
    if ($StopOnly) { ScCmd @('config', $n, 'start=', 'disabled') } else { ScCmd @('delete', $n) }
}
foreach ($t in $tasks) {
    if (-not $DryRun -and -not (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue)) { continue }
    if ($StopOnly) {
        Act "Disable-ScheduledTask -TaskName $t" { Disable-ScheduledTask -TaskName $t | Out-Null }
    } else {
        Act "Unregister-ScheduledTask -TaskName $t -Confirm:`$false" { Unregister-ScheduledTask -TaskName $t -Confirm:$false }
    }
}
Write-Host "OK $Prefix-* $(if ($StopOnly) { 'stopped and disabled' } else { 'removed' }); data (pgdata, backups, config, logs) untouched"
exit 0

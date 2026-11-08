<#
Installs the native POS stack as Windows services + scheduled tasks. Idempotent: re-running stops and re-registers
this prefix's services (data, config and logs are kept), refreshes the binaries/app and starts everything again.
Needs an elevated shell, except with -DryRun, which prints every planned action as a `PLAN: ` line and executes nothing.

ReleaseDir contract (produced by Task 12):
  app\backend  app\dist  app\frontend-nginx.conf (the production frontend/nginx.conf)
  bin\pgsql (bin\pg_ctl.exe ...)  bin\nginx (nginx.exe, conf\mime.types)  bin\python (python.exe, 3.11)  bin\nssm.exe
  bin\AWSCLIV2.msi  -- extracted (msiexec /a, no system install) into <Root>\bin\aws; skipped when bin\aws already holds
                       Amazon\AWSCLIV2\aws.exe
  wheelhouse\  (offline wheels for the lock)   deploy\ (= deploy\windows of the repo, incl. python\requirements-backend.lock.txt)
EnvDir = directory with backend.env / scheduler.env / backup.env (Export-ComposeEnv.ps1); copied to <Root>\config with a
SYSTEM + Administrators-only ACL.

Services (all <Prefix>-*): Postgres (pg_ctl register, runs as NT AUTHORITY\NetworkService, which gets Modify on pgdata),
Backend / Scheduler / Web (NSSM, LocalSystem). Tasks: S3Backup (02:00), S3Backup-Catchup (startup, -CatchUp; one task has one
action line, so the two triggers of the brief are two tasks), LocalBackup (03:00), DailyReport (08:00, only -DailyReportTask).
#>
param(
    [Parameter(Mandatory)][string]$ReleaseDir,
    [string]$Root = 'C:\BilliardsPOS',
    [string]$Prefix = 'BilliardsPOS',
    [int]$WebPort = 8080,
    [int]$PgPort = 5433,
    [int]$BackendPort = 5000,
    [ValidateSet('Automatic', 'Manual')][string]$StartupType = 'Automatic',
    [Parameter(Mandatory)][string]$EnvDir,
    [switch]$SkipTasks,
    [switch]$DailyReportTask,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
function Abs([string]$p) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p).TrimEnd('\') }
$ReleaseDir = Abs $ReleaseDir; $Root = Abs $Root; $EnvDir = Abs $EnvDir

if (-not $DryRun) {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'run from an elevated shell (or use -DryRun)' }
}
Import-Module (Join-Path $PSScriptRoot 'PosCommon.psm1') -Force

# ---- paths
$P = @{}
foreach ($n in 'app', 'bin', 'config', 'logs', 'state', 'backups', 'pgdata', 'deploy', 'venv', 'web') { $P[$n] = Join-Path $Root $n }
$Nssm = Join-Path $P.bin 'nssm.exe'
$PgBin = Join-Path $P.bin 'pgsql\bin'
$AwsExe = Join-Path $P.bin 'aws\Amazon\AWSCLIV2\aws.exe'
$Ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$S = [ordered]@{}
foreach ($n in 'Postgres', 'Backend', 'Scheduler', 'Web') { $S[$n] = "$Prefix-$n" }

# ---- helpers: every side effect goes through Native / Step so -DryRun can print it instead
function Q([string]$a) {
    if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
    $s = [regex]::Replace($a, '(\\*)"', '$1$1\"')
    $s = [regex]::Replace($s, '(\\+)$', '$1$1')
    return '"' + $s + '"'
}
function Native([string]$exe, [string[]]$a, [int]$OkMax = 0, [switch]$Tolerate) {
    $line = ([IO.Path]::GetFileNameWithoutExtension($exe) + ' ' + (($a | ForEach-Object { Q $_ }) -join ' ')).Trim()
    if ($DryRun) { Write-Host "PLAN: $line"; return }
    Write-Host "RUN: $line"
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $exe; $psi.Arguments = ($a | ForEach-Object { Q $_ }) -join ' '
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $p = [Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    $txt = (($o.Result + $e.Result) -replace "`0", '').Trim()
    if ($txt) { Write-Host $txt }
    if ($p.ExitCode -gt $OkMax -and -not $Tolerate) { throw "$line failed (exit $($p.ExitCode))" }
}
function Step([string]$text, [scriptblock]$act) {
    if ($DryRun) { Write-Host "PLAN: $text"; return }
    Write-Host "STEP: $text"; & $act
}
function SvcExists([string]$n) { [bool](Get-Service -Name $n -ErrorAction SilentlyContinue) }
function WaitSvc([string]$n, [bool]$gone, [string]$state) {
    $end = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $end) {
        $s = Get-Service -Name $n -ErrorAction SilentlyContinue
        if ($gone) { if (-not $s) { return } } elseif (-not $s -or $s.Status -eq $state) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "timeout waiting for $n"
}

# ---- 0. validate the release
$need = @('bin\nssm.exe', 'bin\pgsql\bin\pg_ctl.exe', 'bin\nginx\nginx.exe', 'bin\python\python.exe', 'app\backend', 'app\dist',
          'app\frontend-nginx.conf', 'deploy\backend\run-backend.ps1', 'deploy\python\requirements-backend.lock.txt')
foreach ($n in $need) { if (-not (Test-Path (Join-Path $ReleaseDir $n))) { throw "ReleaseDir is missing $n" } }
if (-not ((Test-Path (Join-Path $ReleaseDir 'bin\AWSCLIV2.msi')) -or (Test-Path (Join-Path $ReleaseDir 'bin\aws\Amazon\AWSCLIV2\aws.exe')))) {
    throw 'ReleaseDir is missing bin\AWSCLIV2.msi (or a prebuilt bin\aws)'
}
foreach ($n in 'backend.env', 'scheduler.env', 'backup.env') { if (-not (Test-Path (Join-Path $EnvDir $n))) { throw "EnvDir is missing $n" } }
Import-PosEnv -Path (Join-Path $EnvDir 'backup.env')      # DB bootstrap credentials (same values as the compose DB)
foreach ($k in 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB') {
    if (-not [Environment]::GetEnvironmentVariable($k, 'Process')) { throw "backup.env has no $k" }
}

# ---- 1. stop and remove this prefix's existing services (reverse dependency order)
foreach ($k in 'Web', 'Scheduler', 'Backend', 'Postgres') {
    $n = $S[$k]
    if (-not (SvcExists $n)) { continue }      # -DryRun therefore plans a fresh install unless the prefix already exists
    Native 'sc.exe' @('stop', $n) -Tolerate
    if (-not $DryRun) { WaitSvc $n $false 'Stopped' }
    Native 'sc.exe' @('delete', $n)
    if (-not $DryRun) { WaitSvc $n $true '' }
}

# ---- 2. layout, binaries, app, scripts
foreach ($n in 'app', 'bin', 'config', 'logs', 'state', 'backups', 'deploy') {
    Step "mkdir $($P[$n])" { New-Item -ItemType Directory -Force -Path $P[$n] | Out-Null }
}
function Copy-Tree([string]$src, [string]$dst, [string[]]$extra = @()) {
    if ((Abs $src) -eq (Abs $dst)) { return }
    Native 'robocopy.exe' (@($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1') + $extra) -OkMax 7
}
Copy-Tree (Join-Path $ReleaseDir 'bin') $P.bin
Copy-Tree (Join-Path $ReleaseDir 'app\backend') (Join-Path $P.app 'backend')
Copy-Tree (Join-Path $ReleaseDir 'app\dist') (Join-Path $P.app 'dist') @('/PURGE')      # hashed asset names: drop stale ones
Step "copy $ReleaseDir\app\frontend-nginx.conf -> $($P.app)" { Copy-Item (Join-Path $ReleaseDir 'app\frontend-nginx.conf') $P.app -Force }
Copy-Tree (Join-Path $ReleaseDir 'deploy') $P.deploy @('/XD', '.native-test', 'tests', '__pycache__')

# ---- 3. config: locked ACL first, then the secrets
Step "ACL $($P.config): SYSTEM + Administrators only (protected), then copy backend.env scheduler.env backup.env" {
    New-Item -ItemType Directory -Force -Path $P.config | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -Path $P.config -AclObject $acl
    if ((Abs $EnvDir) -ne (Abs $P.config)) {
        foreach ($n in 'backend.env', 'scheduler.env', 'backup.env') { Copy-Item (Join-Path $EnvDir $n) (Join-Path $P.config $n) -Force }
    }
}

# ---- 4. python venv from the offline wheelhouse, AWS CLI
$venvArgs = @{ Python = (Join-Path $P.bin 'python\python.exe'); VenvDir = $P.venv; Lock = (Join-Path $P.deploy 'python\requirements-backend.lock.txt') }
$wheels = Join-Path $ReleaseDir 'wheelhouse'
if (Test-Path $wheels) { $venvArgs.Wheelhouse = $wheels }
Step "New-PosVenv.ps1 -Python $($venvArgs.Python) -VenvDir $($P.venv) -Lock $($venvArgs.Lock)$(if ($venvArgs.Wheelhouse) { " -Wheelhouse $wheels" })" {
    & (Join-Path $P.deploy 'python\New-PosVenv.ps1') @venvArgs
    if ($LASTEXITCODE -ne 0) { throw "New-PosVenv failed ($LASTEXITCODE)" }
}
if ($DryRun -or -not (Test-Path $AwsExe)) {
    Native 'msiexec.exe' @('/a', (Join-Path $P.bin 'AWSCLIV2.msi'), '/qn', "TARGETDIR=$(Join-Path $P.bin 'aws')") -Tolerate:$false
}

# ---- 5. postgres: cluster (idempotent), ACL, service
Step "Initialize-PosCluster.ps1 -PgBin $PgBin -DataDir $($P.pgdata) -Port $PgPort -DbUser $($env:POSTGRES_USER) -DbPassword ****** -DbName $($env:POSTGRES_DB)" {
    & (Join-Path $P.deploy 'postgres\Initialize-PosCluster.ps1') -PgBin $PgBin -DataDir $P.pgdata -Port $PgPort `
        -DbUser $env:POSTGRES_USER -DbPassword $env:POSTGRES_PASSWORD -DbName $env:POSTGRES_DB
    if ($LASTEXITCODE -ne 0) { throw "Initialize-PosCluster failed ($LASTEXITCODE)" }
}
# NetworkService (S-1-5-20) runs the service: Modify on the data dir, read+execute on the binaries
Native 'icacls.exe' @($P.pgdata, '/grant', '*S-1-5-20:(OI)(CI)M', '/T', '/C', '/Q')
Native 'icacls.exe' @((Join-Path $P.bin 'pgsql'), '/grant', '*S-1-5-20:(OI)(CI)RX', '/C', '/Q')
$pgStart = if ($StartupType -eq 'Automatic') { 'auto' } else { 'demand' }
Native (Join-Path $PgBin 'pg_ctl.exe') @('register', '-N', $S.Postgres, '-S', $pgStart, '-D', $P.pgdata, '-U', 'NT AUTHORITY\NetworkService', '-o', "-p $PgPort")

# ---- 6. nginx runtime prefix <Root>\web (R14)
foreach ($n in 'conf', 'temp', 'logs') { Step "mkdir $(Join-Path $P.web $n)" { New-Item -ItemType Directory -Force -Path (Join-Path $P.web $n) | Out-Null } }
Step "copy $(Join-Path $P.bin 'nginx\conf\mime.types') -> $(Join-Path $P.web 'conf')" { Copy-Item (Join-Path $P.bin 'nginx\conf\mime.types') (Join-Path $P.web 'conf') -Force }
$conf = Join-Path $P.web 'conf\pos-site.conf'
Step "Convert-NginxSite.ps1 -Source $(Join-Path $P.app 'frontend-nginx.conf') -Out $conf -ListenPort $WebPort -BackendPort $BackendPort -DistDir $(Join-Path $P.app 'dist')" {
    & (Join-Path $P.deploy 'nginx\Convert-NginxSite.ps1') -Source (Join-Path $P.app 'frontend-nginx.conf') -Out $conf `
        -ListenPort $WebPort -BackendPort $BackendPort -DistDir (Join-Path $P.app 'dist')
}
Native (Join-Path $P.bin 'nginx\nginx.exe') @('-p', $P.web, '-c', 'conf\nginx.conf', '-t')

# ---- 7. NSSM services
$nssmStart = if ($StartupType -eq 'Automatic') { 'SERVICE_AUTO_START' } else { 'SERVICE_DEMAND_START' }
function PsArgs([string]$script, [string[]]$more) {
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + ((@($script) + $more | ForEach-Object { Q $_ }) -join ' ')
}
$defs = @(
    @{ n = $S.Backend;   app = $Ps; args = (PsArgs (Join-Path $P.deploy 'backend\run-backend.ps1') @('-Root', $Root, '-EnvFile', (Join-Path $P.config 'backend.env')))
       dep = $S.Postgres; dir = $P.app; env = @("POS_BIND_PORT=$BackendPort"); desc = 'POS backend (Flask/eventlet)' },
    @{ n = $S.Scheduler; app = $Ps; args = (PsArgs (Join-Path $P.deploy 'backend\run-scheduler.ps1') @('-Root', $Root, '-EnvFile', (Join-Path $P.config 'scheduler.env')))
       dep = $S.Postgres; dir = $P.app; env = @(); desc = 'POS scheduler' },
    @{ n = $S.Web;       app = (Join-Path $P.bin 'nginx\nginx.exe'); args = "-p $(Q $P.web) -c conf\nginx.conf"
       dep = $S.Backend;  dir = $P.web; env = @(); desc = 'POS web (nginx)' }
)
foreach ($d in $defs) {
    $n = $d.n
    Native $Nssm @('install', $n, $d.app)
    $log = Join-Path $P.logs "$n.log"
    $set = [ordered]@{
        AppParameters = $d.args; AppDirectory = $d.dir; DisplayName = $n; Description = $d.desc
        ObjectName = 'LocalSystem'; Start = $nssmStart; DependOnService = $d.dep
        AppExit = @('Default', 'Restart'); AppRestartDelay = '5000'
        AppStdout = $log; AppStderr = $log; AppRotateFiles = '1'; AppRotateOnline = '1'; AppRotateBytes = '10485760'
        AppKillProcessTree = '1'
    }
    if ($d.env.Count) { $set.AppEnvironmentExtra = $d.env[0] }
    foreach ($k in $set.Keys) { Native $Nssm (@('set', $n, $k) + @($set[$k])) }
}
foreach ($k in 'Postgres', 'Backend', 'Scheduler', 'Web') {
    Native 'sc.exe' @('failure', $S[$k], 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/30000')
}

# ---- 8. scheduled tasks (SYSTEM, run missed runs)
function Task([string]$name, [object[]]$trig, [string]$script, [string[]]$more) {
    $argLine = PsArgs $script $more
    $text = ($trig | ForEach-Object { $_.Text }) -join ','
    $plan = "Register-ScheduledTask -TaskName $name -User SYSTEM -RunLevel Highest -StartWhenAvailable -Trigger $text -Execute powershell.exe -Argument $argLine"
    Step $plan {
        $a = New-ScheduledTaskAction -Execute $Ps -Argument $argLine
        $pr = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $st = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Hours 2) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
        Register-ScheduledTask -TaskName $name -Action $a -Principal $pr -Settings $st -Trigger @($trig | ForEach-Object { & $_.Make }) -Force | Out-Null
    }
}
function Daily([string]$at) { @{ Text = "Daily@$at"; Make = { New-ScheduledTaskTrigger -Daily -At $at }.GetNewClosure() } }
if (-not $SkipTasks) {
    $bk = Join-Path $P.config 'backup.env'
    $s3 = Join-Path $P.deploy 'backup\backup-s3.ps1'
    $s3a = @('-EnvFile', $bk, '-PgBin', $PgBin, '-AwsExe', $AwsExe, '-StateDir', $P.state)
    Task "$Prefix-S3Backup" @(Daily '02:00') $s3 $s3a
    # 5 min after boot, so Postgres is up; the missed-02:00 case is also covered by StartWhenAvailable
    Task "$Prefix-S3Backup-Catchup" @(@{ Text = 'AtStartup+PT5M'; Make = { $t = New-ScheduledTaskTrigger -AtStartup; $t.Delay = 'PT5M'; $t } }) $s3 ($s3a + '-CatchUp')
    Task "$Prefix-LocalBackup" @(Daily '03:00') (Join-Path $P.deploy 'backup\Backup-Native.ps1') `
        @('-EnvFile', $bk, '-PgBin', $PgBin, '-OutDir', $P.backups, '-Label', 'scheduled', '-KeepDays', '30')
    if ($DailyReportTask) {
        Task "$Prefix-DailyReport" @(Daily '08:00') (Join-Path $P.deploy 'backend\run-flask.ps1') `
            @('-Root', $Root, '-EnvFile', (Join-Path $P.config 'scheduler.env'), '-Command', 'daily-report')
    }
}

# ---- 9. start (dependencies first)
foreach ($k in 'Postgres', 'Backend', 'Scheduler', 'Web') { Native 'sc.exe' @('start', $S[$k]) }
Write-Host "OK installed $Prefix-* under $Root (web :$WebPort, backend 127.0.0.1:$BackendPort, postgres 127.0.0.1:$PgPort)"
exit 0

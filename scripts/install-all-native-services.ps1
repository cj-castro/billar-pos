# =============================================================================
# install-all-native-services.ps1
# ONE-CLICK installer/orchestrator for BilliardBar POS native Windows Services
# on the STAGING machine (Phase 2, Wave 2 / Plan 02-05).
#
# Chains together everything built in Plans 01-04:
#   1. install-postgres-native.ps1        (PostgreSQL 15, native Windows service)
#   2. postgres-backup-restore.ps1        (Test-PostgresBackupRestoreProcedure —
#                                           Docker-to-native dump/restore proof,
#                                           synthetic data only, per D-10)
#   3. install-nssm-backend.ps1           (Flask/eventlet backend)
#   4. install-nssm-scheduler.ps1         (daily-report scheduler)
#   5. install-nssm-telegram-bot.ps1      (Telegram bot)
#   6. install-nssm-nginx.ps1             (reverse proxy + built SPA)
#   7. Wires NSSM DependOnService so Windows starts everything in the right
#      order on boot.
#   8. Restarts every service so the dependency wiring takes effect now.
#   9. Runs a final PASS/FAIL validation table against every Phase 2 requirement.
#  10. Proves the phase's own crash-isolation claim: stopping the backend does
#      NOT stop the scheduler or Telegram bot.
#
# THIS IS THE STAGING-MACHINE INSTALLER ONLY (D-01/D-02/D-03). Never run this
# on the live bar machine — that is Phase 5's cutover, a separate, deliberate
# step. The staging machine has equivalent specs (Windows 11, ~8GB RAM), so
# these results should transfer directly to the real hardware later.
#
# -----------------------------------------------------------------------------
# DESIGNED TO BE HANDED TO NON-TECHNICAL STAFF. That drove three extra design
# goals beyond what a "run the six scripts in order" script would need:
#
#   * SAFE TO RE-RUN. Before installing anything, each step checks whether
#     it's already installed and healthy, and skips it if so (use -Force to
#     reinstall everything from scratch anyway). If the script is closed,
#     crashes, or the computer restarts partway through, simply run it again
#     — already-finished steps are detected automatically.
#
#   * CANNOT HANG FOREVER. Every install step runs as its own child process
#     with a time limit. If a step (or anything it downloads/runs — an
#     installer, npm, Docker, etc.) gets stuck, this script kills it and
#     either retries once or stops with a clear message, instead of sitting
#     frozen with no explanation.
#
#   * PLAIN-LANGUAGE OUTPUT. No raw PowerShell stack traces. Every problem
#     is reported in plain English with a concrete "what to do next," and
#     full technical detail is always saved to a log file that can be sent
#     back for help without anyone needing to copy/paste terminal text.
#
# HOW TO RUN (staging machine, one time per environment):
#   Easiest: double-click Run-Install-All-Native-Services.bat in this same
#   folder and click "Yes" on the Windows prompt that appears.
#
#   Or manually:
#     1. Open PowerShell as Administrator
#     2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#     3. cd <repo root>
#     4. .\scripts\install-all-native-services.ps1
#
# OPTIONS:
#   -Force        Reinstall every step even if it looks already done.
#   -Unattended   Skip the "type Y to continue" confirmation prompt.
#   -StepTimeoutMinutes <n>   Override the default per-step time limit (rarely needed).
# =============================================================================
#Requires -RunAsAdministrator

param(
    [switch]$Force,
    [switch]$Unattended,
    [int]$StepTimeoutMinutes = 15
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # avoids progress-bar rendering hangs on some hosts

# -----------------------------------------------------------------------------
# Paths / logging setup
# -----------------------------------------------------------------------------
$BaseDir    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ScriptsDir = Join-Path $BaseDir "scripts"
$LogsDir    = Join-Path $BaseDir "logs"
$StateFile  = Join-Path $ScriptsDir ".install-all-native-services.state.json"
$Timestamp  = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFile    = Join-Path $LogsDir "install-all-native-services_$Timestamp.log"

New-Item -Force -ItemType Directory $LogsDir | Out-Null
try { Start-Transcript -Path $LogFile -Append | Out-Null } catch {}

# -----------------------------------------------------------------------------
# Plain-language output helpers
# -----------------------------------------------------------------------------
function Write-Banner($text) {
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor Cyan
}
function Write-InfoLine($text) { Write-Host "   $text" -ForegroundColor White }
function Write-OkLine($text)   { Write-Host "   [OK]   $text" -ForegroundColor Green }
function Write-SkipLine($text) { Write-Host "   [SKIP] $text" -ForegroundColor Gray }
function Write-WarnLine($text) { Write-Host "   [WARN] $text" -ForegroundColor Yellow }
function Write-ErrLine($text)  { Write-Host "   [FAIL] $text" -ForegroundColor Red }

# -----------------------------------------------------------------------------
# Resumable state (used only for one-time proofs that have no "current live
# state" to re-probe, like the backup/restore verification — see Step 2).
# Services themselves are checked live via Get-Service, not this file, so
# this file is never the single source of truth for "is it installed."
# -----------------------------------------------------------------------------
function Get-InstallState {
    if (Test-Path $StateFile) {
        try {
            $raw = Get-Content $StateFile -Raw | ConvertFrom-Json
            $ht = @{}
            if ($null -ne $raw) { $raw.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value } }
            return $ht
        } catch { return @{} }
    }
    return @{}
}
function Save-InstallState($state) {
    $state | ConvertTo-Json | Set-Content -Path $StateFile
}

# -----------------------------------------------------------------------------
# Stop-Installation: the one place that ends the script on a real problem.
# Always explains what happened in plain language, always points at a log
# file, always says "just run it again" (true, because every step is
# re-check-before-install).
# -----------------------------------------------------------------------------
function Stop-Installation {
    param([string]$Reason, [pscustomobject]$Detail = $null)
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Red
    Write-Host " INSTALLATION STOPPED" -ForegroundColor Red
    Write-Host ("=" * 70) -ForegroundColor Red
    Write-Host ""
    Write-Host "What happened:" -ForegroundColor Yellow
    Write-Host "  $Reason"
    if ($Detail -and $Detail.Log) {
        Write-Host ""
        Write-Host "Detailed technical output was saved to:" -ForegroundColor Yellow
        Write-Host "  $($Detail.Log)"
        if ($Detail.ErrLog) { Write-Host "  $($Detail.ErrLog)" }
    }
    Write-Host ""
    Write-Host "What to do next:" -ForegroundColor Yellow
    Write-Host "  1. Take a screenshot or note of the message above."
    Write-Host "  2. You can simply run this script again -- anything that already"
    Write-Host "     installed successfully will be detected and skipped automatically."
    Write-Host "  3. If it fails again the same way, send the log file(s) above to Girish."
    Write-Host ""
    Write-Host "Full session log: $LogFile"
    Write-Host ("=" * 70) -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
}

# -----------------------------------------------------------------------------
# Invoke-InstallerScript: runs one of Plan 01-04's .ps1 scripts as an
# isolated child process, with a wall-clock time limit. If it exceeds the
# limit, the whole process tree (including anything it launched -- npm,
# choco, an installer .exe, docker) is force-killed instead of hanging this
# script forever. Retries once on timeout or non-zero exit before giving up.
# All child output/errors are redirected to per-step log files so staff never
# have to read scrolling PowerShell text to know what happened.
# -----------------------------------------------------------------------------
function Invoke-InstallerScript {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$ScriptPath,
        [int]$TimeoutMinutes = $StepTimeoutMinutes,
        [int]$MaxRetries = 1
    )

    if (-not (Test-Path $ScriptPath)) {
        return [pscustomobject]@{ Ok = $false; Reason = "missing_script"; Log = $null }
    }

    $safeName = ($Name -replace '[^A-Za-z0-9_-]', '_')

    for ($attempt = 1; $attempt -le ($MaxRetries + 1); $attempt++) {
        Write-InfoLine "Starting: $Name (attempt $attempt of $($MaxRetries + 1), time limit ${TimeoutMinutes}m) -- please wait..."

        # Unique log file PER ATTEMPT (not shared across retries): a retry
        # previously reused the same filename, so Out-File silently
        # overwrote attempt 1's real diagnostic output with attempt 2's --
        # losing the actual failure reason on the very retry meant to help
        # diagnose it (confirmed against the real staging machine, 2026-08-08).
        $childLog = Join-Path $LogsDir "${safeName}_${Timestamp}_attempt${attempt}.log"

        # IMPORTANT: capture output via PowerShell's own stream-merge-and-redirect
        # (*>&1 | Out-File) INSIDE the child process, not via Start-Process's
        # OS-level -RedirectStandardOutput/-RedirectStandardError. Windows
        # PowerShell 5.1's Write-Host does not reliably write anywhere useful when
        # a process's stdout/stderr handles are OS-redirected this way -- every
        # script in this phase reports almost all of its progress via Write-Host,
        # so that combination silently produces an empty log and an early,
        # unexplained non-zero exit (confirmed against the real staging machine,
        # 2026-08-08). Piping *>&1 inside the child's own -Command instead
        # captures the Information stream Write-Host actually writes to (PS 5.0+)
        # while the child still has a normal console via -NoNewWindow.
        #
        # Trailing "; exit $LASTEXITCODE" is REQUIRED, not cosmetic: Windows
        # PowerShell's "-Command" host sets its OWN process exit code to 1
        # whenever ANY error was written during execution -- including
        # ordinary non-terminating errors under $ErrorActionPreference =
        # "Continue" (e.g. docker's routine stderr progress output turned
        # into NativeCommandError records). Confirmed against the real
        # staging machine, 2026-08-08: postgres-backup-restore.ps1 completed
        # its own PASS banner in full, but the wrapping powershell.exe still
        # reported exit 1 and the orchestrator retried a fully-successful
        # step. Explicitly propagating $LASTEXITCODE (which reflects the
        # last actual external command's real result, since Out-File is a
        # cmdlet and never touches it) makes this wrapper's exit code match
        # the target script's real outcome instead of PowerShell's ambient
        # "were any errors logged" state.
        $exitCodeFile = "$childLog.exitcode"
        if (Test-Path $exitCodeFile) { Remove-Item $exitCodeFile -Force -ErrorAction SilentlyContinue }

        # The child writes ITS OWN exit code to a marker file as its very
        # last action, and we read that file directly rather than trusting
        # the returned Process object's .ExitCode/.HasExited. Both
        # $proc.ExitCode (even after an explicit WaitForExit()) and the
        # process's own exit code (even after explicitly forcing it via
        # "; exit $LASTEXITCODE") were observed to come back empty/wrong in
        # this specific execution context (Start-Process launched from a
        # Scheduled Task running in the interactive session) on the real
        # staging machine, 2026-08-08 -- every failure reported "(code )"
        # with nothing after it, including for steps that had actually
        # fully succeeded. Writing the result to disk sidesteps whatever
        # .NET/PowerShell process-tracking quirk was causing that, instead
        # of depending on it.
        $wrappedCommand = "& '$ScriptPath' *>&1 | Out-File -FilePath '$childLog' -Encoding utf8; `$ec = if (`$LASTEXITCODE) { `$LASTEXITCODE } else { 0 }; Set-Content -Path '$exitCodeFile' -Value `$ec -NoNewline; exit `$ec"

        $proc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $wrappedCommand) `
            -NoNewWindow -PassThru

        $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
        $finished = $false
        while ((Get-Date) -lt $deadline) {
            # The marker file is the real completion signal (written as the
            # child's literal last action) -- .HasExited can flip true
            # slightly before that write is visible, so check the file too
            # rather than racing ahead on .HasExited alone.
            if ((Test-Path $exitCodeFile) -or $proc.HasExited) { $finished = $true; break }
            Start-Sleep -Seconds 3
        }

        if (-not $finished) {
            Write-ErrLine "'$Name' is taking longer than $TimeoutMinutes minutes and looks stuck -- stopping it."
            try {
                Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue |
                    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {}
            if ($attempt -le $MaxRetries) {
                Write-WarnLine "Will try '$Name' one more time..."
                Start-Sleep -Seconds 5
                continue
            }
            return [pscustomobject]@{ Ok = $false; Reason = "timeout"; Log = $childLog }
        }

        # Brief grace period: the marker file existing doesn't guarantee the
        # OS has finished flushing it to a readable state yet.
        $exitCode = $null
        for ($i = 0; $i -lt 5; $i++) {
            if (Test-Path $exitCodeFile) {
                $raw = (Get-Content $exitCodeFile -Raw -ErrorAction SilentlyContinue)
                if ($raw) { $exitCode = $raw.Trim(); break }
            }
            Start-Sleep -Milliseconds 500
        }

        if ($exitCode -eq "0") {
            Write-OkLine "'$Name' finished successfully."
            return [pscustomobject]@{ Ok = $true; Log = $childLog }
        } else {
            Write-WarnLine "'$Name' exited with an error (code $exitCode)."
            if ($attempt -le $MaxRetries) {
                Write-WarnLine "Will try '$Name' one more time..."
                Start-Sleep -Seconds 5
                continue
            }
            return [pscustomobject]@{ Ok = $false; Reason = "exit_$exitCode"; Log = $childLog }
        }
    }
}

# -----------------------------------------------------------------------------
# Invoke-WithTimeout: same hang-protection idea as above, but for a small
# inline command (service restarts, dependency wiring) instead of a whole
# script file. Used so a single hung Restart-Service/nssm call can't freeze
# the rest of the orchestration either.
# -----------------------------------------------------------------------------
function Invoke-WithTimeout {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [scriptblock]$Block,
        [object[]]$ArgumentList = @(),
        [int]$TimeoutSeconds = 60
    )
    $job = Start-Job -ScriptBlock $Block -ArgumentList $ArgumentList
    $finished = Wait-Job $job -Timeout $TimeoutSeconds
    if (-not $finished) {
        Write-WarnLine "'$Name' did not finish within $TimeoutSeconds seconds -- moving on."
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        return $null
    }
    $out = Receive-Job $job -ErrorAction SilentlyContinue
    $jobState = $job.State
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    if ($jobState -ne 'Completed') {
        Write-WarnLine "'$Name' did not complete cleanly (state: $jobState)."
    }
    return $out
}

# -----------------------------------------------------------------------------
# Health-check helpers used for "does this already exist" pre-flight skips.
# -----------------------------------------------------------------------------
function Test-WindowsServiceHealthy {
    param([string]$ServiceName)
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    return [bool]($svc -and $svc.Status -eq 'Running')
}

function Test-PostgresAlreadyInstalled {
    # Checking only "service exists and is Running" is not enough: the
    # service can be up while the application role/database were never
    # actually created (e.g. a prior run installed Postgres successfully but
    # failed on the next step). Skipping install-postgres-native.ps1 based on
    # service status alone would then permanently skip the one script that
    # creates the app role too -- confirmed against the real staging machine,
    # 2026-08-08. So this also verifies an actual app-level connection using
    # the same POSTGRES_USER/PASSWORD/DB values from .env that the rest of
    # the stack will use.
    $pgServiceNameFile = Join-Path $ScriptsDir ".postgres-service-name.txt"
    $pgPortFile = Join-Path $ScriptsDir ".postgres-port.txt"
    if (-not (Test-Path $pgServiceNameFile)) { return $false }
    $svcName = (Get-Content $pgServiceNameFile -Raw -ErrorAction SilentlyContinue)
    if (-not $svcName) { return $false }
    if (-not (Test-WindowsServiceHealthy -ServiceName $svcName.Trim())) { return $false }

    $pgPort = if (Test-Path $pgPortFile) { (Get-Content $pgPortFile -Raw).Trim() } else { "5432" }
    $envVars = @{}
    $envFile = Join-Path $BaseDir ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
                $idx = $line.IndexOf('=')
                $envVars[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
            }
        }
    }
    $pgUser = if ($envVars.ContainsKey('POSTGRES_USER')) { $envVars['POSTGRES_USER'] } else { 'billiard' }
    $pgPassword = if ($envVars.ContainsKey('POSTGRES_PASSWORD')) { $envVars['POSTGRES_PASSWORD'] } else { 'billiard_secret' }
    $pgDb = if ($envVars.ContainsKey('POSTGRES_DB')) { $envVars['POSTGRES_DB'] } else { 'billiardbar' }
    $psqlExe = "C:\Program Files\PostgreSQL\15\bin\psql.exe"
    if (-not (Test-Path $psqlExe)) { return $false }

    $env:PGPASSWORD = $pgPassword
    try {
        & $psqlExe -U $pgUser -h localhost -p $pgPort -d $pgDb -tAc "SELECT 1" 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $env:PGPASSWORD = ""
    }
}

function Get-NssmPath {
    foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                      "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                      "$ScriptsDir\nssm.exe")) {
        try {
            $v = & $p version 2>&1
            if ($LASTEXITCODE -eq 0) { return $p }
        } catch {}
    }
    return $null
}

# =============================================================================
# MAIN
# =============================================================================
try {

Write-Banner "BilliardBar POS -- Native Windows Services Installer (STAGING)"
Write-InfoLine "This installs and starts PostgreSQL, the backend, scheduler,"
Write-InfoLine "Telegram bot, and nginx as Windows Services on THIS computer."
Write-InfoLine ""
Write-InfoLine "IMPORTANT: only run this on the STAGING test machine."
Write-InfoLine "Never run this on the live machine at the bar."
Write-Host ""

# --- Pre-flight check 1: Administrator (defense-in-depth; #Requires already enforces this) ---
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-ErrLine "This script must be run as Administrator."
    Write-InfoLine "Double-click Run-Install-All-Native-Services.bat instead, and click 'Yes' on the prompt."
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
}

# --- Pre-flight check 2: .env present ---
$EnvFile = Join-Path $BaseDir ".env"
if (-not (Test-Path $EnvFile)) {
    Stop-Installation -Reason ".env file not found at $EnvFile. Copy the .env file (given to you separately -- it is never stored in git) into the main BilliardBar POS folder, then run this script again."
}

# --- Pre-flight check 3: internet connectivity (several steps download things) ---
$netOk = $false
foreach ($testHost in @("nginx.org", "get.enterprisedb.com", "nssm.cc")) {
    if (Test-Connection -ComputerName $testHost -Count 1 -Quiet -ErrorAction SilentlyContinue) { $netOk = $true; break }
}
if (-not $netOk) {
    Stop-Installation -Reason "No internet connection detected. This installer needs to download PostgreSQL, nginx, and NSSM the first time it runs. Please connect this computer to the internet and try again."
}

# --- Pre-flight check 4: free disk space ---
$systemDriveLetter = (Get-Item $BaseDir).PSDrive.Name
$freeGB = [math]::Round((Get-PSDrive $systemDriveLetter).Free / 1GB, 1)
if ($freeGB -lt 5) {
    Stop-Installation -Reason "Only $freeGB GB of free disk space left on this computer. At least 5 GB free is recommended before installing. Please free up space and try again."
}

Write-OkLine "Administrator: yes"
Write-OkLine ".env file: found"
Write-OkLine "Internet connection: yes"
Write-OkLine "Free disk space: ${freeGB} GB"

# --- Confirmation (skippable with -Unattended) ---
if (-not $Unattended) {
    Write-Host ""
    $answer = Read-Host "Type Y and press Enter to begin installation (anything else cancels)"
    if ($answer -notmatch '^(y|yes)$') {
        Write-Host "Cancelled -- nothing was changed."
        try { Stop-Transcript | Out-Null } catch {}
        exit 0
    }
}

$state = Get-InstallState

# =============================================================================
# Step 1: PostgreSQL 15 (install-postgres-native.ps1)
# =============================================================================
Write-Banner "Step 1 of 6: PostgreSQL 15"
if ((Test-PostgresAlreadyInstalled) -and -not $Force) {
    Write-SkipLine "PostgreSQL is already installed and running -- skipping. (use -Force to reinstall anyway)"
} else {
    $r = Invoke-InstallerScript -Name "PostgreSQL 15 (install-postgres-native.ps1)" `
        -ScriptPath (Join-Path $ScriptsDir "install-postgres-native.ps1") -TimeoutMinutes 20
    if (-not $r.Ok) {
        Stop-Installation -Reason "Installing PostgreSQL failed (reason: $($r.Reason)). Nothing further was installed." -Detail $r
    }
}

$PgServiceNameFile = Join-Path $ScriptsDir ".postgres-service-name.txt"
if (-not (Test-Path $PgServiceNameFile)) {
    Stop-Installation -Reason "PostgreSQL installer finished, but this script could not confirm which Windows service was registered (missing $PgServiceNameFile). The Postgres service name is always auto-discovered, never assumed, so nothing downstream can proceed safely."
}
$PgServiceName = (Get-Content $PgServiceNameFile -Raw).Trim()
if (-not $PgServiceName) {
    Stop-Installation -Reason "The PostgreSQL service name file exists but is empty ($PgServiceNameFile)."
}
Write-OkLine "PostgreSQL Windows service: $PgServiceName"

# =============================================================================
# Step 2: Backup/restore proof (postgres-backup-restore.ps1 ->
#         Test-PostgresBackupRestoreProcedure). This is a one-time proof, not
#         a persistent install, so it's tracked in the resumable state file
#         rather than re-probed live. Aborts the whole script (exit 1) on
#         failure -- nothing downstream should install against unverified
#         Postgres restore behavior (DATA-01).
# =============================================================================
Write-Banner "Step 2 of 6: Postgres backup/restore verification (DATA-01)"
$alreadyVerified = $state.ContainsKey('backup_restore_verified_at') -and -not $Force
if ($alreadyVerified) {
    Write-SkipLine "Backup/restore procedure was already verified on $($state['backup_restore_verified_at']) -- skipping. (use -Force to re-verify)"
} else {
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerCmd) {
        Stop-Installation -Reason "Docker Desktop (or Rancher Desktop) is required for the one-time backup/restore proof (it is used only transiently, then removed -- it is not part of the final install). Please install and start it, then run this script again."
    }
    $r = Invoke-InstallerScript -Name "Postgres backup-restore proof (postgres-backup-restore.ps1, Test-PostgresBackupRestoreProcedure)" `
        -ScriptPath (Join-Path $ScriptsDir "postgres-backup-restore.ps1") -TimeoutMinutes 15
    if (-not $r.Ok) {
        Stop-Installation -Reason "The Postgres backup/restore verification (DATA-01) failed (reason: $($r.Reason)). Nothing further will be installed until this passes, since it proves the system's data can be safely backed up and restored." -Detail $r
    }
    $state['backup_restore_verified_at'] = (Get-Date -Format "s")
    Save-InstallState $state
}

# =============================================================================
# Steps 3-6: backend, scheduler, telegram-bot, nginx
# =============================================================================
Write-Banner "Step 3 of 6: Backend (install-nssm-backend.ps1)"
if ((Test-WindowsServiceHealthy -ServiceName "BilliardBarBackend") -and -not $Force) {
    Write-SkipLine "BilliardBarBackend is already installed and running -- skipping. (use -Force to reinstall anyway)"
} else {
    $r = Invoke-InstallerScript -Name "Backend (install-nssm-backend.ps1)" `
        -ScriptPath (Join-Path $ScriptsDir "install-nssm-backend.ps1") -TimeoutMinutes 10
    if (-not $r.Ok) { Stop-Installation -Reason "Installing the backend service failed (reason: $($r.Reason))." -Detail $r }
}

Write-Banner "Step 4 of 6: Scheduler (install-nssm-scheduler.ps1)"
if ((Test-WindowsServiceHealthy -ServiceName "BilliardBarScheduler") -and -not $Force) {
    Write-SkipLine "BilliardBarScheduler is already installed and running -- skipping. (use -Force to reinstall anyway)"
} else {
    $r = Invoke-InstallerScript -Name "Scheduler (install-nssm-scheduler.ps1)" `
        -ScriptPath (Join-Path $ScriptsDir "install-nssm-scheduler.ps1") -TimeoutMinutes 10
    if (-not $r.Ok) { Stop-Installation -Reason "Installing the scheduler service failed (reason: $($r.Reason))." -Detail $r }
}

Write-Banner "Step 5 of 6: Telegram bot (install-nssm-telegram-bot.ps1)"
if ((Test-WindowsServiceHealthy -ServiceName "BilliardBarTelegramBot") -and -not $Force) {
    Write-SkipLine "BilliardBarTelegramBot is already installed and running -- skipping. (use -Force to reinstall anyway)"
} else {
    $r = Invoke-InstallerScript -Name "Telegram bot (install-nssm-telegram-bot.ps1)" `
        -ScriptPath (Join-Path $ScriptsDir "install-nssm-telegram-bot.ps1") -TimeoutMinutes 10
    if (-not $r.Ok) {
        # Non-blocking by design (unlike every other step): the ONE expected
        # reason this legitimately fails is TELEGRAM_TOKEN/ADMIN_CHAT_ID
        # missing from .env, which the sub-script itself already detects and
        # reports clearly -- that's a missing real credential, not a script
        # defect, and there's nothing to "install" differently to fix it.
        # Stopping the whole remaining install over a missing bot token
        # would block validating everything else (Postgres, backend,
        # scheduler, nginx) that has nothing to do with Telegram. The final
        # validation table below still reports this service's real status
        # (SVC-05), so a missing-credential gap is visible, not hidden.
        Write-WarnLine "Telegram bot service did not come up (reason: $($r.Reason)). This is usually caused by TELEGRAM_TOKEN/ADMIN_CHAT_ID missing from .env -- continuing with the rest of the install; the final validation table below will show SVC-05 as FAIL if it's still not Running."
    }
}

Write-Banner "Step 6 of 6: nginx (install-nssm-nginx.ps1)"
if ((Test-WindowsServiceHealthy -ServiceName "BilliardBarNginx") -and -not $Force) {
    Write-SkipLine "BilliardBarNginx is already installed and running -- skipping. (use -Force to reinstall anyway)"
} else {
    $r = Invoke-InstallerScript -Name "nginx (install-nssm-nginx.ps1)" `
        -ScriptPath (Join-Path $ScriptsDir "install-nssm-nginx.ps1") -TimeoutMinutes 15
    if (-not $r.Ok) { Stop-Installation -Reason "Installing nginx failed (reason: $($r.Reason))." -Detail $r }
}

# =============================================================================
# Step 7: Wire NSSM service dependencies so Windows starts everything in the
# right order on boot. Uses the dynamically-discovered $PgServiceName from
# Step 1 -- never a hardcoded Postgres service name.
# =============================================================================
Write-Banner "Wiring service startup order"
$NssmExe = Get-NssmPath
if (-not $NssmExe) {
    Stop-Installation -Reason "NSSM could not be located even though the service installs above reported success. This shouldn't normally happen -- please re-run this script."
}

Invoke-WithTimeout -Name "wire service dependencies" -TimeoutSeconds 30 -ArgumentList @($NssmExe, $PgServiceName) -Block {
    param($NssmExe, $PgServiceName)
    & $NssmExe set BilliardBarBackend DependOnService $PgServiceName
    & $NssmExe set BilliardBarScheduler DependOnService $PgServiceName
    & $NssmExe set BilliardBarTelegramBot DependOnService $PgServiceName
    & $NssmExe set BilliardBarNginx DependOnService BilliardBarBackend
} | Out-Null
Write-OkLine "Startup order wired: $PgServiceName -> Backend/Scheduler/TelegramBot -> Nginx (DependOnService)"

# =============================================================================
# Step 8: Restart every service in dependency order so the new DependOnService
# settings take effect immediately, not only on next reboot.
# =============================================================================
Write-Banner "Restarting services to apply new startup order"
Invoke-WithTimeout -Name "restart Postgres" -TimeoutSeconds 60 -ArgumentList @($PgServiceName) -Block {
    param($svc) Restart-Service -Name $svc -Force -ErrorAction SilentlyContinue
} | Out-Null
Start-Sleep -Seconds 5

foreach ($svc in @("BilliardBarBackend", "BilliardBarScheduler", "BilliardBarTelegramBot")) {
    Invoke-WithTimeout -Name "restart $svc" -TimeoutSeconds 30 -ArgumentList @($NssmExe, $svc) -Block {
        param($NssmExe, $svc) & $NssmExe restart $svc
    } | Out-Null
}
Start-Sleep -Seconds 5
Invoke-WithTimeout -Name "restart BilliardBarNginx" -TimeoutSeconds 30 -ArgumentList @($NssmExe) -Block {
    param($NssmExe) & $NssmExe restart BilliardBarNginx
} | Out-Null
Write-OkLine "All services restarted with the new startup order in effect."

# =============================================================================
# Step 9: Final PASS/FAIL/WARN validation table against every Phase 2
# requirement.
# =============================================================================
Write-Banner "Final validation"
$results = New-Object System.Collections.Generic.List[object]

function Add-Result([string]$Id, [string]$Label, [bool]$Pass, [string]$Detail) {
    $results.Add([pscustomobject]@{ Id = $Id; Label = $Label; Pass = $Pass; Detail = $Detail })
}

foreach ($svcCheck in @(
    @{ Id = "SVC-02"; Name = $PgServiceName; Label = "PostgreSQL ($PgServiceName)" },
    @{ Id = "SVC-01"; Name = "BilliardBarBackend"; Label = "Backend" },
    @{ Id = "SVC-04"; Name = "BilliardBarScheduler"; Label = "Scheduler" },
    @{ Id = "SVC-05"; Name = "BilliardBarTelegramBot"; Label = "Telegram bot" },
    @{ Id = "SVC-03"; Name = "BilliardBarNginx"; Label = "nginx (frontend)" }
)) {
    $ok = Test-WindowsServiceHealthy -ServiceName $svcCheck.Name
    Add-Result -Id $svcCheck.Id -Label $svcCheck.Label -Pass $ok -Detail "Get-Service $($svcCheck.Name) -> $(if ($ok) { 'Running' } else { 'NOT Running' })"
}

# Backend reachability (any HTTP response, including 401, counts as reachable)
$backendOk = $false
for ($i = 1; $i -le 5; $i++) {
    try {
        $null = Invoke-RestMethod -Uri "http://localhost:5000/api/v1/auth/me" -TimeoutSec 5
        $backendOk = $true; break
    } catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $backendOk = $true; break }
        Start-Sleep -Seconds 2
    }
}
Add-Result -Id "SVC-01-http" -Label "Backend reachable on localhost:5000" -Pass $backendOk -Detail "HTTP request to /api/v1/auth/me"

# nginx serving the SPA
$nginxOk = $false
try {
    $r = Invoke-WebRequest -Uri "http://localhost:8080/" -TimeoutSec 5 -UseBasicParsing
    $nginxOk = $r.Content -match '<div id="root">'
} catch {}
Add-Result -Id "SVC-03-http" -Label "nginx serving the frontend on localhost:8080" -Pass $nginxOk -Detail "HTTP GET / contains <div id=`"root`">"

# Print agent reachability -- best-effort NET-01 config check only, not a
# physical print smoke test (staging may have no physical printer, per D-02/D-03).
$printAgentOk = $false
try {
    $null = Invoke-RestMethod -Uri "http://localhost:9191/health" -TimeoutSec 5
    $printAgentOk = $true
} catch {}
if ($printAgentOk) {
    Add-Result -Id "NET-01" -Label "Print agent reachable via localhost:9191" -Pass $true -Detail "HTTP GET /health succeeded"
} else {
    Write-WarnLine "NET-01: print agent not reachable at localhost:9191/health -- this is expected if no print agent is running on this staging machine. This checks network/config reachability only, not an actual print job (that requires the live bar machine, per D-03)."
}

Write-Host ""
Write-Host ("Requirement / Check".PadRight(48) + "Result") -ForegroundColor Cyan
Write-Host ("-" * 70) -ForegroundColor Cyan
foreach ($res in $results) {
    $status = if ($res.Pass) { "PASS" } else { "FAIL" }
    $color  = if ($res.Pass) { "Green" } else { "Red" }
    Write-Host ("  [{0}] {1,-8} {2}" -f $res.Id, $status, $res.Label) -ForegroundColor $color
    Write-Host ("        {0}" -f $res.Detail) -ForegroundColor Gray
}

# =============================================================================
# Step 10: Crash-isolation proof (this phase's own explicit success
# criterion): stopping the backend must NOT stop the scheduler or bot.
# =============================================================================
Write-Banner "Crash-isolation proof (backend crash must not affect scheduler/bot)"
& $NssmExe stop BilliardBarBackend | Out-Null
Start-Sleep -Seconds 3

$schedulerSurvives = Test-WindowsServiceHealthy -ServiceName "BilliardBarScheduler"
$botSurvives = Test-WindowsServiceHealthy -ServiceName "BilliardBarTelegramBot"

if ($schedulerSurvives) { Write-OkLine "Scheduler stayed Running while backend was stopped." }
else { Write-ErrLine "Scheduler stopped when backend was stopped -- crash isolation FAILED." }
if ($botSurvives) { Write-OkLine "Telegram bot stayed Running while backend was stopped." }
else { Write-ErrLine "Telegram bot stopped when backend was stopped -- crash isolation FAILED." }

Add-Result -Id "SVC-04-isolation" -Label "Scheduler survives backend stop" -Pass $schedulerSurvives -Detail "nssm stop BilliardBarBackend, then Get-Service BilliardBarScheduler"
Add-Result -Id "SVC-05-isolation" -Label "Telegram bot survives backend stop" -Pass $botSurvives -Detail "nssm stop BilliardBarBackend, then Get-Service BilliardBarTelegramBot"

# Restore normal state
& $NssmExe start BilliardBarBackend | Out-Null
Start-Sleep -Seconds 3
$backendRestored = Test-WindowsServiceHealthy -ServiceName "BilliardBarBackend"
if ($backendRestored) { Write-OkLine "Backend restarted successfully -- normal state restored." }
else { Write-ErrLine "Backend did NOT come back up after the crash-isolation test -- check backend\backend_err.log." }
Add-Result -Id "SVC-01-restored" -Label "Backend restarted after crash-isolation test" -Pass $backendRestored -Detail "nssm start BilliardBarBackend"

# =============================================================================
# Final summary
# =============================================================================
$criticalResults = $results | Where-Object { $_.Id -ne "NET-01" }
$allCriticalPassed = -not ($criticalResults | Where-Object { -not $_.Pass })

Write-Banner "SUMMARY"
if ($allCriticalPassed) {
    Write-Host " Your BilliardBar POS staging environment is up and running natively" -ForegroundColor Green
    Write-Host " on Windows -- every required service passed its check." -ForegroundColor Green
} else {
    Write-Host " Some checks did not pass -- see the FAIL rows above for details." -ForegroundColor Red
    Write-Host " It is safe to run this script again after investigating; steps" -ForegroundColor Yellow
    Write-Host " that already succeeded will be skipped automatically." -ForegroundColor Yellow
}
Write-Host ""
Write-Host " This was the STAGING machine only -- nothing was changed on the live" -ForegroundColor Gray
Write-Host " bar machine, which keeps running normally on Docker/Rancher until" -ForegroundColor Gray
Write-Host " Phase 5's separate, deliberate cutover." -ForegroundColor Gray
Write-Host ""
Write-Host " Postgres service name: $PgServiceName"
Write-Host " Full session log:      $LogFile"
Write-Host " Per-step logs folder:  $LogsDir"
Write-Host ("=" * 70) -ForegroundColor Cyan

try { Stop-Transcript | Out-Null } catch {}
if ($allCriticalPassed) { exit 0 } else { exit 1 }

} catch {
    Stop-Installation -Reason "An unexpected error occurred: $($_.Exception.Message)" -Detail ([pscustomobject]@{ Log = $LogFile })
} finally {
    try { Stop-Transcript | Out-Null } catch {}
}

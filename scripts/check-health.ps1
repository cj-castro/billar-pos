# =============================================================================
# check-health.ps1
# Unified "is the POS up" health-check rollup (D-03, SUP-04).
#
# Replaces six scattered, inconsistent checks (previously spread across
# install-all-native-services.ps1's one-time install-verification step and
# various runbook notes) with a single command an operator can run any time,
# on either the staging machine or the live bar machine, to get one clear
# PASS/FAIL/WARN table covering every native-Windows-Service (Phase 2)
# component.
#
# Checks, in order:
#   1. Get-Service status for all 6 native services: PostgreSQL (dynamically
#      discovered -- never a hardcoded literal name, see D-02/D-03),
#      BilliardBarBackend, BilliardBarScheduler, BilliardBarTelegramBot,
#      BilliardBarNginx, BilliardBarPrintAgent.
#      Per D-02: scheduler and telegram-bot have no HTTP listener
#      (BlockingScheduler has no port) -- Get-Service Running is the accepted
#      responsiveness signal for them, not a fake HTTP heartbeat.
#   2. Backend /api/v1/health -- must be PARSED, not just HTTP 200: PASS only
#      when the JSON body's .status -eq 'ok' AND .db -eq 'connected'. An
#      HTTP 503 (backend up but DB unreachable) is caught and reported using
#      the response body's .detail field where available (see 04-RESEARCH.md
#      "Example 2: Deepened Health-Check Endpoint").
#   3. nginx serving the SPA -- HTTP GET / contains <div id="root">.
#   4. Print agent /health -- WARN-ONLY per D-13 (warn-and-continue, never
#      block/fail for a live bar; matches Phase 3's D-11 philosophy). The
#      print agent normally runs on the physical POS host machine outside
#      this native-services install, so it being absent/unreachable on
#      staging (or briefly on the bar machine) is expected, not a failure.
#      The print agent's own Get-Service row (step 1) is treated the same
#      way for the identical reason -- neither counts toward the overall
#      exit code, mirroring install-all-native-services.ps1's existing
#      NET-01 precedent (lines 632-642) exactly.
#
# USAGE (zero required parameters):
#   powershell -File scripts\check-health.ps1
#
# EXIT CODE: 0 if every non-print-agent check passed, 1 otherwise.
# =============================================================================

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# -----------------------------------------------------------------------------
# Plain-language output helpers -- same color-coded style as
# install-all-native-services.ps1 (lines 90-100), reused here rather than
# reinvented since this script has no shared PowerShell module to dot-source
# from.
# -----------------------------------------------------------------------------
function Write-Banner($text) {
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor Cyan
}
function Write-InfoLine($text) { Write-Host "   $text" -ForegroundColor White }
function Write-OkLine($text)   { Write-Host "   [OK]   $text" -ForegroundColor Green }
function Write-WarnLine($text) { Write-Host "   [WARN] $text" -ForegroundColor Yellow }
function Write-ErrLine($text)  { Write-Host "   [FAIL] $text" -ForegroundColor Red }

# -----------------------------------------------------------------------------
# Test-WindowsServiceHealthy -- identical semantics to
# install-all-native-services.ps1's helper of the same name (line 323-327):
# only "Get-Service status -eq Running" counts as healthy.
# -----------------------------------------------------------------------------
function Test-WindowsServiceHealthy {
    param([string]$ServiceName)
    if (-not $ServiceName) { return $false }
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    return [bool]($svc -and $svc.Status -eq 'Running')
}

Write-Banner "BilliardBar POS -- Unified Health Check (SUP-04, D-03)"

# -----------------------------------------------------------------------------
# Result table, same Id/Label/Pass/Detail shape + PadRight table-print pattern
# as install-all-native-services.ps1's Add-Result (lines 596-653). Extended
# with a Critical flag: non-critical rows (the print agent) are shown in the
# table for visibility but deliberately excluded from the overall PASS/FAIL
# exit-code decision, per D-13.
# -----------------------------------------------------------------------------
$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$Id, [string]$Label, [bool]$Pass, [string]$Detail, [bool]$Critical = $true) {
    $results.Add([pscustomobject]@{ Id = $Id; Label = $Label; Pass = $Pass; Detail = $Detail; Critical = $Critical })
}

# =============================================================================
# Check 1: Windows service status (Get-Service) for all 6 native services.
# =============================================================================
Write-InfoLine "Checking Windows service status..."

# Postgres service name is always dynamically discovered from the file
# install-postgres-native.ps1 writes -- NEVER a hardcoded literal, since the
# actual name varies by installer version/vendor (e.g. postgresql-x64-15).
$PgServiceNameFile = Join-Path $ScriptsDir ".postgres-service-name.txt"
$PgServiceName = $null
if (Test-Path $PgServiceNameFile) {
    $PgServiceName = (Get-Content $PgServiceNameFile -Raw -ErrorAction SilentlyContinue)
    if ($PgServiceName) { $PgServiceName = $PgServiceName.Trim() }
}

if ($PgServiceName) {
    $pgOk = Test-WindowsServiceHealthy -ServiceName $PgServiceName
    Add-Result -Id "SVC-02" -Label "PostgreSQL ($PgServiceName)" -Pass $pgOk `
        -Detail "Get-Service $PgServiceName -> $(if ($pgOk) { 'Running' } else { 'NOT Running' })"
} else {
    Add-Result -Id "SVC-02" -Label "PostgreSQL (service name unknown)" -Pass $false `
        -Detail "Could not read $PgServiceNameFile -- run install-postgres-native.ps1 first"
}

foreach ($svcCheck in @(
    @{ Id = "SVC-01"; Name = "BilliardBarBackend";     Label = "Backend" }
    @{ Id = "SVC-04"; Name = "BilliardBarScheduler";   Label = "Scheduler" }
    @{ Id = "SVC-05"; Name = "BilliardBarTelegramBot"; Label = "Telegram bot" }
    @{ Id = "SVC-03"; Name = "BilliardBarNginx";       Label = "nginx (frontend)" }
)) {
    $ok = Test-WindowsServiceHealthy -ServiceName $svcCheck.Name
    Add-Result -Id $svcCheck.Id -Label $svcCheck.Label -Pass $ok `
        -Detail "Get-Service $($svcCheck.Name) -> $(if ($ok) { 'Running' } else { 'NOT Running' })"
}

# Print agent's own Get-Service row: non-critical, per D-13 -- the print
# agent normally runs on the physical POS host machine, not on staging (it
# is deliberately absent from install-all-native-services.ps1's own install
# chain), so it not being installed/Running here is expected, not a failure.
$printAgentSvcOk = Test-WindowsServiceHealthy -ServiceName "BilliardBarPrintAgent"
Add-Result -Id "NET-02" -Label "Print agent service (BilliardBarPrintAgent)" -Pass $printAgentSvcOk `
    -Detail "Get-Service BilliardBarPrintAgent -> $(if ($printAgentSvcOk) { 'Running' } else { 'NOT Running' })" `
    -Critical $false
if (-not $printAgentSvcOk) {
    Write-WarnLine "NET-02: print agent service not Running/installed -- this is expected on any machine other than the physical POS host (staging and the live bar's backend host do not run it)."
}

# =============================================================================
# Check 2: Backend /api/v1/health -- parsed .status/.db fields, not a bare
# HTTP-200-only check. Must correctly handle the deepened endpoint's HTTP 503
# on DB failure (see 04-RESEARCH.md "Example 2: Deepened Health-Check
# Endpoint").
# =============================================================================
Write-InfoLine "Checking backend /api/v1/health..."

$backendOk = $false
$backendDetail = $null
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:5000/api/v1/health" -TimeoutSec 5
    $backendOk = ($resp.status -eq 'ok') -and ($resp.db -eq 'connected')
    $backendDetail = "status=$($resp.status) db=$($resp.db)"
} catch {
    # A non-2xx response (e.g. HTTP 503 when the DB is unreachable) makes
    # Invoke-RestMethod throw in Windows PowerShell 5.1 -- read the response
    # body directly off the exception to recover the .detail field instead of
    # only reporting the generic HTTP exception message.
    $errDetail = $null
    if ($_.Exception.Response) {
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $body = $reader.ReadToEnd()
            $parsed = $body | ConvertFrom-Json -ErrorAction SilentlyContinue
            if ($parsed -and $parsed.detail) { $errDetail = $parsed.detail }
        } catch {}
    }
    $backendDetail = if ($errDetail) { $errDetail } else { $_.Exception.Message }
}
Add-Result -Id "SUP-04-health" -Label "Backend /api/v1/health (status='ok' AND db='connected')" -Pass $backendOk -Detail $backendDetail

# =============================================================================
# Check 3: nginx serving the SPA.
# =============================================================================
Write-InfoLine "Checking nginx frontend..."

$nginxOk = $false
$nginxDetail = $null
try {
    $r = Invoke-WebRequest -Uri "http://localhost:8080/" -TimeoutSec 5 -UseBasicParsing
    $nginxOk = $r.Content -match '<div id="root">'
    $nginxDetail = "HTTP GET / -> $($r.StatusCode), contains <div id=`"root`">: $nginxOk"
} catch {
    $nginxDetail = $_.Exception.Message
}
Add-Result -Id "SVC-03-http" -Label "nginx serving the frontend on localhost:8080" -Pass $nginxOk -Detail $nginxDetail

# =============================================================================
# Check 4: Print agent /health -- WARN-ONLY per D-13, never counted toward
# the overall pass/fail decision or exit code. Mirrors
# install-all-native-services.ps1's existing precedent (lines 632-642)
# exactly.
# =============================================================================
Write-InfoLine "Checking print agent reachability (warn-only, D-13)..."

$printAgentOk = $false
try {
    $null = Invoke-RestMethod -Uri "http://localhost:9191/health" -TimeoutSec 5
    $printAgentOk = $true
} catch {}

if ($printAgentOk) {
    Add-Result -Id "NET-02-http" -Label "Print agent reachable via localhost:9191" -Pass $true `
        -Detail "HTTP GET /health succeeded" -Critical $false
} else {
    Add-Result -Id "NET-02-http" -Label "Print agent reachable via localhost:9191" -Pass $false `
        -Detail "Unreachable -- expected on environments without a physical printer" -Critical $false
    Write-WarnLine "NET-02: print agent not reachable at localhost:9191/health -- this is expected if no print agent is running on this machine (staging never runs one; on the live bar machine it runs separately, outside this native-services stack). This checks network/config reachability only, not an actual print job."
}

# =============================================================================
# Print the single PASS/FAIL/WARN summary table.
# =============================================================================
Write-Host ""
Write-Host ("Check".PadRight(48) + "Result") -ForegroundColor Cyan
Write-Host ("-" * 70) -ForegroundColor Cyan
foreach ($res in $results) {
    if ($res.Pass) {
        $status = "PASS"; $color = "Green"
    } elseif (-not $res.Critical) {
        $status = "WARN"; $color = "Yellow"
    } else {
        $status = "FAIL"; $color = "Red"
    }
    Write-Host ("  [{0}] {1,-8} {2}" -f $res.Id, $status, $res.Label) -ForegroundColor $color
    Write-Host ("        {0}" -f $res.Detail) -ForegroundColor Gray
}

# =============================================================================
# Overall PASS/FAIL: only critical (non-print-agent) checks decide the exit
# code, per D-13.
# =============================================================================
$criticalResults = $results | Where-Object { $_.Critical }
$allCriticalPassed = -not ($criticalResults | Where-Object { -not $_.Pass })

Write-Host ""
if ($allCriticalPassed) {
    Write-OkLine "POS is UP and OPERATIONAL -- all critical checks passed."
} else {
    Write-ErrLine "POS has one or more FAILED critical checks -- see the FAIL rows above."
}
Write-Host ("=" * 70) -ForegroundColor Cyan

if ($allCriticalPassed) { exit 0 } else { exit 1 }

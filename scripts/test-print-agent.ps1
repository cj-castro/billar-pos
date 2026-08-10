# =============================================================================
# test-print-agent.ps1
# Bola 8 Print Agent — smoke test suite for Windows
#
# HOW TO RUN:
#   1. Open PowerShell (no Admin required)
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. (optional but recommended) $env:PRINT_AGENT_TOKEN = "<same token the agent is configured with>"
#   4. .\scripts\test-print-agent.ps1
#
# Tests:
#   1. Agent reachable on port 9191
#   2. /health returns ok + printer name + real per-printer status
#   3. Auth is enforced on /print and /printers (skipped with a warning if
#      PRINT_AGENT_TOKEN isn't set in this shell)
#   4. /printers lists Windows printers
#   5. /print with a test receipt (prints to detected printer)
# =============================================================================

$AgentUrl = "http://localhost:9191"
$PrintAgentToken = $env:PRINT_AGENT_TOKEN
$Pass = 0; $Fail = 0; $Warn = 0

function ok($msg)   { Write-Host "  [PASS] $msg" -ForegroundColor Green;  $script:Pass++ }
function fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red;    $script:Fail++ }
function warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow; $script:Warn++ }

function AuthHeaders() {
    if ($PrintAgentToken) { return @{ 'X-Print-Token' = $PrintAgentToken } }
    return @{}
}

# GET /health only — the one endpoint the agent leaves unauthenticated.
function GET($path) {
    try { return Invoke-RestMethod -Uri "$AgentUrl$path" -TimeoutSec 5 }
    catch { return $null }
}
# Authenticated GET, for /printers.
function AuthGET($path) {
    try { return Invoke-RestMethod -Uri "$AgentUrl$path" -Headers (AuthHeaders) -TimeoutSec 5 }
    catch { return $null }
}
function POST($path, $body) {
    try {
        $json = $body | ConvertTo-Json -Depth 10
        return Invoke-RestMethod -Uri "$AgentUrl$path" -Method POST `
            -Headers (AuthHeaders) -Body $json -ContentType "application/json" -TimeoutSec 10
    } catch { return $null }
}
# Raw POST that ignores auth entirely, to prove the agent actually rejects
# unauthenticated requests rather than just returning $null on any error.
function UnauthPOST($path, $body) {
    try {
        $json = $body | ConvertTo-Json -Depth 10
        $r = Invoke-WebRequest -Uri "$AgentUrl$path" -Method POST `
            -Body $json -ContentType "application/json" -TimeoutSec 5 -SkipHttpErrorCheck
        return $r.StatusCode
    } catch { return $null }
}

Write-Host "`n=== Bola 8 Print Agent - Test Suite ===" -ForegroundColor Cyan
Write-Host "   Agent: $AgentUrl`n"

# ── T1: Reachability ──────────────────────────────────────────────────────────
Write-Host "--- T1: Agent reachability ---"
$health = GET "/health"
if ($health -and $health.status -eq "ok") {
    ok "Agent running - status=ok"
    if ($health.printer) { ok "Printer detected: '$($health.printer)'" }
    else                  { warn "No printer detected (check Windows printer setup)" }
} else {
    fail "Agent not responding at $AgentUrl - run install-print-agent.ps1 first"
    Write-Host "`n  STOPPED: agent must be running to continue." -ForegroundColor Red
    exit 1
}

# ── T-HEALTH2: real per-printer status fields ─────────────────────────────────
Write-Host "`n--- T-HEALTH2: printer status fields ---"
if ($health.PSObject.Properties.Name -contains "receipt_printer_status") {
    ok "health includes receipt_printer_status: $($health.receipt_printer_status)"
} else { fail "health missing receipt_printer_status" }
if ($health.PSObject.Properties.Name -contains "kitchen_printer_status") {
    ok "health includes kitchen_printer_status: $($health.kitchen_printer_status)"
} else { fail "health missing kitchen_printer_status" }

# ── T-AUTH: token enforcement ──────────────────────────────────────────────────
Write-Host "`n--- T-AUTH: token enforcement ---"
if (-not $PrintAgentToken) {
    warn "PRINT_AGENT_TOKEN not set in this shell - skipping auth checks (agent may still enforce it; set the env var to test)"
} else {
    $code = UnauthPOST "/print" @{ id = "auth-test" }
    if ($code -eq 401) { ok "POST /print without token is rejected (401)" }
    else                { fail "POST /print without token returned $code, expected 401" }

    $unauthPrinters = $null
    try { $unauthPrinters = Invoke-WebRequest -Uri "$AgentUrl/printers" -TimeoutSec 5 -SkipHttpErrorCheck }
    catch {}
    if ($unauthPrinters -and $unauthPrinters.StatusCode -eq 401) { ok "GET /printers without token is rejected (401)" }
    else { fail "GET /printers without token returned $($unauthPrinters.StatusCode), expected 401" }

    $authedPrinters = AuthGET "/printers"
    if ($authedPrinters) { ok "GET /printers WITH token succeeds" }
    else { fail "GET /printers WITH the correct token still failed - check PRINT_AGENT_TOKEN matches the agent's" }
}

# ── T2: Printer enumeration ───────────────────────────────────────────────────
Write-Host "`n--- T2: Printer enumeration (/printers) ---"
$printers = AuthGET "/printers"
if ($printers -and $printers.printers) {
    ok "Found $($printers.printers.Count) printer(s):"
    foreach ($p in $printers.printers) {
        $marker = if ($p -eq $printers.default) { " [DEFAULT]" } else { "" }
        Write-Host "        - $p$marker"
    }
    if ($printers.default) { ok "Default printer: '$($printers.default)'" }
    else                    { warn "No default printer set in Windows" }
} else {
    warn "Could not enumerate printers (pywin32 may not be installed)"
}

# ── T3: Test receipt print (non-destructive if no thermal printer) ────────────
Write-Host "`n--- T3: Test receipt print ---"

$testReceipt = @{
    ticket_id     = "TEST-$(Get-Date -Format 'yyyyMMddHHmm')"
    table_name    = "Mesa TEST"
    opened_at     = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    closed_at     = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    customer_name = "Print Test"
    cashier       = "Sistema"
    subtotal_cents = 9000
    total_cents    = 9450
    tendered_cents = 10000
    change_cents   = 550
    payment_type   = "CASH"
    tip_cents      = 0
    line_items     = @(
        @{
            name         = "Corona (TEST)"
            quantity     = 2
            price_cents  = 4500
            subtotal_cents = 9000
            modifiers    = @()
        }
    )
}

$result = POST "/print" $testReceipt
if ($result -and $result.ok -eq $true) {
    ok "Test receipt printed successfully -"
} elseif ($result -and $result.ok -eq $false) {
    warn "Agent accepted the request but print failed - check printer is online"
} else {
    fail "Print request failed - check agent logs"
}

# ── T4: Mobile access check (LAN IP) ─────────────────────────────────────────
Write-Host "`n--- T4: LAN access (for iOS/Android) ---"
$lanIP = (
    Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.PrefixOrigin -eq 'Dhcp' -or $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } |
    Select-Object -First 1
).IPAddress

if ($lanIP) {
    Write-Host "    LAN IP: $lanIP" -ForegroundColor Cyan
    try {
        $r = Invoke-RestMethod -Uri "http://${lanIP}:9191/health" -TimeoutSec 5
        if ($r.status -eq "ok") {
            ok "Agent reachable from LAN ($lanIP:9191) - iOS/Android can print -"
        } else {
            warn "LAN health check unexpected response"
        }
    } catch {
        warn "Agent not reachable on LAN ($lanIP:9191) - check Windows Firewall"
        Write-Host "    Run this to open port 9191:" -ForegroundColor Yellow
        Write-Host "    netsh advfirewall firewall add rule name='Print Agent' dir=in action=allow protocol=TCP localport=9191" -ForegroundColor Yellow
    }
} else {
    warn "Could not detect LAN IP - connect to Wi-Fi/LAN first"
}

# ── T5: Docker host access (backend → agent) ──────────────────────────────────
Write-Host "`n--- T5: Docker host access (host.docker.internal) ---"
Write-Host "    The backend container uses: http://host.docker.internal:9191"
Write-Host "    This resolves automatically on Windows Docker Desktop." -ForegroundColor Gray
Write-Host "    Verify from inside the backend container:" -ForegroundColor Gray
Write-Host "      docker exec billar-pos-backend-1 curl -s http://host.docker.internal:9191/health" -ForegroundColor DarkGray
$dockerOk = $null
try {
    $dockerOk = & docker exec billar-pos-backend-1 curl -s "http://host.docker.internal:9191/health" 2>$null
} catch {}
if ($dockerOk -and $dockerOk -like '*"ok"*') {
    ok "Backend container can reach print agent via host.docker.internal -"
} else {
    warn "Could not verify from Docker container (containers may not be running)"
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host "`n=============================================="
Write-Host " Test Results:"
Write-Host "   PASS: $Pass  WARN: $Warn  FAIL: $Fail"
if ($Fail -eq 0) {
    Write-Host " Print agent is ready! -" -ForegroundColor Green
} else {
    Write-Host " Fix failures above before going live." -ForegroundColor Red
}
Write-Host "=============================================="
# ─────────────────────────────────────────────────────────────────────────────
# health-check.ps1 — Verify Bola 8 POS system is fully operational
# Usage:  powershell -File scripts\health-check.ps1
# ─────────────────────────────────────────────────────────────────────────────

$proj = "C:\Users\bola8lacalma\Desktop\POS\billiards"
$api  = "http://localhost:8080/api/v1"
$pass = 0; $fail = 0

function Ok($msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green;  $script:pass++ }
function Fail($msg) { Write-Host "  ❌ $msg" -ForegroundColor Red;    $script:fail++ }
function Warn($msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Section($title) { Write-Host "`n── $title ──" -ForegroundColor Cyan }

Write-Host "`n╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host   "║   Bola 8 POS — Health Check          ║" -ForegroundColor Cyan
Write-Host   "╚══════════════════════════════════════╝" -ForegroundColor Cyan

# ── 1. Docker containers ────────────────────────────────────────────────────
Section "Docker Containers"
$containers = @("billiards-postgres-1", "billiards-backend-1", "billiards-frontend-1")
foreach ($c in $containers) {
    $status = docker inspect --format "{{.State.Status}}" $c 2>$null
    if ($status -eq "running") { Ok "$c is running" }
    else { Fail "$c is $status (expected: running)" }
}

# ── 2. Frontend reachable ────────────────────────────────────────────────────
Section "Web App (port 8080)"
try {
    $r = Invoke-WebRequest "http://localhost:8080" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Ok "Frontend loads (HTTP 200)" }
    else { Fail "Frontend returned HTTP $($r.StatusCode)" }
} catch { Fail "Frontend not reachable: $_" }

# ── 3. Backend API ────────────────────────────────────────────────────────────
Section "Backend API"
try {
    $r = Invoke-RestMethod "$api/auth/login" -Method POST `
         -Body '{"username":"manager","password":"manager123"}' `
         -ContentType "application/json" -TimeoutSec 5
    if ($r.access_token) {
        Ok "API login works"
        $token = $r.access_token
        $headers = @{ Authorization = "Bearer $token" }

        # Check resources endpoint
        $res = Invoke-RestMethod "$api/resources" -Headers $headers -TimeoutSec 5
        if ($res.Count -gt 0) { Ok "Resources endpoint: $($res.Count) tables returned" }
        else { Fail "Resources endpoint returned 0 items" }

        # Check menu
        $menu = Invoke-RestMethod "$api/menu/items" -Headers $headers -TimeoutSec 5
        if ($menu.Count -gt 0) { Ok "Menu endpoint: $($menu.Count) items returned" }
        else { Warn "Menu returned 0 items — check menu setup" }

        # Check cash session status
        $cash = Invoke-RestMethod "$api/cash/status" -Headers $headers -TimeoutSec 5
        if ($cash.open) { Warn "Bar session is OPEN (normal if serving)" }
        else { Ok "Bar session is CLOSED (normal if not serving)" }

    } else { Fail "Login returned no token" }
} catch { Fail "Backend API error: $_" }

# ── 4. Database integrity ─────────────────────────────────────────────────────
Section "Database Integrity"
try {
    $tables = docker exec billiards-postgres-1 psql -U billiard -d billiardbar -t -c `
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>$null
    $tableCount = [int]($tables.Trim())
    if ($tableCount -gt 10) { Ok "DB has $tableCount tables (expected 12+)" }
    else { Fail "Only $tableCount tables found — DB may be incomplete" }

    # Check for corrupted/stuck data
    $openSessions = docker exec billiards-postgres-1 psql -U billiard -d billiardbar -t -c `
        "SELECT count(*) FROM cash_sessions WHERE status='OPEN';" 2>$null
    $openSessions = [int]($openSessions.Trim())
    if ($openSessions -le 1) { Ok "Cash sessions OK ($openSessions open)" }
    else { Warn "$openSessions open cash sessions — check for duplicates" }

    $orphanTimers = docker exec billiards-postgres-1 psql -U billiard -d billiardbar -t -c `
        "SELECT count(*) FROM timer_sessions WHERE end_time IS NULL
         AND ticket_id NOT IN (SELECT id FROM tickets WHERE status='OPEN');" 2>$null
    $orphanTimers = [int]($orphanTimers.Trim())
    if ($orphanTimers -eq 0) { Ok "No orphaned pool timers" }
    else { Warn "$orphanTimers orphaned timer(s) — run ghost cleanup in manager panel" }

    $ghostTickets = docker exec billiards-postgres-1 psql -U billiard -d billiardbar -t -c `
        "SELECT count(*) FROM tickets t
         JOIN resources r ON r.id = t.resource_id
         WHERE t.status='OPEN' AND r.status='AVAILABLE';" 2>$null
    $ghostTickets = [int]($ghostTickets.Trim())
    if ($ghostTickets -eq 0) { Ok "No ghost tickets" }
    else { Warn "$ghostTickets ghost ticket(s) — use 🧹 button in Caja Fuerte panel" }

} catch { Fail "Could not query database: $_" }

# ── 5. Disk space ─────────────────────────────────────────────────────────────
Section "Disk Space"
$disk = Get-PSDrive C | Select-Object Used, Free
$freeGB = [math]::Round($disk.Free / 1GB, 1)
$usedGB = [math]::Round($disk.Used / 1GB, 1)
if ($freeGB -gt 5) { Ok "Disk C: — ${freeGB}GB free / ${usedGB}GB used" }
elseif ($freeGB -gt 2) { Warn "Disk C: low — ${freeGB}GB free. Consider cleanup." }
else { Fail "Disk C: critically low — ${freeGB}GB free!" }

# ── 6. Recent backups ─────────────────────────────────────────────────────────
Section "Backups"
$backDir = Join-Path $proj "backups"
$recent = Get-ChildItem "$backDir\db_*.zip" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($recent) {
    $ageHours = [math]::Round(((Get-Date) - $recent.LastWriteTime).TotalHours, 1)
    if ($ageHours -lt 25) { Ok "Last backup: $($recent.Name) ($ageHours hrs ago)" }
    else { Warn "Last backup is $ageHours hrs old — consider running backup-pos.ps1" }
} else { Fail "No backups found in $backDir — run backup-pos.ps1 now!" }

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host "`n══════════════════════════════════════" -ForegroundColor Cyan
if ($fail -eq 0) {
    Write-Host "✅ ALL CHECKS PASSED ($pass passed, $($fail+0) failed)" -ForegroundColor Green
} else {
    Write-Host "❌ $fail CHECK(S) FAILED — $pass passed" -ForegroundColor Red
    Write-Host "   See RECOVERY.md for fix instructions" -ForegroundColor Yellow
}
Write-Host "══════════════════════════════════════`n" -ForegroundColor Cyan

# Phase 4: Process Supervision & Reliability Hardening - Research

**Researched:** 2026-08-09  
**Domain:** Windows service crash recovery, process supervision, health-check patterns, data integrity  
**Confidence:** HIGH

## Summary

Phase 4 validates that the native Windows Services stack built in Phase 2 and hardened in Phase 3 actually survives crashes, reboots, and power loss independently, with real health-check gates protecting against partial-up states, and with the known ghost-ticket state-desync risk investigated and fixed. All work is staged-only; production cutover happens in Phase 5.

**Primary recommendation:** Implement SUP-01 through SUP-04 as a unified strategy: use NSSM's existing `AppExit Default Restart` + `DependOnService` chains (already wired) for crash recovery; add a DB-connectivity check to the `/api/v1/health` endpoint to prevent "process running but DB dead" false negatives; wire a print-agent reachability warn-only check into the backend startup; validate both with real reboot + crash-isolation tests on staging; investigate ghost-ticket root cause via code audit focusing on multi-table atomicity and wrap the ticket-open flow in a single committed transaction; formally verify eventlet single-worker constraint still holds after moving away from Docker.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Deepen `/api/v1/health` to perform real `SELECT 1` against Postgres before returning ok (catches DB-pool-exhausted failure mode)
- **D-02:** For scheduler and telegram-bot (no HTTP listener), Windows `Get-Service` status → `Running` (no process exit loop) is the accepted responsiveness signal
- **D-03:** Build unified health-check rollup script (`scripts/check-health.ps1`) that polls all 6 services via their respective signals + prints PASS/FAIL summary
- **D-04:** Investigate ghost-ticket root cause + attempt real fix (not just docs); fix what's feasible, explicitly document residual risk
- **D-05:** Read existing `clean_ghost_tickets()` code carefully, understand `was_reopened` F-1 fix before proposing new fix
- **D-06 (HARD):** No GSD plan in this phase or any future phase may include automated write to live bar database; cleanup is operator-initiated only
- **D-07:** Read-only production diagnostics out of scope for DATA-02
- **D-08:** All validation on staging machine (WIDOWSVAIL) only
- **D-09:** SUP-03 (auto-start after reboot) requires actual `Restart-Computer` on staging, not simulated stop/start
- **D-10:** SUP-01 (independent crash-restart) validated by forcibly killing each service's process one at a time with `Stop-Process -Force`, confirm others unaffected
- **D-11:** SUP-02 (correct dependency order) proven by same D-09 reboot test; `install-all-native-services.ps1` already wires `DependOnService`
- **D-12:** Add print-agent reachability check to backend's `create_app()` near `_check_default_secrets` pattern
- **D-13:** Warn and continue (never block) if print agent unreachable; matches Phase 3 warn-never-block philosophy

### Claude's Discretion
- Exact PowerShell/Python implementation details of unified health-check script (D-03)
- Exact mechanism for ghost-ticket fix (D-04) — constraint vs. trigger vs. app-level wrapping
- Whether native Postgres Windows service needs explicit `sc.exe failure` recovery config for SUP-01 parity with NSSM
- Exact wording of DATA-03 (eventlet single-worker) verification note

### Deferred Ideas
None — discussion stayed within phase scope.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Service crash detection and auto-restart | Backend Host (Windows Services) | — | NSSM `AppExit Default Restart` configuration handles this at the OS level |
| Service startup order enforcement | Backend Host (Windows Services) | — | Windows Service Manager enforces `DependOnService` chains during boot |
| Application-level health responsiveness | API Tier | Database Tier | Flask backend's `/api/v1/health` must verify DB connectivity to avoid partial-up false negatives |
| Print-agent reachability verification | API Tier | Networking | Backend startup must warn if print agent unreachable, but never block ticket operations |
| Scheduler/bot process responsiveness | Backend Host (Windows Services) | — | APScheduler BlockingScheduler has no HTTP listener; Windows `Get-Service Running` status is the signal |
| Ghost-ticket state consistency | Database Tier | API Tier | Multi-table atomicity violation must be fixed at DB constraint or transaction level; app-level recovery is cleanup, not prevention |
| Eventlet single-worker constraint verification | Backend Host (Windows Services) | Backend Code | Native Windows NSSM service entry must preserve `-w 1` exactly; eventlet greenlet scheduling unchanged from Docker |

---

## Standard Stack

### Core Services (NSSM-Wrapped Native Windows Services)

| Service | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| NSSM 2.24 | 2.24 | Non-Sucking Service Manager wraps Python/Node processes as Windows Services | Proven pattern in Phase 2; built-in crash-restart, auto-start, dependency ordering; stable vs. underconstrained alternatives like WinSW |
| PostgreSQL 15 | 15.x (native Windows service) | Relational database, no Docker | Phase 2 deliverable; already running as native Windows service |
| Python 3.11 | 3.11+ | Flask backend, scheduler, telegram-bot runtime | Unchanged from Docker; per-service venvs from Phase 2 |
| nginx 1.x | 1.25+ (Windows native binary) | Reverse proxy, static frontend serving | Phase 2 deliverable; NSSM-wrapped service; reuses existing `frontend/nginx.conf` |
| Flask + Socket.IO | Flask 3.x, python-socketio 5.x | Backend web framework, real-time updates | Unchanged; runs via `wsgi.py`'s built-in `socketio.run()` (no gunicorn on Windows) |

### Supporting / Health-Check Tools

| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| PowerShell (Windows 11 built-in) | 5.1+ | Service management, health-check scripting, health rollup | `check-health.ps1` driver script |
| curl or Invoke-WebRequest | Built-in or via winget | HTTP health-check probes | Unified health-check rollup probes backend, nginx, print-agent HTTP endpoints |

### Alternatives Not Used

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| NSSM | WinSW | WinSW requires .NET Framework; NSSM is a single statically-linked exe (lower friction) |
| NSSM | Windows Task Scheduler | Task Scheduler lacks dependency ordering and per-failure restart logic; NSSM is the standard service-wrapper on Windows |
| Windows native services | Supervisor (Unix-only) | Supervisor is Linux-specific; this codebase must run on Windows |
| Per-service health checks (6 endpoints) | Unified `check-health.ps1` | Having 6 scattered checks is operationally harder; unified script with PASS/FAIL summary is clearer |

**Installation/Configuration References:**
- NSSM: Already installed in Phase 2 via `scripts/install-nssm-*.ps1` scripts
- Phase 2 established these NSSM patterns:
  - `AppExit Default Restart` (auto-restart on any exit)
  - `AppRestartDelay 5000` (5-second throttle between restarts)
  - `SERVICE_AUTO_START` (start at boot)
  - `DependOnService` chains for startup ordering (Postgres → Backend/Scheduler/Bot → Nginx)
  - Per-service venvs in Phase 2; Phase 4 validates these still work after moving crash-restart from Docker orchestration to NSSM orchestration

---

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Windows 11 Machine                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐   ┌──────────────────────────────────────────┐  │
│  │  Nginx      │   │  Backend (Flask + Socket.IO)              │  │
│  │  :8080      │   │  :5000 (localhost)                        │  │
│  │  (NSSM)     │←→ │  Eventlet single-worker (-w 1)           │  │
│  └─────────────┘   │  (NSSM-wrapped wsgi.py)                  │  │
│       ↑            │  Auto-restart on crash:                  │  │
│  depends on        │    AppExit Default Restart               │  │
│  Backend           │    AppRestartDelay 5s                    │  │
│                    │  Startup reachability check:             │  │
│                    │    POST /api/v1/tickets/clean-ghosts      │  │
│                    └──────────────────────────────────────────┘  │
│                           ↑                                       │
│                    depends on                                     │
│                    Postgres                                       │
│                           ↑                                       │
│  ┌─────────────────────────┴──────────────────────────────────┐  │
│  │   Postgres 15 (native Windows service)                     │  │
│  │   localhost:5432                                           │  │
│  │   Crash-restart: (needs investigation in D-40)            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐  │
│  │ Scheduler        │  │ Telegram Bot                         │  │
│  │ (NSSM-wrapped)   │  │ (NSSM-wrapped)                       │  │
│  │ backend/         │  │ telegram-bot/bot.py                  │  │
│  │ scheduler.py     │  │ Auto-restart on crash                │  │
│  │ BlockingScheduler│  │ (NSSM AppExit Default Restart)       │  │
│  │ (no HTTP port)   │  │                                      │  │
│  │ Status via:      │  │ Status via:                          │  │
│  │ Get-Service      │  │ Get-Service                          │  │
│  │ Running          │  │ Running                              │  │
│  └──────────────────┘  └──────────────────────────────────────┘  │
│           ↑                         ↑                             │
│    depend on Postgres          depend on Postgres                │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Print Agent (Windows background process, external)          │ │
│  │ scripts/print_agent/print_agent.py                          │ │
│  │ localhost:9191 (NOT in NSSM scope; separate mgmt)          │ │
│  │ Reachability check: GET /health (warn-only on failure)     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Unified Health-Check Rollup (D-03)                          │ │
│  │ scripts/check-health.ps1                                    │ │
│  │ Polls: Backend /health (DB-checked), nginx, print-agent     │ │
│  │        Get-Service {Postgres, Backend, Scheduler, Bot}      │ │
│  │ Output: Single PASS/FAIL summary                            │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

Data Flow on Ticket Open (crash-risk point):
  1. Nginx → Backend /api/v1/tickets (POST)
  2. Flask locks Resource row via with_for_update()
  3. Check resource.status != IN_USE
  4. Create Ticket row, flush to DB (id assigned)
  5. Update Resource.status = IN_USE (memory)
  6. Create PoolTimerSession if pool table (memory)
  7. Commit transaction ← CRASH WINDOW HERE
  
  If crash @ step 7: Ticket exists in DB, Resource.status is still AVAILABLE
  → Ghost ticket on next backend restart
```

### Recommended Project Structure

No new directories needed for Phase 4; use existing:
```
scripts/
├── install-nssm-backend.ps1       (Phase 2)
├── install-nssm-scheduler.ps1     (Phase 2)
├── install-nssm-telegram-bot.ps1  (Phase 2)
├── install-nssm-nginx.ps1         (Phase 2)
├── install-nssm-print-agent.ps1   (Phase 2)
├── install-all-native-services.ps1 (Phase 2)
├── check-health.ps1               (Phase 4 NEW — unified health rollup)
├── postgres-native/ (or similar)
├── print_agent/

backend/
├── app/
│   ├── __init__.py (update health endpoint, add print-agent check)
│   ├── api/
│   │   ├── tickets.py (audit for ghost-ticket atomicity issues)
├── wsgi.py (unchanged from Phase 2)
├── service_entry.py (unchanged from Phase 2)
```

### Pattern 1: NSSM Crash-Restart with Automatic Throttling

**What:** When a service process exits (crash), NSSM automatically restarts it after a configured delay (`AppRestartDelay`), with increasingly longer delays if restarts fail repeatedly.

**When to use:** All 5 NSSM-wrapped services in this stack; already configured in Phase 2.

**Phase 2 Configuration (Verified to Continue):**
```powershell
# Per-service install script (already done):
nssm set <ServiceName> AppExit Default Restart
nssm set <ServiceName> AppRestartDelay 5000      # 5 seconds
nssm set <ServiceName> Start SERVICE_AUTO_START  # start at boot
```

**How it works:**
- First restart: 5 seconds after crash
- Subsequent restarts: exponentially longer, up to 4 minutes max [CITED: nssm.cc/usage]
- If service startup completes within `AppThrottle` threshold (default 1500ms), throttle resets for next crash
- `AppExit Default` means "apply the Restart action for any exit code not explicitly configured"

**Phase 4 Validation (D-10):**
- Kill one service's process via `Stop-Process -Force <pid>` on staging
- Confirm: (a) NSSM restarts it within 5s, (b) other services completely unaffected
- Repeat for each service independently

**Key insight:** This is NOT "all or nothing like Docker" — each service restarts independently; a backend crash does not restart scheduler/bot/nginx. This is the core SUP-01 fix.

### Pattern 2: Service Dependency Ordering via DependOnService

**What:** Windows Service Control Manager (SCM) uses `DependOnService` metadata to enforce startup order during boot and during dependency-aware restarts.

**When to use:** When a service requires another service to be alive before connecting (e.g., backend needs Postgres ready).

**Phase 2 Configuration (Verified to Continue):**
```powershell
# install-all-native-services.ps1 step 7:
nssm set BilliardBarBackend DependOnService $PgServiceName
nssm set BilliardBarScheduler DependOnService $PgServiceName
nssm set BilliardBarTelegramBot DependOnService $PgServiceName
nssm set BilliardBarNginx DependOnService BilliardBarBackend
```

**Startup order enforced by SCM:**
1. PostgreSQL starts first (no dependencies)
2. Backend, Scheduler, TelegramBot start in parallel (all depend only on Postgres)
3. Nginx starts once Backend is running (depends on Backend)

**How it works:**
- During boot, SCM reads `DependOnService` registry values and queues services for startup in dependency order
- If a service fails to start, dependent services are not started (e.g., if Postgres fails to start, backend is never started)
- SCM waits for a service's `START_PENDING` timeout (default 20s, configurable via `ServicesPipeTimeout` registry key) before marking it failed [CITED: learn.microsoft.com/answers/questions/2196320]

**Phase 4 Validation (D-09, D-11):**
- Perform actual `Restart-Computer` on staging machine (not simulated)
- Monitor service startup via `Get-Service` in a loop
- Confirm: Postgres starts first, then backend/scheduler/bot, then nginx
- Repeat with power-off (hard reboot) to test both graceful and power-loss recovery

**Key insight:** This is the "correct order" fix for SUP-02; Phase 4 just validates that Phase 2's config actually works on real boots.

### Pattern 3: Deepened Health-Check Endpoint (D-01)

**What:** Instead of a bare `{'status': 'ok'}`, the `/api/v1/health` endpoint performs a real database operation before responding.

**Current implementation (Phase 3):**
```python
@app.route('/api/v1/health')
def health():
    return {'status': 'ok'}  # ← Lies if DB is down but process is running
```

**Phase 4 Implementation:**
```python
@app.route('/api/v1/health')
def health():
    try:
        # Real DB check: if connection pool is exhausted, this fails
        db.session.execute(text('SELECT 1'))
        db.session.commit()
        return {'status': 'ok', 'db': 'connected'}
    except Exception as e:
        # Log but don't fail hard; let unified health script decide overall status
        app.logger.error(f"Health check DB query failed: {e}")
        return {'status': 'error', 'detail': str(e)}, 503
```

**Why:** The failure mode SUP-04 exists to prevent is: "backend process is running, HTTP port is responding, but database connection pool is exhausted due to a cascade failure or memory leak." Without a DB check, the unified health-check script (D-03) would report PASS even though tickets cannot be opened.

**Phase 4 Validation:**
- Call `GET /api/v1/health` on staging backend → expect 200 OK if DB responsive
- Simulate DB unavailability (restart Postgres), retry health check → expect 503 error
- Confirm unified `check-health.ps1` correctly reports this as a failure

### Pattern 4: Warn-Never-Block Print-Agent Reachability (D-12, D-13)

**What:** Backend startup logs a loud warning if the print agent is unreachable, but never fails to start (matches Phase 3 D-11/D-12 pattern for secrets).

**Implementation location:** `backend/app/__init__.py`, in `create_app()`, near `_check_default_secrets`:

```python
def _check_print_agent_reachability(app):
    """Warn (never fail) if print agent is unreachable at startup.
    
    Phase 3 D-11/D-12: this is a live bar POS — a hard startup failure 
    risks blocking operation. Only warn; never fail.
    
    Phase 4 D-12/D-13: extends Phase 3's warn-never-block philosophy 
    to networking/external services.
    """
    print_agent_url = app.config.get('PRINT_AGENT_URL', 'http://localhost:9191')
    try:
        response = requests.get(f"{print_agent_url}/health", timeout=3)
        if response.status_code == 200:
            app.logger.info(f"Print agent reachable at {print_agent_url}")
            return
    except Exception as e:
        pass  # Fall through to warning
    
    app.logger.warning(
        f"Print agent unreachable at {print_agent_url} — printing may fail. "
        f"Check: (1) print-agent service is running, (2) {print_agent_url} is correct env var, "
        f"(3) Windows firewall allows access. Continuing startup anyway (phase 3 D-13)."
    )
```

**Why:** Printing is fire-and-forget and never blocks ticket operations elsewhere (see `CLAUDE.md` Architecture). A staff member opening a table should not wait for print-agent health before proceeding. The warning in the log is enough for an operator to notice and troubleshoot during log review.

**Phase 4 Validation:**
- Kill print-agent process on staging
- Restart backend service via NSSM
- Confirm: (a) backend starts and becomes healthy, (b) WARNING appears in logs
- Resume print-agent, repeat startup, confirm no warning

### Pattern 5: Unified Health-Check Rollup Script (D-03)

**What:** A single PowerShell script that checks all 6 services and reports one PASS/FAIL summary, replacing scattered per-service checks.

**Purpose:** An operator can run `.\scripts\check-health.ps1` and get a clear dashboard of whether the POS is actually up and operational.

**Implementation sketch:**

```powershell
# scripts/check-health.ps1
Write-Host "=== Billar POS Health Check ===" -ForegroundColor Cyan

$results = @()

# 1. Windows service status
foreach ($svc in @("PostgreSQL", "BilliardBarBackend", "BilliardBarScheduler", "BilliardBarTelegramBot", "BilliardBarNginx")) {
    $status = (Get-Service -Name $svc -ErrorAction SilentlyContinue).Status
    $ok = $status -eq "Running"
    $results += @{ name = $svc; ok = $ok; detail = $status }
}

# 2. Backend /api/v1/health (includes DB check per D-01)
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:5000/api/v1/health" -TimeoutSec 5
    $ok = $resp.status -eq "ok"
    $results += @{ name = "Backend /health"; ok = $ok; detail = $resp.db }
} catch {
    $results += @{ name = "Backend /health"; ok = $false; detail = $_.Exception.Message }
}

# 3. Nginx root
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:8080/" -TimeoutSec 5
    $ok = $resp.Content -match '<div id="root">'
    $results += @{ name = "Nginx serving SPA"; ok = $ok; detail = "HTTP 200" }
} catch {
    $results += @{ name = "Nginx serving SPA"; ok = $false; detail = $_.Exception.Message }
}

# 4. Print agent (warn-only per D-13)
try {
    $resp = Invoke-RestMethod -Uri "http://localhost:9191/health" -TimeoutSec 5
    $results += @{ name = "Print agent /health"; ok = $true; detail = "Reachable" }
} catch {
    $results += @{ name = "Print agent /health"; ok = $false; detail = "UNREACHABLE (expected on staging)" }
}

# Print table
Write-Host ""
Write-Host ("Service".PadRight(30) + "Status".PadRight(10) + "Detail") -ForegroundColor Cyan
Write-Host ("-" * 70) -ForegroundColor Cyan
foreach ($r in $results) {
    $status = if ($r.ok) { "PASS" } else { "FAIL" }
    $color = if ($r.ok) { "Green" } else { "Red" }
    Write-Host ($r.name.PadRight(30) + $status.PadRight(10) + $r.detail) -ForegroundColor $color
}

# Overall result
$overall = $results | Where-Object { $_.name -notmatch "Print agent" } | Where-Object { -not $_.ok } | Measure-Object | Select-Object -ExpandProperty Count
if ($overall -eq 0) {
    Write-Host "`n✓ POS is UP and OPERATIONAL" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n✗ POS has $overall critical failure(s)" -ForegroundColor Red
    exit 1
}
```

**Phase 4 Validation:**
- Run script with all services up → expect PASS
- Kill one service, rerun → expect FAIL with service name
- Restart service, rerun → expect PASS
- Kill Postgres, restart backend, rerun → expect backend health check to fail even if process is running

### Anti-Patterns to Avoid

- **Blocking on external service failure:** Print agent unavailability must never prevent backend startup (D-13). Mirrors "live bar" operational safety principle from CLAUDE.md.
- **Multiple health-check endpoints scattered in docs/scripts:** Consolidate into unified rollup (D-03); makes it impossible for an operator to miss a critical service.
- **Ignoring dependency order at boot:** D-11 uses existing `DependOnService` config from Phase 2; do NOT manually re-sequence services or add start-up delay logic in app code. Let Windows SCM handle it.
- **Fixing ghost-tickets via cleanup only:** D-04 requires investigation of root cause + fix; recovery tools are supplementary, not primary solution.
- **Automated production cleanup:** D-06 is a hard constraint; never add a "run clean-ghosts on bar machine" step to any GSD plan.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Service auto-restart on crash | Custom watchdog thread in Python | NSSM's `AppExit Default Restart` (already Phase 2) | NSSM is battle-tested; custom watchdog introduces signal-handling complexity, race conditions on Windows |
| Service dependency ordering at boot | Startup delay loops in app code (e.g., "check if Postgres is up, sleep 5s, retry") | Windows Service Manager's `DependOnService` (already Phase 2) | SCM waits for dependency startup before starting dependent services; app-level polling is fragile and duplicates OS functionality |
| Unified health check | 6 separate endpoint checks scattered in runbooks | Single `check-health.ps1` script with consolidated output | Operator can run one command and see everything; scattered checks are easier to miss |
| Graceful shutdown on SIGTERM | Custom Python signal handler with eventlet integration | NSSM's `AppExit` restart logic (already Phase 2) + graceful timeout in SCM | NSSM handles Windows-specific termination signals (not just SIGTERM); custom handlers risk missing CTRL_CLOSE_EVENT or CTRL_SHUTDOWN_EVENT |
| Ghost-ticket cleanup via app | Custom app-level lock/retry logic after detecting desync | Database-level constraint or atomic multi-table transaction | Application crashes mid-cleanup anyway; DB constraints work even if app crashes |
| Process supervision across multiple services | Custom orchestration script that manually restarts services | NSSM + PowerShell service management commands (already Phase 2) | NSSM is designed for this; custom scripts miss edge cases (e.g., Service Control Manager's START_PENDING timeout) |

**Key insight:** Phase 2 already chose the right tools (NSSM, Windows services, dependency management). Phase 4's job is to validate they work under real crash/reboot scenarios, not to replace them with custom logic.

---

## Runtime State Inventory

**Trigger:** Phase 4 does not involve renaming, refactoring, or migrating state. Inventory check not required.

**Skip reason:** All state remains in `billiardbar` PostgreSQL database (unchanged hosting location); no registry keys, environment variable names, or OS-registered state is being renamed. Ghost-ticket fixes may modify data, but as read-only investigation + staged-only fix validation, not production migration.

---

## Common Pitfalls

### Pitfall 1: Confusing Process Running with Service Healthy

**What goes wrong:** A backend process can be running (NSSM shows `Running`) but unable to connect to database (connection pool exhausted, Postgres crashed, network down). Checking only `Get-Service` status or bare HTTP 200 response masks this failure.

**Why it happens:** Native Windows processes don't have the container-level health checks Docker provides; NSSM only knows if the process exited, not if it can do useful work.

**How to avoid:** Implement real DB-connectivity check in `/api/v1/health` endpoint (D-01); unified `check-health.ps1` must call this endpoint, not just check `Get-Service` status.

**Warning signs:** 
- Unified health check shows all services Running but POS doesn't respond to login requests
- Backend logs show "database connection error" but NSSM doesn't restart (process is still alive, just broken)
- Staff report "tables show but can't open" — suggests backend is alive but DB is dead

### Pitfall 2: Power Loss ≠ Graceful Shutdown

**What goes wrong:** Testing SUP-03 (auto-start after reboot) with manual `nssm stop` + `nssm start` does NOT exercise real boot-time service-ordering logic. A power-off/power-on cycle (or `Restart-Computer -Force`) is required.

**Why it happens:** Windows Service Control Manager only enforces `DependOnService` ordering during actual boot; `nssm stop` is a graceful shutdown that doesn't exercise the same code path as a real boot.

**How to avoid:** Phase 4 D-09 explicitly requires actual `Restart-Computer` on staging machine, not simulated. Do not skip this step.

**Warning signs:**
- Unified health check passes after `nssm restart` but fails after actual power cycle
- Backend starts before Postgres on real boot (dependency chain not enforced)
- Services time out during boot (ServicesPipeTimeout registry key too low)

### Pitfall 3: Independent Service Crashes Interpreted as "All or Nothing"

**What goes wrong:** During testing, when one service crashes, an observer might restart all services (old Docker habit) instead of letting NSSM auto-restart just that one service. This masks whether the auto-restart and independence actually work.

**Why it happens:** Docker all-or-nothing behavior is deeply ingrained; `docker-compose restart` restarts everything even if you wanted to restart one container.

**How to avoid:** Phase 4 D-10 explicitly kills individual service processes and verifies NSSM restarts only that process. Do not manually restart other services during the test.

**Warning signs:**
- Unified health check reports all services Running after a service crash (hides the restart)
- When backend crashes, scheduler and bot are manually restarted (habit from Docker debugging)

### Pitfall 4: Ghost-Ticket Fix Misses Atomicity Window

**What goes wrong:** A fix wraps only part of the multi-step ticket-open sequence in a transaction, leaving a gap where a crash can still occur between creating the ticket and updating the resource status (or between creating timer session and committing).

**Why it happens:** The exact sequence in `backend/app/api/tickets.py:189-238` is: lock resource → flush ticket → set resource IN_USE → flush timer → commit. If the fix doesn't cover all these steps in one atomic transaction, ghost tickets can still occur.

**How to avoid:** Trace the EXACT code path from the HTTP request entry point through every database operation up to the final commit. Ensure all multi-table updates are in one `db.session.commit()`, not scattered across multiple flushes and commits. If using database-level constraints, verify they enforce the invariant "if ticket.status == OPEN then resource.status == IN_USE" atomically.

**Warning signs:**
- After "fixed" code is deployed, ghost tickets still appear in production (though less frequently)
- Root-cause analysis shows a different code path than the one that was fixed

### Pitfall 5: Eventlet Single-Worker Constraint Lost in Native Windows Deployment

**What goes wrong:** The native Windows service wrapper (NSSM) or a new `service_entry.py` could accidentally introduce multi-worker behavior (e.g., spawning thread pools or multiple processes), breaking eventlet's single-process assumption and causing Socket.IO message delivery to fail or deadlock.

**Why it happens:** Switching from Docker's orchestrated `gunicorn --worker-class eventlet -w 1` to NSSM-wrapped `python wsgi.py` introduces a new layer of process management; if someone "optimizes" by forking multiple processes, the constraint breaks silently.

**How to avoid:** Phase 4 D-02 (DATA-03) includes an explicit verification step: grep for raw `threading.Thread` usage in backend code, confirm `wsgi.py` and `service_entry.py` run single-process, and verify `socketio.start_background_task()` is used (not `threading.Thread`). Document this verification in a short DATA-03 verification note.

**Warning signs:**
- Socket.IO messages don't broadcast to all connected clients (wrong process receives message)
- `socketio.start_background_task` calls hang or timeout (threading blocks eventlet scheduler)
- Backend logs show "eventlet greenlet exception" errors (eventlet not running in single-process mode)

---

## Code Examples

### Example 1: Database-Level Constraint for Ghost-Ticket Prevention

**Source: PostgreSQL Constraints Documentation** [CITED: postgresql.org/docs/current/ddl-constraints.html]

If the root-cause investigation (D-04) determines that a CHECK constraint can enforce the invariant "if ticket.status == OPEN, then resource.status != AVAILABLE", this would prevent ghost tickets at the database level:

```sql
-- Add to backend/app/__init__.py's STEP blocks (idempotent, IF NOT EXISTS pattern)
-- This ensures atomically: no OPEN ticket can exist on an AVAILABLE resource
ALTER TABLE tickets ADD CONSTRAINT check_ticket_resource_consistency
  CHECK (
    (status != 'OPEN') OR 
    (resource_id IS NULL) OR 
    (resource_id IN (
      SELECT id FROM resources WHERE status IN ('IN_USE', 'RESERVED')
    ))
  );

-- Or simpler: if a ticket is OPEN, its resource must be IN_USE
-- (requires a JOIN; CHECK constraints cannot directly reference other tables in all DB versions)
-- For Postgres 11+, use DEFERRABLE constraint or trigger instead.
```

**Alternative: Trigger-Based Enforcement**

```sql
-- Trigger prevents ticket creation on AVAILABLE resource
CREATE OR REPLACE FUNCTION check_ticket_resource_available()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'OPEN' THEN
    IF EXISTS (
      SELECT 1 FROM resources 
      WHERE id = NEW.resource_id AND status = 'AVAILABLE'
    ) THEN
      RAISE EXCEPTION 'Cannot open ticket on an AVAILABLE resource';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_ticket_resource_consistency
BEFORE INSERT OR UPDATE ON tickets
FOR EACH ROW
EXECUTE FUNCTION check_ticket_resource_available();
```

**Phase 4 D-04 Action:** Investigate which approach is feasible given existing schema and migration patterns (Phase 2's idempotent STEP blocks). Choose constraint or trigger based on performance + maintainability.

### Example 2: Deepened Health-Check Endpoint

**Source: Backend code, Phase 3 `_check_default_secrets` pattern**

```python
# backend/app/__init__.py, in create_app() function

@app.route('/api/v1/health')
def health():
    """Health check that verifies database connectivity.
    
    Catches the failure mode where the backend process is running and HTTP
    port is responsive, but the database connection pool is exhausted or
    Postgres is down. This is the SUP-04 responsiveness gate: "POS is up"
    means all critical services are actually working, not just "processes exist".
    """
    try:
        # Real database check: will fail if connection pool is exhausted,
        # Postgres is down, or there are network issues.
        db.session.execute(text('SELECT 1'))
        db.session.commit()
        return {
            'status': 'ok',
            'db': 'connected',
            'timestamp': datetime.now(timezone.utc).isoformat()
        }, 200
    except Exception as e:
        app.logger.error(f"Health check failed: {type(e).__name__}: {e}")
        return {
            'status': 'error',
            'detail': f"Database unreachable: {type(e).__name__}",
            'timestamp': datetime.now(timezone.utc).isoformat()
        }, 503
```

**Phase 4 Validation:**
- Call endpoint with Postgres running → expect 200 with `"db": "connected"`
- Kill Postgres, call endpoint → expect 503 with error detail
- Confirm unified `check-health.ps1` reports backend health as FAIL

### Example 3: Print-Agent Reachability Warn-Only Check

**Source: Phase 3 `_check_default_secrets` pattern extended to networking**

```python
# backend/app/__init__.py, in create_app() function, after _check_default_secrets()

def _check_print_agent_reachability(app):
    """Warn if print agent is unreachable; never block startup.
    
    Extends Phase 3's D-11/D-12 principle (warn-never-block for live bar safety)
    to external service health. Printing is fire-and-forget (CLAUDE.md Architecture);
    a staff member opening a table should not wait for print-agent health.
    """
    print_agent_url = os.environ.get('PRINT_AGENT_URL', 'http://localhost:9191')
    
    try:
        import requests
        response = requests.get(
            f"{print_agent_url}/health",
            timeout=3,
            allow_redirects=False
        )
        if response.status_code == 200:
            app.logger.info(f"Print agent reachable at {print_agent_url} [OK]")
            return
    except requests.exceptions.Timeout:
        app.logger.warning(f"Print agent at {print_agent_url} timed out (3s)")
    except requests.exceptions.ConnectionError as e:
        app.logger.warning(f"Print agent at {print_agent_url} connection failed: {e}")
    except Exception as e:
        app.logger.warning(f"Print agent reachability check failed: {type(e).__name__}: {e}")
    
    # Log clear warning, but NEVER fail or delay startup
    app.logger.warning(
        f"[WARN] Print agent unreachable at {print_agent_url}. "
        f"Printing will fail until this is resolved. "
        f"Check: (1) Print-agent service is running, "
        f"(2) {print_agent_url} matches your PRINT_AGENT_URL env var, "
        f"(3) Windows Firewall allows access. "
        f"Continuing startup anyway (D-13: warn-never-block principle)."
    )

# Call this in create_app() after returning Flask app but before logging startup complete
_check_print_agent_reachability(app)
```

**Phase 4 Validation:**
- Start backend with print-agent down → expect WARNING in logs, backend healthy
- Start backend with print-agent up → expect INFO, no warning
- Unified `check-health.ps1` reports print-agent as unreachable but doesn't fail overall POS status

---

## State of the Art

| Old Approach (Docker) | Current Approach (Native Windows Services) | When Changed | Impact |
|---|---|---|---|
| All-or-nothing container orchestration (docker-compose restart restarts everything) | Independent service crash-restart via NSSM `AppExit Default Restart` | Phase 2 implementation | Fixes SUP-01: one service crash no longer cascades; enables true process isolation |
| Check `/api/v1/health` with bare HTTP 200 (no DB verification) | `/api/v1/health` performs real `SELECT 1` against Postgres | Phase 4 (this phase) | Fixes SUP-04: prevents "process running but DB dead" false negatives |
| Implicit print-agent reachability via `host.docker.internal` networking | Explicit warn-on-startup check for print-agent `/health` endpoint | Phase 4 (this phase) | Fixes NET-02: operator is notified at startup if print-agent is unreachable, vs. silent failure hours later |
| Scatter per-service health checks in docs/runbooks | Unified `check-health.ps1` rollup script with single PASS/FAIL output | Phase 4 (this phase) | Fixes SUP-04 operationally: one command tells operator whether POS is truly up |
| Implicit dependency order via service install scripts | Explicit Windows Service Manager `DependOnService` chains + real boot validation (D-09) | Phase 2 implementation, Phase 4 validation | Ensures Postgres starts before backend (SUP-02) even after power loss |

**Deprecated/outdated:**
- `docker-compose` orchestration → NSSM service wrapping (Phase 2 migration complete)
- Print-agent reachability via Docker networking → Direct `localhost:9191` with explicit health check (Phase 2/4)
- Flask gunicorn (multi-worker or default sync) → Direct `wsgi.py` single-process eventlet (Phase 2, unchanged from Docker's single-worker constraint)

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | NSSM `AppExit Default Restart` + `AppRestartDelay` configuration is sufficient for SUP-01 (independent service restart) | Crash-Restart Pattern | If NSSM restart is slow or fails silently, crash-isolation proof (D-10) would fail; staging validation would catch this, but real bar would be affected |
| A2 | Windows Service Manager `DependOnService` enforces startup order even after power loss (not just graceful restarts) | Dependency-Ordering Pattern | If dependency chain is ignored on boot, Postgres might start after backend, causing connection timeouts; real reboot test (D-09) verifies this |
| A3 | `/api/v1/health` endpoint with `SELECT 1` is sufficient to detect Postgres connection-pool exhaustion | Deepened Health-Check | If SELECT 1 doesn't trigger the failure condition, a more sophisticated check might be needed (e.g., actually opening a new connection pool slot) |
| A4 | APScheduler BlockingScheduler's responsiveness can be assessed via Windows `Get-Service` status alone (no HTTP listener needed) | Service Responsiveness Pattern | If scheduler is stuck in a job and unresponsive but process still running, `Get-Service` would report Running even though it's hung; Phase 4 validation should include scheduler test (run daily-report via API + verify it completes) |
| A5 | Print-agent `/health` endpoint exists and is reachable via `http://localhost:9191` | Print-Agent Check | If print-agent doesn't expose `/health` or listens on a different URL, the reachability check fails or gives false negatives; staging validation confirms endpoint exists |
| A6 | Native PostgreSQL Windows service (installed by Phase 2) needs crash-restart configuration equivalent to NSSM services for SUP-01 parity | Postgres Service Supervision | If native Postgres service has no restart-on-failure policy, a Postgres crash would not auto-restart; Phase 4 D-40 investigates whether `sc.exe failure` config is needed |
| A7 | Eventlet single-worker constraint (no raw `threading.Thread`, only `socketio.start_background_task`) is still enforced in `backend/wsgi.py` and native service entry | Eventlet Verification | If someone adds `threading.Thread` or multi-process forking, Socket.IO stops working but the error is silent (messages don't broadcast); grep audit + service entry code review catches this |
| A8 | Ghost-ticket state-desync root cause is specifically in the ticket-open transaction window (resource.status update not atomic with ticket creation) | Ghost-Ticket Root Cause | If root cause is elsewhere (e.g., a race condition in timer-session cleanup), the proposed transaction-wrapping fix wouldn't solve it; code audit (D-04) verifies this hypothesis |

**Items needing user confirmation before locked decision:**
- A1, A2: Staging reboot test (D-09) + crash test (D-10) confirm these; no user input needed
- A4: Scheduler responsiveness check should include actual daily-report execution, not just `Get-Service Running`
- A6: Postgres service restart configuration is in "Claude's Discretion" — may or may not be needed, TBD after investigation

---

## Open Questions (RESOLVED)

1. **Does the native PostgreSQL Windows service need explicit `sc.exe failure` configuration?**
   - What we know: Phase 2 installed Postgres via EDB installer (native Windows service). Phase 2 scripts do not configure failure recovery for Postgres, unlike NSSM services which have `AppExit Default Restart` + `AppRestartDelay`.
   - What's unclear: Whether native Postgres service auto-restarts on crash, or requires manual restart. Windows services can be configured to restart on failure via `sc.exe failure <service>`, but this is separate from the NSSM pattern.
   - Recommendation: During Phase 4 implementation, check current Postgres service failure recovery policy via `sc.exe qfailure PostgreSQL15` (or equivalent) and add config if missing for SUP-01 parity.
   - RESOLVED: Confirmed as a genuine gap — Phase 2 left Postgres without failure-recovery config. Addressed in Plan 04-03 Task 2 (`scripts/configure-postgres-failure-recovery.ps1`), which applies `sc.exe failure` parity with the NSSM restart behavior.

2. **What's the exact transaction scope that prevents ghost tickets?**
   - What we know: The ticket-open flow spans: lock resource → create ticket → flush → update resource.status → create timer → commit. A crash between flush and commit leaves state inconsistent.
   - What's unclear: Is wrapping all these steps in one `db.session.commit()` sufficient, or is there a nested flush that could fail mid-sequence? Does the existing `was_reopened` F-1 fix guard against a different desync scenario?
   - Recommendation: D-04 investigation should trace the exact code path and identify the smallest atomic unit that must succeed together (i.e., the `db.session.commit()` boundary).
   - RESOLVED: Investigation (carried out during planning) found every current code path that frees a resource already commits the ticket-state change and resource-status change atomically in one `db.session.commit()` — `request_payment` is the one intentional, guarded exception. The fix is therefore a structural backstop, not a transaction patch: Plan 04-01 Task 3 adds deferred (`DEFERRABLE INITIALLY DEFERRED`) DB-level constraint triggers on `tickets`/`resources` as a last-line invariant.

3. **Should scheduler/bot responsiveness checks include actual job execution verification?**
   - What we know: D-02 accepts Windows `Get-Service Running` status as the responsiveness signal for scheduler/bot (no HTTP listener). But a process can be running and stuck in a long-running job (or in an infinite loop).
   - What's unclear: Is `Get-Service Running` sufficient for operational "is scheduler working?", or should the health-check script actually trigger a test job and verify completion?
   - Recommendation: For Phase 4 MVP, `Get-Service Running` is acceptable. A future phase (OPX-01 v2) could add actual job-execution verification (e.g., trigger `daily-report` via backend API and confirm it completes within N seconds).
   - RESOLVED: Phase 4 MVP scope confirmed — `Get-Service Running` is the accepted signal, implemented in Plan 04-03 Task 1 (`scripts/check-health.ps1`). Actual job-execution verification is explicitly deferred, not part of this phase's requirements (SUP-04 is satisfied by process-responsiveness, not job-completion, checks).

4. **What's the print-agent's actual `/health` endpoint contract?**
   - What we know: `scripts/install-all-native-services.ps1:636-642` already tries to probe `http://localhost:9191/health`. Phase 3 may have documented or validated this endpoint.
   - What's unclear: Does `/health` actually exist in the current print-agent code? What status codes does it return (200 ok, 503 unhealthy, etc.)?
   - Recommendation: Before D-12 implementation, verify print-agent codebase has `/health` endpoint. If not, either add it or modify the check to probe a different endpoint (e.g., `/printers` or `GET / 200`).
   - RESOLVED: Addressed by Plan 04-01 Task 2 (backend-side warn-only startup probe of the print-agent, following the `_check_default_secrets()` never-block pattern) and validated live in Plan 04-04, which installs the print-agent on staging for the first time and captures real evidence of the endpoint's actual behavior.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| NSSM 2.24 | Service wrapping (SUP-01/02/03) | ✓ (Phase 2 installs) | 2.24 | — |
| PostgreSQL 15 | Database (all services) | ✓ (Phase 2 native install) | 15.x | — |
| Python 3.11 | Backend/scheduler/bot runtime | ✓ (staging machine) | 3.11+ | Python 3.9+ (per requirements.txt) |
| nginx 1.x | Frontend reverse proxy | ✓ (Phase 2 install) | 1.25+ | Caddy (but Phase 2 chose nginx) |
| Windows 11 | Native service host | ✓ (staging machine WIDOWSVAIL) | 11 | — |
| PowerShell | Health-check scripting | ✓ (Windows built-in) | 5.1+ | — |
| curl or Invoke-WebRequest | HTTP health probes | ✓ (built-in or via winget) | — | — |
| Print-agent (external) | NET-02 reachability check | ? (depends on staging setup) | [TBD] | Can skip print-agent on staging; health-check warns but continues |

**Missing dependencies with no fallback:** None critical to Phase 4 validation.

**Missing dependencies with fallback:** Print-agent may not be running on staging machine (not required for Phase 2 reboot validation); health-check script should handle this gracefully (warn, not fail overall).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | PowerShell manual test steps + Python pytest for backend health-check |
| Config file | `.planning/phases/04-process-supervision-reliability-hardening/04-TESTING.md` (to be created during planning) |
| Quick run command | `.\scripts\check-health.ps1` (unified health rollup) |
| Full suite command | `Restart-Computer -Force` on staging, then verify all services + run `.\scripts\check-health.ps1` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | Manual Steps |
|--------|----------|-----------|-------------------|--------------|
| SUP-01 | Individual service crash auto-restarts without affecting others | integration | `Stop-Process -Force <backend-pid>; Wait 5s; Get-Service BilliardBarScheduler` (verify Running) | Kill each service's process one at a time, confirm others unaffected |
| SUP-02 | Services start in correct dependency order at boot | integration | (requires real boot) | `Restart-Computer -Force` on staging, monitor service startup times via `Get-Service` loop |
| SUP-03 | All services auto-start after reboot/power-loss | integration | (requires real boot) | Same as SUP-02: restart, verify all 6 services Running post-boot |
| SUP-04 | Health-check confirms responsiveness not just process existence | unit/integration | `Invoke-RestMethod http://localhost:5000/api/v1/health; $resp.db -eq 'connected'` | Kill Postgres, verify health returns 503 |
| NET-02 | Print-agent unreachability triggers startup warning | unit | (requires code review of backend startup) | Verify warning in logs when print-agent is down |
| DATA-02 | Ghost-ticket root cause identified + fix implemented | code-review | Grep `backend/app/api/tickets.py` for transaction atomicity, review `was_reopened` guard | Manual: trace ticket-open code path, verify atomic commit boundary |
| DATA-03 | Eventlet single-worker constraint verified under native hosting | code-review + grep | `grep -r "threading\.Thread" backend/; grep -r "socketio.start_background_task" backend/` | Verify `service_entry.py` and `wsgi.py` run single-process, no forking |

### Sampling Rate

- **Per task commit:** N/A (Phase 4 is infrastructure validation, not feature development)
- **Per wave merge:** Run full staging validation (reboot + crash isolation tests)
- **Phase gate:** All 7 requirements (SUP-01 through DATA-03) must show PASS before `/gsd:verify-work` can proceed

### Wave 0 Gaps

- [ ] `scripts/check-health.ps1` — unified health rollup script (D-03)
- [ ] Backend `/api/v1/health` deepened with DB check (D-01)
- [ ] Backend startup print-agent reachability warning (D-12/D-13)
- [ ] Ghost-ticket root-cause investigation + fix (D-04)
- [ ] DATA-03 verification note (eventlet single-worker grep + service entry audit)
- [ ] Phase 4 TESTING.md with exact test steps for D-09, D-10, D-11

All above are implementation tasks, not missing test framework. No pytest/vitest gaps.

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | (auth unchanged from Phase 3) |
| V3 Session Management | No | (session handling unchanged from Phase 3) |
| V4 Access Control | No | (access control unchanged; ghost-ticket fix is data integrity, not access control) |
| V5 Input Validation | No | (input validation unchanged from Phase 3) |
| V6 Cryptography | No | (cryptography unchanged from Phase 3) |
| V7 Error Handling & Logging | Yes | Health-check errors logged; print-agent warnings logged to centralized log (Phase 3 LOG-01); avoid logging secrets in error messages |
| V11 Business Logic | Yes | Ghost-ticket fix prevents business logic violation (can't have OPEN ticket on AVAILABLE resource) |
| V12 File Upload | No | (not in scope) |
| V13 API & Web Service | Yes | `/api/v1/health` must not leak sensitive info in error responses (e.g., database version, connection string); error details should be generic |

### Known Threat Patterns for Windows Services Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Service crash → manual restart intervention | Availability | NSSM `AppExit Default Restart` (D-01) prevents manual intervention |
| Print-agent network unreachability blocks operations | Availability | Warn-only check (D-13) prevents blocking; operators notified via log |
| Ghost-ticket state corruption corrupts revenue data | Integrity | Atomic DB transaction + constraint (D-04) prevents state desync |
| Health-check endpoint leaks Postgres connection details in errors | Information Disclosure | Error responses must be generic (e.g., "DB unreachable") not reveal connection strings or internal details |
| Postgres crash → no auto-restart → manual recovery | Availability | Investigate native Postgres service failure recovery policy (D-40) |
| Service dependency chain misconfigured → wrong startup order | Availability | Real reboot test (D-09) confirms DependOnService chain works |
| Backend crashes mid-health-check response → partial response received | Availability | Health-check should be idempotent and fast; `SELECT 1` cannot partially succeed |

---

## Sources

### Primary (HIGH confidence)
- [CITED: nssm.cc/usage] — NSSM AppExit configuration, restart throttling, and registry-based failure recovery setup
- [CITED: learn.microsoft.com/windows/win32/services] — Windows Service Control Manager DependOnService ordering, auto-start behavior, START_PENDING timeouts
- [CITED: apscheduler.readthedocs.io] — APScheduler BlockingScheduler and monitoring challenges (no built-in health/responsiveness signals)
- [CITED: flask-socketio.readthedocs.io/deployment] — Single eventlet worker requirement for gunicorn with Socket.IO; cannot use multiple workers
- [CITED: postgresql.org/docs/current/ddl-constraints.html] — PostgreSQL CHECK constraints and trigger-based referential integrity
- Phase 2 CONTEXT.md and existing Phase 2 install scripts (verified in repo): NSSM configuration, venv setup, DependOnService chains already implemented

### Secondary (MEDIUM confidence)
- [CITED: dev.to, medium.com on postgres ACID] — PostgreSQL transaction atomicity and crash recovery via write-ahead logging
- [CITED: learn.microsoft.com/answers] — ServicesPipeTimeout registry key for extending service startup timeouts
- Existing codebase: `backend/app/__init__.py:1024-1027` (bare health endpoint), `backend/app/__init__.py:1032+` (_check_default_secrets pattern), `backend/app/api/tickets.py:1345-1410` (existing ghost-ticket cleanup and `was_reopened` guard)

### Tertiary (LOW confidence — require validation)
- `scripts/print_agent/print_agent.py` — assumed `/health` endpoint exists; not verified in this research
- Postgres native Windows service failure recovery — assumed not configured; Phase 4 D-40 investigates via `sc.exe qfailure`
- Windows service restart timing and ServicesPipeTimeout behavior on this specific hardware — will be validated during D-09 reboot test

---

## Metadata

**Confidence breakdown:**
- **NSSM crash-restart & dependency ordering:** HIGH — NSSM documentation is clear; Phase 2 implementation verified in repo; Windows Service Manager behavior well-documented
- **Health-check patterns:** HIGH — REST API design well-established; database connectivity check is standard practice
- **Eventlet single-worker constraint:** HIGH — Flask-SocketIO documentation explicitly states `-w 1` requirement; gunicorn documentation confirms multi-worker incompatibility
- **Ghost-ticket root cause & fix:** MEDIUM — Code path is clear from reading `tickets.py`, but exact transaction boundary and whether atomicity fix is sufficient requires implementation validation
- **APScheduler responsiveness without HTTP listener:** MEDIUM — Documentation confirms BlockingScheduler has no built-in health signal; using `Get-Service Running` is pragmatic but not perfect (can't detect hung jobs)
- **Windows service reboot behavior on this specific staging hardware:** LOW — will be confirmed by actual reboot test (D-09); timing and dependency ordering may vary based on machine specs

**Research date:** 2026-08-09  
**Valid until:** 2026-09-09 (30 days; NSSM/Windows services are stable; can extend if no changes to Phase 2 install scripts)

---

**Research complete. Ready for planning.**

# Phase 4: Process Supervision & Reliability Hardening - Pattern Map

**Mapped:** 2026-08-09
**Files analyzed:** 5 primary (1 new, 4 modified)
**Analogs found:** 5/5

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/check-health.ps1` | utility/script | request-response | `scripts/health-check.ps1` + `scripts/install-all-native-services.ps1:620-642` | excellent |
| `backend/app/__init__.py` (health endpoint) | config/endpoint | request-response | `backend/app/__init__.py:1024-1027` | exact-same-file |
| `backend/app/__init__.py` (print-agent startup check) | config/initialization | initialization | `backend/app/__init__.py:1032-1089` (`_check_default_secrets`) | role-match |
| `backend/app/api/tickets.py` (ghost-ticket fix) | controller/api | CRUD | `backend/app/api/tickets.py:155-240` + `:1345-1413` | same-file |
| `scripts/install-postgres-native.ps1` (failure recovery) | utility/installer | configuration | `scripts/install-nssm-backend.ps1:180-200` | role-match |
| Verification document (DATA-03 eventlet audit) | documentation/audit | documentation | `.planning/codebase/CONCERNS.md` + Phase 2 `02-CONTEXT.md:DATA-03` | reference-doc |

---

## Pattern Assignments

### `scripts/check-health.ps1` (utility, request-response)

**Purpose:** Unified health-check rollup script (D-03) that polls all 6 services and reports single PASS/FAIL summary.

**Primary Analogs:**
1. `scripts/health-check.ps1` (existing Docker-based script)
2. `scripts/install-all-native-services.ps1:620-642` (existing verification checks)

**PowerShell function pattern** (from `install-all-native-services.ps1:600-615`):
```powershell
# Test helper function — reusable pattern for service/endpoint status checks
function Test-WindowsServiceHealthy {
    param([string]$ServiceName)
    try {
        $svc = Get-Service -Name $ServiceName -ErrorAction Stop
        return $svc.Status -eq "Running"
    } catch {
        return $false
    }
}
```

**HTTP probe pattern** (from `install-all-native-services.ps1:625-630`):
```powershell
# Test backend reachability via /api/v1/health endpoint (D-01 deepened version)
$nginxOk = $false
try {
    $r = Invoke-WebRequest -Uri "http://localhost:8080/" -TimeoutSec 5 -UseBasicParsing
    $nginxOk = $r.Content -match '<div id="root">'
} catch {}
Add-Result -Id "SVC-03-http" -Label "nginx serving frontend" -Pass $nginxOk -Detail "HTTP GET /"
```

**Print-agent check pattern** (from `install-all-native-services.ps1:634-642`):
```powershell
# Print agent reachability — warn-only per D-13
$printAgentOk = $false
try {
    $null = Invoke-RestMethod -Uri "http://localhost:9191/health" -TimeoutSec 5
    $printAgentOk = $true
} catch {}
if ($printAgentOk) {
    Add-Result -Id "NET-01" -Label "Print agent reachable" -Pass $true -Detail "HTTP GET /health"
} else {
    Write-WarnLine "NET-01: print agent not reachable (expected if not running on staging)"
}
```

**Result table formatting** (from `install-all-native-services.ps1:646-653`):
```powershell
Write-Host ("Requirement / Check".PadRight(48) + "Result") -ForegroundColor Cyan
Write-Host ("-" * 70) -ForegroundColor Cyan
foreach ($res in $results) {
    $status = if ($res.Pass) { "PASS" } else { "FAIL" }
    $color  = if ($res.Pass) { "Green" } else { "Red" }
    Write-Host ("  [{0}] {1,-8} {2}" -f $res.Id, $status, $res.Label) -ForegroundColor $color
}
```

**Key pattern notes:**
- Use error-handling with try/catch and `$null` assignment for side-effect-only operations
- Build results array (`@()`) then iterate for final output, not inline printing
- Separate "critical failures" from "warnings" in final exit code (exit 1 if critical, exit 0 if warnings only)

---

### `backend/app/__init__.py` - Health Endpoint Deepening (D-01)

**Current code** (lines 1024-1027):
```python
@app.route('/api/v1/health')
def health():
    return {'status': 'ok'}  # ← Bare HTTP 200; lies if DB is down
```

**Deepened implementation pattern** (from research 04-RESEARCH.md§"Example 2"):
```python
from sqlalchemy import text
from datetime import datetime, timezone

@app.route('/api/v1/health')
def health():
    """Health check that verifies database connectivity.
    
    Catches failure mode: backend process running but database connection
    pool exhausted or Postgres down. This is SUP-04's responsiveness gate.
    """
    try:
        # Real database check: will fail if connection pool exhausted,
        # Postgres is down, or network is broken.
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

**Key pattern:**
- Import `text` from `sqlalchemy` for raw SQL queries
- Use `db.session.execute(text('SELECT 1'))` + `db.session.commit()` for actual connection test
- Return 200 on success, 503 on failure (standard HTTP status for service unavailable)
- Log error details for debugging without leaking them to client

---

### `backend/app/__init__.py` - Print-Agent Reachability Check (D-12/D-13)

**Analog:** `_check_default_secrets()` function (lines 1032-1089)

**Pattern extraction from existing function** (lines 1032-1044):
```python
def _check_default_secrets(app):
    """Warn (never fail) if any in-scope secret is still at its known-insecure
    default value.

    D-11: this is a live bar's POS — a hard startup failure risks blocking
    operation until someone with machine access intervenes, so this function
    only ever logs/prints a loud warning. It must never terminate the process
    or raise; it performs no I/O beyond reading already-loaded config/env.

    D-12: runs once, from create_app(), so every entrypoint that builds the
    Flask app (service_entry.py, scheduler.py, the `flask` CLI) gets the same
    check for free.
    """
    warnings = []
    # ... build warnings array ...
    if warnings:
        warning_msg = (
            'INSECURE DEFAULT SECRET(S) DETECTED — change these before real use:\n  '
            + '\n  '.join(warnings)
        )
        app.logger.warning(warning_msg)
        print('\n' + '=' * 70)
        print(warning_msg)
        print('=' * 70 + '\n')
        # D-11: this function never terminates the process — warn only, service keeps starting.
```

**New print-agent check, following same pattern** (to insert near line 1025, after `_check_default_secrets(app)`):
```python
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
        pass  # Fall through to warning
    except requests.exceptions.ConnectionError:
        pass  # Fall through to warning
    except Exception:
        pass  # Fall through to warning
    
    # Log clear warning, but NEVER fail or delay startup
    app.logger.warning(
        f"[WARN] Print agent unreachable at {print_agent_url}. "
        f"Printing will fail until this is resolved. "
        f"Check: (1) Print-agent service is running, "
        f"(2) {print_agent_url} matches your PRINT_AGENT_URL env var, "
        f"(3) Windows Firewall allows access. "
        f"Continuing startup anyway (D-13: warn-never-block principle)."
    )

# In create_app(), call this after _check_default_secrets():
_check_default_secrets(app)
_check_print_agent_reachability(app)
```

**Key pattern:**
- Catch all exceptions, never raise
- Log at INFO level on success, WARNING on failure
- Clearly state in logs why failure is not fatal and what operator should check
- Return silently (no return value needed) — side effects are the logs

---

### `backend/app/api/tickets.py` - Ghost-Ticket Root-Cause Fix (D-04/D-05)

**Existing ghost-ticket cleanup** (lines 1345-1413, with `was_reopened` F-1 guard at line 1384):
```python
@tickets_bp.route('/clean-ghosts', methods=['POST'])
@jwt_required()
def clean_ghost_tickets():
    """Manager: auto-close all OPEN tickets whose resource is already AVAILABLE (true ghosts)."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    # ... build ghost query ...
    ghosts = (Ticket.query
              .join(Resource, Resource.id == Ticket.resource_id)
              .filter(
                  Ticket.status == 'OPEN',
                  Resource.status == 'AVAILABLE',
                  Ticket.payment_requested.is_(False),
                  Ticket.was_reopened.isnot(True),  # ← F-1 fix: guard against false positives
                  ~has_active_item,
                  ~has_timer_session,
              )
              .with_for_update()
              .all())
    
    # Close ghosts in a single transaction
    for ticket in ghosts:
        ticket.status = 'CLOSED'
        # ... other state updates ...
    db.session.commit()  # ← Single commit for all updates
```

**Ticket open flow** (lines 155-240), showing the crash window:
```python
@tickets_bp.route('/', methods=['POST'])  # at line 155
@jwt_required()
def open_ticket():
    # ... validation ...
    
    # CRITICAL SECTION: multi-table atomicity risk
    resource = Resource.query.with_for_update().get(resource_id)  # Line 189: lock
    if resource.status == 'IN_USE':
        return jsonify({'error': 'RESOURCE_OCCUPIED'}), 409
    
    ticket = Ticket(resource_id=resource_id, ...)  # Line 196: create ticket object
    db.session.add(ticket)
    db.session.flush()  # Line 199: flush to DB — ticket ID is now assigned
    
    resource.status = 'IN_USE'  # Line 202: update resource status (still in memory)
    
    if resource.type == 'POOL_TABLE':
        timer = PoolTimerSession(ticket_id=ticket.id, ...)  # Lines 210-217
        db.session.add(timer)
    
    # ... waiting list assignment ...
    
    db.session.commit()  # Line 238: ← CRASH WINDOW: if crash @ 7, ticket exists but resource.status not yet IN_USE
    _emit_floor_update()
    return jsonify(ticket.to_dict()), 201
```

**Pattern for root-cause investigation (from D-05 directive):**

1. **Already-present guard:** The `was_reopened` flag at line 1384 prevents cleaning recently-reopened tickets (the F-1 fix).
2. **Gap to investigate:** Whether the atomicity window spans the entire sequence (lines 189-238), or if there are nested flushes that could fail mid-sequence.
3. **Proposed fix approach:** Wrap the entire multi-table update (ticket creation + resource state update + timer creation) in a single transaction, eliminating the flush/commit gap.

**Atomic transaction pattern** (conceptual; exact implementation depends on investigation):
```python
# Option A: Database-level constraint (if investigation shows constraint is feasible)
# In backend/app/__init__.py's init_db STEP blocks, add idempotent:
ALTER TABLE tickets ADD CONSTRAINT chk_ticket_resource_consistency
  CHECK (
    (status != 'OPEN') OR 
    (resource_id IS NULL) OR 
    (status = 'CLOSED')
  );
-- Then add trigger to enforce: if ticket.status = 'OPEN', resource.status must be 'IN_USE'

# Option B: Application-level atomic transaction (if constraint is not feasible)
# Modify open_ticket() to ensure single commit:
def open_ticket():
    resource = Resource.query.with_for_update().get(resource_id)
    if resource.status == 'IN_USE':
        return jsonify({'error': 'RESOURCE_OCCUPIED'}), 409
    
    ticket = Ticket(...)
    db.session.add(ticket)
    # Remove flush() before resource.status update — let them batch to one commit
    
    resource.status = 'IN_USE'
    
    if resource.type == 'POOL_TABLE':
        timer = PoolTimerSession(ticket_id=ticket.id, ...)
        db.session.add(timer)
    
    # Single commit covers all: ticket creation + resource update + timer creation
    db.session.commit()  # No flush before this
```

**Key pattern notes:**
- Phase 4's investigation must read both the current open_ticket flow (lines 155-240) and clean_ghost_tickets (lines 1345-1413)
- The `was_reopened` flag (line 1384) is already a partial guard that must remain in place
- D-06 (HARD CONSTRAINT): Never add a plan step that runs cleanup against the live bar; staging validation only
- Document residual risks explicitly after fix is implemented

---

### `scripts/install-postgres-native.ps1` - Failure Recovery Configuration

**Analog:** NSSM failure recovery patterns from Phase 2 install scripts

**Pattern from `install-nssm-backend.ps1:198-200`:**
```powershell
# Restart policy: restart on failure after 5s
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000
```

**Windows native service failure recovery equivalent** (to investigate + add in Phase 4):
```powershell
# For native PostgreSQL service (not NSSM-wrapped), use sc.exe to configure failure recovery
# This achieves SUP-01 parity with NSSM services (auto-restart on crash).

# First, discover the actual PostgreSQL service name (may vary: "PostgreSQL15", "postgresql-15", etc.)
$PgService = Get-Service -Name "*postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($PgService) {
    $ServiceName = $PgService.Name
    Write-Host "Configuring failure recovery for PostgreSQL service: $ServiceName" -ForegroundColor Cyan
    
    # Configure: restart after 5 seconds, max 3 restart attempts
    # sc failure <service> reset= <time> actions= <action1>/<delay1>/<action2>/<delay2>/...
    # Valid actions: RUN_PROGRAM, RESTART, REBOOT; delays in milliseconds
    & sc.exe failure $ServiceName reset= 3600 actions= restart/5000/restart/5000/restart/5000
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   Postgres failure recovery configured: restart within 5s on crash" -ForegroundColor Green
    } else {
        Write-Host "   ⚠ Failed to configure Postgres failure recovery (non-fatal, service can still run)" -ForegroundColor Yellow
    }
} else {
    Write-Host "   ⚠ PostgreSQL service not found (may not be installed yet)" -ForegroundColor Yellow
}
```

**Key pattern notes:**
- Use `Get-Service -Name "*postgresql*"` with wildcard to discover service name (can vary by installer version)
- `sc.exe failure` syntax: `sc failure <service> reset= <timeout_seconds> actions= <action>/<delay_ms>/<action>/<delay_ms>/...`
- `reset=3600` means the failure counter resets after 1 hour (if service stays up that long, next crash starts the retry sequence over)
- Multiple restart actions allow graceful degradation: try 3 times, then give up (prevents infinite restart loop if Postgres is fundamentally broken)

---

## Shared Patterns

### Authentication & Authorization (applies to all controller/API files)

**Existing pattern** (from `backend/app/api/tickets.py:155-158`):
```python
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt

@tickets_bp.route('/', methods=['POST'])
@jwt_required()
def open_ticket():
    claims = get_jwt()
    user_id = get_jwt_identity()
    role = claims.get('role')
    if role not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
```

**Apply to:** Any new controller routes in this phase — use `@jwt_required()`, check `claims.get('role')`, return 403 on denial.

### Database Locking Pattern (for any ticket/resource mutations)

**Existing pattern** (from `backend/app/api/tickets.py:189`):
```python
resource = Resource.query.with_for_update().get(resource_id)
if resource is None:
    return jsonify({'error': 'NOT_FOUND'}), 404
```

**Apply to:** Any modification to resource or ticket state — always lock the row with `with_for_update()` before checking state, to prevent race conditions.

### Error Response Format (consistent across all endpoints)

**Existing pattern** (from `backend/app/api/tickets.py:193-194`):
```python
return jsonify({
    'error': 'RESOURCE_OCCUPIED',
    'message': f'{resource.code} ya está en uso'
}), 409
```

**Apply to:** All new error responses — use `'error': UPPER_SNAKE_CODE` for frontend matching, `'message'` for user-facing Spanish/English text.

### Logging Pattern (warn-never-block for live bar)

**Existing pattern** (from `backend/app/__init__.py:1078-1089`, `_check_default_secrets`):
```python
if warnings:
    app.logger.warning(warning_msg)
    print('\n' + '=' * 70)
    print(warning_msg)
    print('=' * 70 + '\n')
    # Never raise or exit; service keeps starting
```

**Apply to:** Any startup checks or health-related code — log warnings clearly, never block startup.

---

## Files with No Close Analog

| File | Role | Reason |
|------|------|--------|
| Verification document (DATA-03 eventlet audit) | documentation | No existing audit document; will reference existing codebase structure from Phase 2 and grep for patterns, but creating a new verification note |

---

## Metadata

**Analog search scope:**
- `scripts/` directory — all PowerShell install and utility scripts
- `backend/app/` — Flask app initialization and configuration
- `backend/app/api/` — API controllers (tickets, resources, etc.)
- `.planning/codebase/` — existing architecture and concerns documentation

**Files scanned:** 20+ PowerShell scripts, 5+ Python Flask modules, 3+ planning documents

**Pattern extraction date:** 2026-08-09

**Search confidence:**
- PowerShell health-check patterns: HIGH (existing scripts provide exact templates)
- Flask health endpoint pattern: HIGH (exact analog exists in current codebase)
- Print-agent startup check pattern: HIGH (`_check_default_secrets` is direct analog)
- Ghost-ticket fix pattern: MEDIUM (investigation required; `clean_ghost_tickets` shows cleanup, but root-cause fix approach TBD)
- Postgres failure recovery pattern: MEDIUM-HIGH (NSSM patterns are clear, native Postgres translation is straightforward but requires Windows Service Manager knowledge)

---

## Cross-File Consistency Notes

1. **PowerShell error handling:** All scripts use `$ErrorActionPreference = "Continue"` to avoid premature termination on non-fatal stderr from native CLIs.
2. **Python imports at top of file:** Both `__init__.py` and `tickets.py` follow the pattern of importing at module level, then using locals within functions.
3. **Single-commit semantics:** All transaction-critical code (ticket open, ghost cleanup) batches updates into one `db.session.commit()` to ensure atomicity.
4. **Logging consistency:** Flask uses `app.logger` for JSON-structured logs; PowerShell uses `Write-Host` with color codes for terminal output.


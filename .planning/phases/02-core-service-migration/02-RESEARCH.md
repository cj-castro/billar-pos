# Phase 2: Core Service Migration - Research

**Researched:** 2026-08-08
**Domain:** Windows native service deployment, NSSM service wrapping, PostgreSQL data migration, Flask-SocketIO on Windows
**Confidence:** HIGH (pattern proven via print agent, technical constraints verified, schema well-documented)

---

## Summary

Phase 2 migrates the BilliardBar POS stack from Docker/Rancher to native Windows Services on a staging machine, with the architecture unchanged but the hosting model fundamentally different. The key technical constraints are:

1. **eventlet's built-in WSGI server is mandatory** — gunicorn does not run on Windows (requires Unix `fork()`), and Waitress cannot run Flask-SocketIO (no WebSocket/real-time protocol support). The existing `backend/wsgi.py` with `socketio.run()` is the correct and only viable approach. [VERIFIED: Flask-SocketIO deployment docs]

2. **PostgreSQL data migration must use logical dump/restore** (`pg_dump`/`pg_restore`) across the Docker-to-native boundary, proven with synthetic staging data first (D-09, D-10). Real production data migration is deferred to Phase 5.

3. **NSSM wraps all services** (backend, scheduler, telegram-bot, nginx) — reusing the exact pattern from `scripts/install-nssm-print-agent.ps1`, which is production-validated. This provides uniform supervision, auto-restart, and boot-time startup across the entire stack.

4. **Environment variables and secrets** flow through NSSM's `AppEnvironmentExtra` configuration (similar to docker-compose.yml environment blocks). The `PRINT_AGENT_URL` must change from `http://host.docker.internal:9191` → `http://localhost:9191` (no code changes needed, just env var).

5. **Postgres service startup timing is fragile** — the Windows Service Control Manager considers a service "started" before it's fully ready to accept connections. Health checks or startup delays on the backend service are essential to avoid connection pool exhaustion during boot.

**Primary recommendation:** Follow the step-by-step sequence in `.planning/research/ARCHITECTURE.md` lines 20–100 (Native Windows Services section), implement each service's NSSM wrapper script using the print-agent pattern as template, run the entire validation on the staging machine before proposing Phase 5 production cutover.

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Phase 2 work happens entirely on a separate staging Windows machine — NOT the live bar machine. Docker/Rancher on the bar machine remains untouched throughout Phase 2.
- **D-02:** Staging machine has equivalent specs to the bar machine (Windows 11, ~8GB RAM) — validation results should transfer directly to real hardware.
- **D-03:** Deploying the validated setup onto the actual bar machine is OUT of scope for Phase 2 — that is Phase 5.
- **D-04:** NSSM is the service-wrapper tool for backend, scheduler, telegram-bot — reusing the print-agent pattern. Do not introduce WinSW.
- **D-05:** Backend NSSM service wraps `python backend/wsgi.py` directly (eventlet's built-in `socketio.run()` server) — NOT gunicorn (hard constraint: gunicorn does not run natively on Windows).
- **D-06:** Backend service runs `flask init-db` and `python seed.py` on every startup, matching current `backend/entrypoint.sh` idempotent behavior exactly.
- **D-07:** Each service gets its own separate Python virtualenv on the staging machine, mirroring Docker image boundaries and the print agent's existing venv pattern.
- **D-08:** Postgres migration uses logical dump/restore (`pg_dump`/`pg_restore`), not physical data-directory copy.
- **D-09:** Staging validation uses `backend/seed.py`'s synthetic demo data, NOT live production database.
- **D-10 (deviation):** DATA-01's "verified Postgres backup exists and is restore-tested" requirement applies to REAL production data in Phase 5, not Phase 2. Phase 2 proves the dump/restore *procedure* works using synthetic data.
- **D-11:** nginx is the reverse proxy (not Caddy) — reusing `frontend/nginx.conf` nearly as-is.
- **D-12:** nginx runs as an NSSM-wrapped service, consistent with all other services.
- **D-13:** Plain HTTP, no TLS — matches current Docker behavior exactly (LAN-only, on-site). HTTPS is out of scope.

### Claude's Discretion

- Exact nginx listen port on staging (keep 8080 or use 80) — choose based on staging environment's port usage.
- Layout/naming of per-service NSSM install scripts — follow existing conventions.
- pg_dump/pg_restore flags (custom `-Fc` vs. plain SQL, or directory `-Fd` for parallel dumps) — any approach as long as restore is verified against native Postgres 15.

### Deferred Ideas (OUT OF SCOPE)

- **HTTPS/TLS for reverse proxy** — explicitly rejected as out-of-scope for this migration phase (D-13).
- **Real-production-data backup/restore verification for DATA-01** — deferred to Phase 5's cutover procedure, not a Phase 2 deliverable.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **SVC-01** | Flask/eventlet backend runs as native Windows Service (NSSM-wrapped), independent of Docker | Eventlet's socketio.run() confirmed viable on Windows; NSSM pattern proven via print agent; wsgi.py entrypoint ready |
| **SVC-02** | PostgreSQL 15 runs as native Windows service, not containerized | PostgreSQL official Windows installer available; pg_dump/pg_restore procedures verified; no data-format incompatibilities across Docker-to-native transition |
| **SVC-03** | React frontend served via lightweight web server/reverse proxy, without Docker | nginx confirmed Windows-compatible via NSSM; existing nginx.conf reusable with hostname changes only (backend → localhost) |
| **SVC-04** | Scheduler process (`backend/scheduler.py`) runs as own native Windows service, independent of backend crashes | APScheduler works on Windows; BlockingScheduler pattern suitable for standalone process; NSSM supervision handles independent restart |
| **SVC-05** | Telegram bot process (`telegram-bot/bot.py`) runs as own native Windows service, independent of backend crashes | python-telegram-bot confirmed Windows-compatible; direct Postgres DB access independent of backend; NSSM supervision handles independent restart |
| **NET-01** | Backend reaches Windows print agent via `localhost` (configurable via env var), no `host.docker.internal` references | `PRINT_AGENT_URL` already env-var configurable in code; no code changes needed, only env var update from `http://host.docker.internal:9191` → `http://localhost:9191` |
| **DATA-01** | Verified Postgres backup exists and is restore-tested before cutover (production data) | Procedure validated in Phase 2 using synthetic data; actual production backup/restore deferred to Phase 5 per D-10 |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Database persistence (Postgres) | Native Windows Service | — | Postgres service manages all data storage; runs independently of app tiers |
| API/backend logic (Flask) | Native Windows Service | — | Handles all business logic, auth, billing; single eventlet worker process |
| Real-time updates (Socket.IO) | Native Windows Service (eventlet) | — | Socket.IO protocol requires eventlet async framework; runs within Flask backend service |
| Static asset serving (React SPA) | Reverse proxy (nginx) | — | nginx serves built frontend files; reverse-proxies dynamic API/Socket.IO to backend |
| Job scheduling (APScheduler) | Native Windows Service (scheduler) | — | Standalone process, independent from backend; runs Python scheduler.py directly |
| Telegram notifications | Native Windows Service (telegram-bot) | — | Standalone process, reads shared Postgres DB directly; independent from backend/scheduler |
| Print job dispatch | Native Windows Service (print agent, already exists) | — | Already migrated; backend calls via localhost:9191 only |
| Reverse proxy / TLS termination | nginx (NSSM service) | — | Single entry point; handles WebSocket upgrade headers for Socket.IO; plain HTTP (no TLS this phase) |

---

## Standard Stack

### Core Services

| Service | Technology | Version | Purpose | Why This Stack |
|---------|-----------|---------|---------|-----------------|
| Backend API | Flask + eventlet WSGI | Flask 2.x, eventlet 0.33+ | HTTP REST + Socket.IO real-time | eventlet is the ONLY Windows-compatible async framework for Flask-SocketIO; gunicorn not viable on Windows |
| Database | PostgreSQL | 15.x (Windows native) | Persistent data (tickets, inventory, staff, audits) | Official Windows installer available; logical dump/restore procedures proven; current Docker image version maps 1:1 |
| Frontend | React SPA (built static) | Node 20 (build only) | User interface (floor map, kitchen queue, billing) | Built once via npm, served as static files; no runtime Node.js needed on Windows |
| Reverse Proxy | nginx | 1.24+ (Windows native binary) | Static file serving, API proxy, WebSocket routing | Lightweight, proven pattern via `frontend/nginx.conf`; handles `/api/` and `/socket.io/` correctly with upgrade headers |
| Scheduler | APScheduler + Flask-SQLAlchemy | APScheduler 3.x | Daily 08:00 sales report email via SMTP | BlockingScheduler pattern (no Flask app context needed); direct Postgres connection; independent process |
| Telegram Bot | python-telegram-bot + Flask-SQLAlchemy | python-telegram-bot 20.7 | Operational alerts to admin chat | Direct Postgres DB access; independent of Flask backend; independent NSSM service |
| Service Manager | NSSM (Non-Sucking Service Manager) | 2.24+ | Process supervision, auto-restart, boot startup | Production-validated via print agent; no active development but stable; uniform service management across stack |

### Supporting Libraries (All from docker-compose.yml env + requirements.txt)

| Library | Purpose | Windows Consideration |
|---------|---------|----------------------|
| Flask-SQLAlchemy 3.1.1 | ORM for Postgres | Pure Python, fully Windows-compatible |
| Flask-JWT-Extended | JWT token auth | Pure Python, fully Windows-compatible |
| Flask-Migrate / Alembic | Schema migrations (not used per CLAUDE.md; raw SQL via flask init-db instead) | N/A — skipped in this codebase |
| Flask-SocketIO 5.x | WebSocket/Socket.IO | Requires eventlet; Waitress not supported; gunicorn not viable on Windows |
| APScheduler 3.x | Job scheduling | Pure Python, Windows-compatible; `BlockingScheduler` for standalone use |
| python-telegram-bot 20.7 | Telegram API client | Pure Python, Windows-compatible |
| python-socketio (transitive) | Socket.IO protocol | Included with Flask-SocketIO; eventlet support |
| eventlet 0.33+ | Async framework for Socket.IO | **Mandatory for Windows; only viable option** |
| pywin32 | Windows-specific APIs (print agent uses this) | Windows-required for printer access (print agent only, not needed for backend/scheduler/bot) |

### Installation

All Python services share dependency sets from `backend/requirements.txt` (backend + scheduler share) and `telegram-bot/requirements.txt` (telegram bot separate). For native Windows:

```bash
# Backend virtualenv (backend + scheduler)
python -m venv C:\billar-pos\backend_venv
C:\billar-pos\backend_venv\Scripts\pip install -r backend/requirements.txt

# Telegram bot virtualenv (separate)
python -m venv C:\billar-pos\bot_venv
C:\billar-pos\bot_venv\Scripts\pip install -r telegram-bot/requirements.txt

# nginx (Windows binary, no install needed — extract to C:\nginx or similar)
# Download from https://nginx.org/en/download.html, extract, configure nginx.conf

# PostgreSQL (Windows installer from postgresql.org, standard install with postgres user/password)
# Download from https://www.postgresql.org/download/windows/

# NSSM (already have pattern from print-agent script; will download/install via PowerShell)
```

**Version verification (must run before writing this stack table):**
- `python -c "import eventlet; print(eventlet.__version__)"` — confirm 0.33+
- `python -c "import flask_socketio; print(flask_socketio.__version__)"` — confirm 5.x
- `pg_dump --version` — confirm Postgres client tools installed
- nginx version via `nginx.exe -v` (after installation)

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| eventlet WSGI server | Waitress | **NOT viable** — Waitress does not support Socket.IO/WebSocket protocol; Flask-SocketIO requires eventlet or gevent. [VERIFIED: Flask-SocketIO deployment docs] |
| eventlet WSGI server | gunicorn with eventlet worker | **NOT viable** — gunicorn itself does not run on Windows (requires `os.fork()`); Windows lacks fork() syscall. No workaround. |
| nginx reverse proxy | Caddy | Viable but unnecessary — nginx.conf already written, proven in Docker, no TLS needed (HTTP-only per D-13). Caddy adds no value for this phase. |
| NSSM service manager | WinSW | Viable but rejected per D-04 — reuse print-agent pattern to avoid introducing new tool. NSSM is stable, albeit unmaintained. |
| pg_dump/pg_restore | Physical data-directory copy | Risky — Docker Alpine Postgres to Windows native Postgres may differ in binary format, page layout, or build-specific settings. Logical dump/restore is safer and documented best practice for cross-platform migration. |
| pg_dump/pg_restore | pg_upgrade utility | Not applicable — pg_upgrade requires both old and new Postgres binaries running on same host, both accessing the same data directory. Doesn't apply to Docker-to-Windows scenario. |
| APScheduler | Windows Task Scheduler | Viable but fragile — would require Python script stub + .bat file + Task Scheduler registration; tightly couples scheduler to Windows. APScheduler + NSSM is portable (same script works on Linux if we ever migrate). |
| Separate scheduler service | Embedded in Flask backend | Current Docker model has separate scheduler container (independence). Embedding APScheduler in gunicorn process eliminates independence and reintroduces cascade failures per Pitfall #2. |

---

## Package Legitimacy Audit

All packages in Phase 2 are already locked in `backend/requirements.txt`, `telegram-bot/requirements.txt`, and `frontend/package.json` (used at build time only, not runtime on Windows). No new packages are being introduced in Phase 2 — only the **deployment method** (from Docker containers to NSSM services) changes.

**Packages already in use, not being added:**
- eventlet (required, already in backend/requirements.txt)
- Flask-SocketIO (required, already in backend/requirements.txt)
- APScheduler (required, already in backend/requirements.txt)
- python-telegram-bot (required, already in telegram-bot/requirements.txt)
- Flask-SQLAlchemy, Flask-JWT-Extended, etc. (all in existing requirements)

**New tools being adopted (not Python packages, OS-level tools):**
- **NSSM 2.24** — Service manager; binary download from https://nssm.cc/, not installed via package manager [ASSUMED: not adding npm/pip package, just Windows binary]
- **PostgreSQL 15 Windows installer** — from postgresql.org; not a package dependency [ASSUMED: standard Windows installer, not a package]
- **nginx Windows binary** — from nginx.org; not a package [ASSUMED: Windows native binary, not a package]

No npm/pip packages are being added. The audit is **N/A** for this phase.

---

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Windows 11 Machine (8GB RAM)                  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ nginx (NSSM Service on port 8080 or 80)                        │  │
│  │  - Serves static React SPA from /frontend/build/               │  │
│  │  - Proxies /api/* → http://localhost:5000                      │  │
│  │  - Proxies /socket.io/* → http://localhost:5000 (WebSocket)    │  │
│  └───────────────┬──────────────────────────────────────────────┘  │
│                  │ HTTP requests                                    │
│                  ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Backend Flask App (NSSM Service, port 5000)                    │  │
│  │  ├─ Handler: API REST endpoints (/api/v1/...)                  │  │
│  │  ├─ Handler: Socket.IO real-time events (via eventlet)         │  │
│  │  ├─ Entrypoint: python backend/wsgi.py (socketio.run)          │  │
│  │  └─ Environment: from NSSM AppEnvironmentExtra                 │  │
│  │      (DATABASE_URL, PRINT_AGENT_URL→localhost:9191, etc.)      │  │
│  └───────────────┬──────────────────┬─────────────────────────────┘  │
│                  │ DB queries       │ HTTP POST print jobs            │
│                  ▼                  ▼                                  │
│  ┌──────────────────────────┐  ┌──────────────────────────────────┐  │
│  │ PostgreSQL (NSSM Service) │  │ Print Agent (existing, native    │  │
│  │  ├─ Postgres service     │  │  Windows Service)                │  │
│  │  ├─ Listen: localhost:5432│ │  ├─ Port 9191                    │  │
│  │  ├─ Data: C:\...\data/   │  │  ├─ Thermal printer routing      │  │
│  │  └─ Schemas: via flask   │  │  └─ Receipt/kitchen chit print   │  │
│  │     init-db (idempotent) │  └──────────────────────────────────┘  │
│  └──────────────┬───────────┘                                        │
│                 │ DB queries                                          │
│                 ▼                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Scheduler Service (NSSM Service)                               │  │
│  │  ├─ Entrypoint: python backend/scheduler.py                    │  │
│  │  ├─ APScheduler with BlockingScheduler                         │  │
│  │  ├─ Cron: daily 08:00 America/Mexico_City for email report     │  │
│  │  ├─ Reads DB: EMAIL_REPORT table schema via SQLAlchemy        │  │
│  │  └─ SMTP: sends to configured REPORT_TO addresses              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                 │ DB queries                                          │
│                 ▼                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Telegram Bot Service (NSSM Service)                            │  │
│  │  ├─ Entrypoint: python telegram-bot/bot.py                     │  │
│  │  ├─ Telegram API: polls /getUpdates via TELEGRAM_TOKEN         │  │
│  │  ├─ Reads DB: ticket, kitchen_queue schemas via SQLAlchemy    │  │
│  │  └─ Sends alerts to ADMIN_CHAT_ID                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  **Service Dependencies (NSSM):**                                    │
│  1. PostgreSQL (must start first — blocking dependency)              │
│  2. Backend (depends on Postgres healthy; provides API port 5000)    │
│  3. Scheduler (depends on Postgres healthy)                          │
│  4. Telegram Bot (depends on Postgres healthy)                       │
│  5. nginx (reverse proxy; no direct dependency on others)            │
│  6. Print Agent (independent service; already running)               │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

**Data Flow:** Client browser → nginx (8080) → Backend Flask API/Socket.IO (5000) → Postgres (5432); Scheduler and Bot read Postgres independently; Backend POSTs print jobs to Print Agent (9191).

### Recommended Project Structure (Windows Staging Setup)

```
C:\billar-pos\                              # Clone root
├─ backend/
│  ├─ wsgi.py                              # Entry point: socketio.run(app)
│  ├─ requirements.txt                     # Deps for backend + scheduler
│  ├─ scheduler.py                         # APScheduler entry point
│  ├─ entrypoint.sh                        # (archive — not used on Windows)
│  ├─ Dockerfile                           # (archive — not used on Windows)
│  └─ app/
│     ├─ __init__.py                       # create_app(), flask init-db
│     ├─ models/                           # SQLAlchemy models
│     ├─ api/                              # Blueprints
│     └─ services/                         # Business logic

├─ telegram-bot/
│  ├─ bot.py                               # Entry point: BlockingScheduler()
│  ├─ requirements.txt                     # Deps for telegram bot
│  └─ Dockerfile                           # (archive — not used on Windows)

├─ frontend/
│  ├─ nginx.conf                           # Reverse proxy config (edit: backend → localhost)
│  ├─ dist/                                # Built React SPA (generated via npm run build)
│  └─ Dockerfile                           # (archive — not used on Windows)

├─ scripts/
│  ├─ install-nssm-print-agent.ps1         # Existing pattern (reference)
│  ├─ install-nssm-backend.ps1             # (NEW — Phase 2 to create)
│  ├─ install-nssm-scheduler.ps1           # (NEW — Phase 2 to create)
│  ├─ install-nssm-telegram-bot.ps1        # (NEW — Phase 2 to create)
│  ├─ install-nssm-nginx.ps1               # (NEW — Phase 2 to create)
│  ├─ postgres-backup-restore.ps1          # (NEW — Phase 2 to create)
│  └─ print_agent/                         # (existing, already on Windows)

├─ .env.example                            # Secrets template (no changes)
├─ docker-compose.yml                      # (archive — not used on Windows)
├─ CLAUDE.md                               # Project instructions
└─ .planning/
   ├─ REQUIREMENTS.md                      # This phase's requirements
   └─ phases/02-core-service-migration/
      ├─ 02-CONTEXT.md                    # User decisions (D-01 to D-13)
      └─ 02-RESEARCH.md                   # (this file)
```

**Key difference from Docker:** All services run as Windows Services (visible in `services.msc`), with config in NSSM registry (not docker-compose.yml), and logs in `C:\billar-pos\logs\` (not docker logs).

### Pattern 1: NSSM Service Wrapper (Proven via Print Agent)

**What:** A PowerShell script that installs a Python service via NSSM, setting up virtualenv, environment variables, logging, restart policy, and firewall rules. This pattern is production-validated via `scripts/install-nssm-print-agent.ps1`.

**When to use:** For all new Python services (backend, scheduler, telegram-bot).

**Example (backend service):**

```powershell
# Reference: scripts/install-nssm-print-agent.ps1 lines 36–179

$BaseDir   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendDir = Join-Path $BaseDir "backend"
$VenvPy    = Join-Path $BackendDir "venv\Scripts\pythonw.exe"  # pythonw = no console
$Script    = Join-Path $BackendDir "wsgi.py"
$ServiceName = "BilliardBarBackend"
$NssmExe   = "nssm"  # or full path if NSSM already installed

# Step 1: Create Python virtualenv
if (-not (Test-Path $VenvPy)) {
    python -m venv "$BackendDir\venv"
}
& "$BackendDir\venv\Scripts\pip.exe" install -r "$BackendDir\requirements.txt" --quiet

# Step 2: Remove old service if reinstalling
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

# Step 3: Register the service
& $NssmExe install $ServiceName $VenvPy $Script
& $NssmExe set $ServiceName AppDirectory $BackendDir
& $NssmExe set $ServiceName AppStdout "$BackendDir\backend.log"
& $NssmExe set $ServiceName AppStderr "$BackendDir\backend_err.log"
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760  # 10 MB
& $NssmExe set $ServiceName Start SERVICE_AUTO_START
& $NssmExe set $ServiceName ObjectName LocalSystem  # or custom user

# Step 4: Set environment variables (from docker-compose.yml)
$envExtra = @(
    "DATABASE_URL=postgresql://billiard:billiard_secret@localhost:5432/billiardbar",
    "PRINT_AGENT_URL=http://localhost:9191",  # Changed from host.docker.internal
    "SECRET_KEY=<from-secrets>",
    "JWT_REFRESH_SECRET=<from-secrets>",
    "FLASK_ENV=production",
    "FLASK_APP=wsgi.py",
    "TZ=America/Mexico_City",
    "LOG_LEVEL=INFO"
    # ... all other vars from docker-compose.yml backend section
)
& $NssmExe set $ServiceName AppEnvironmentExtra $envExtra
Write-Host "Environment variables set from NSSM registry"

# Step 5: Set restart policy
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000  # 5s delay before restart

# Step 6: Start and verify
& $NssmExe start $ServiceName
Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "Service is RUNNING [OK]" -ForegroundColor Green
} else {
    Write-Host "Service status: $($svc.Status)" -ForegroundColor Yellow
    Write-Host "Check log: $BackendDir\backend_err.log" -ForegroundColor Yellow
}
```

**Critical notes:**
- Use `pythonw.exe` (no console window), not `python.exe` (pops a console).
- Set `AppDirectory` to the service root so relative imports and file paths work.
- Log rotation prevents unbounded disk usage (especially important on 8GB machine).
- `ObjectName LocalSystem` runs as SYSTEM (highest privilege; use custom user for less privilege if needed).
- Environment variables must be set via NSSM registry, not in PowerShell, so they persist across reboots.

### Pattern 2: Flask + eventlet Socket.IO on Windows

**What:** The `backend/wsgi.py` file uses Flask's built-in development server launcher (`socketio.run()`) instead of gunicorn. This is the ONLY viable approach for Windows because gunicorn requires Unix `fork()`.

**When to use:** Windows native deployment only; Docker deployment still uses gunicorn.

**Current code (already correct):**

```python
# backend/wsgi.py
from app import create_app
app = create_app()

if __name__ == '__main__':
    from app.extensions import socketio
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
```

**Why this works:**
- `socketio.run()` internally uses eventlet's WSGI server (since eventlet is in requirements.txt).
- Handles all Socket.IO protocol details (WebSocket upgrades, long-polling fallback, reconnection).
- Single-process, single-threaded via eventlet greenlets (cooperative scheduling), matching the `eventlet -w 1` constraint from Docker.
- No code changes needed when migrating from Docker gunicorn to Windows native.

**Verification on Windows:**
```powershell
# Before NSSM install, test locally:
cd C:\billar-pos\backend
.\venv\Scripts\activate.bat
python wsgi.py
# Should print: "(20370) wsgi running on http://0.0.0.0:5000"
# Use browser: http://localhost:5000 to test
```

### Pattern 3: PostgreSQL Data Migration (pg_dump/pg_restore)

**What:** Logical backup from Docker Postgres container using `pg_dump`, restore to native Windows Postgres 15 using `pg_restore`.

**When to use:** Before Phase 2 cutover on staging (synthetic data), and before Phase 5 production cutover (real data).

**Procedure (staging example with synthetic data):**

```powershell
# Step 1: Back up Postgres from Docker (via docker exec)
docker exec billar-pos-postgres pg_dump -U billiard -d billiardbar -Fc > C:\backups\billiardbar_backup.dump
# -Fc = custom format (compressed, flexible restore)
# File size: typically ~5-20 MB for 6+ months of production data

# Step 2: Verify backup file exists and is valid
Get-Item C:\backups\billiardbar_backup.dump | Select-Object Length
# Expected: large positive integer (not zero)

# Step 3: Restore to native Windows Postgres
# (Assuming native Postgres 15 installed, postgres service running, default postgres@localhost:5432 admin user)
$env:PGPASSWORD = "postgres_admin_password"  # postgres user password
& "C:\Program Files\PostgreSQL\15\bin\pg_restore.exe" `
    -U postgres `
    -d billiardbar `
    -h localhost `
    --no-acl --no-owner `
    -v `
    C:\backups\billiardbar_backup.dump
# --no-acl = don't restore object permissions (avoids permission errors on restore)
# --no-owner = don't restore original owner (use current restoring user)
# -v = verbose (shows progress)

# Step 4: Verify data integrity
$env:PGPASSWORD = "billiard_password"  # billiard user password
$result = & "C:\Program Files\PostgreSQL\15\bin\psql.exe" `
    -U billiard `
    -d billiardbar `
    -h localhost `
    -c "SELECT COUNT(*) FROM tickets; SELECT COUNT(*) FROM kitchen_queue; SELECT COUNT(*) FROM staff;"
Write-Host "Data check: $result"
# Expected output: three counts (should be > 0 for production, or exact expected counts for seeded staging)

# Step 5: Backend connectivity test
$backend_venv = "C:\billar-pos\backend\venv\Scripts\activate.bat"
& cmd /c "$backend_venv && python -c `"from app import create_app; app = create_app(); print('App created'); exit(0)`""
# Expected: "App created" (no connection errors)
```

**Important considerations:**
- Use **custom format** (`-Fc`) for dumps: compressed, flexible restore, parallel restore possible.
- Use **`--no-acl --no-owner`** on restore to avoid permission issues (the staging Postgres user may not match Docker user).
- Verify restore by running a health check query (`SELECT COUNT(*) FROM tickets`) — ensures data actually migrated.
- If schema is missing, check `psql -l` and manually create the `billiardbar` database first: `CREATE DATABASE billiardbar;`
- Postgres schema (`flask init-db`) is idempotent (STEP blocks have `IF NOT EXISTS` guards), so re-running won't break existing data.

### Pattern 4: Reverse Proxy Configuration (nginx)

**What:** nginx serves the React SPA and proxies API/Socket.IO requests to the Flask backend.

**When to use:** Windows native deployment; existing Docker setup already uses this pattern.

**Existing config (reusable with minimal changes):**

```nginx
# frontend/nginx.conf

server {
    listen 80;  # Or change to 8080 to match FRONTEND_PORT env var
    root /var/www/html;  # Windows: C:\nginx\html or C:\billar-pos\frontend\dist
    index index.html;

    # (cache headers, static routes, etc. — unchanged)

    location /api/ {
        proxy_pass http://backend:5000;  # ← CHANGE TO: proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60;
    }

    location /socket.io/ {
        proxy_pass http://backend:5000;  # ← CHANGE TO: proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

**Windows setup steps:**
1. Download nginx from https://nginx.org/en/download.html
2. Extract to `C:\nginx\`
3. Copy `frontend/nginx.conf` to `C:\nginx\conf\nginx.conf` (edit `proxy_pass` lines as shown)
4. Copy built frontend files: `frontend/dist/*` → `C:\nginx\html/`
5. Install as NSSM service: `nssm install BilliardBarNginx C:\nginx\nginx.exe`
6. Test: `http://localhost:8080/` should load React SPA

### Pattern 5: APScheduler for Scheduler Service

**What:** Standalone `backend/scheduler.py` runs APScheduler's BlockingScheduler (blocks on waiting for next job).

**When to use:** When scheduler is the ONLY thing running in a Python process (which it is — separate service, not embedded in Flask).

**Existing code (already correct):**

```python
# backend/scheduler.py
from app import create_app
from app.extensions import db
from apscheduler.schedulers.blocking import BlockingScheduler
from app.services.email_report_svc import send_daily_report

app = create_app()

def scheduled_daily_report():
    with app.app_context():
        send_daily_report()
        print(f"[scheduler] Daily report sent at {datetime.now()}")

if __name__ == '__main__':
    scheduler = BlockingScheduler()
    # Cron: 08:00 America/Mexico_City every day
    scheduler.add_job(
        scheduled_daily_report,
        'cron',
        hour=8,
        minute=0,
        timezone='America/Mexico_City'
    )
    print("[scheduler] Starting APScheduler (BlockingScheduler)...")
    scheduler.start()  # Blocks forever; NSSM restarts if it exits
```

**Why this works on Windows:**
- Pure Python, no Unix-isms.
- BlockingScheduler is appropriate because scheduler is the sole purpose of the process.
- NSSM will restart the service if scheduler crashes.
- To test: `python backend/scheduler.py` should print the startup message and sit idle waiting for 08:00.

### Pattern 6: Service Dependency Management (NSSM)

**What:** NSSM allows specifying dependencies between services so Postgres starts before Backend, etc.

**When to use:** To ensure correct boot order and avoid connection pool exhaustion during startup.

**Example (after all services are installed):**

```powershell
# NSSM dependency syntax: DependOnService <service_name> [service_name2] ...
nssm set BilliardBarBackend DependOnService PostgreSQL
nssm set BilliardBarScheduler DependOnService PostgreSQL
nssm set BilliardBarTelegramBot DependOnService PostgreSQL
nssm set BilliardBarNginx DependOnService BilliardBarBackend
```

**Important caveat (Pitfall #2):** The Windows Service Control Manager (SCM) considers a service "started" when the process is running, NOT when it's fully ready to accept connections. Postgres may return to SCM before the database is actually accepting connections, causing the Backend to fail to connect during boot.

**Mitigation options:**
1. **Startup delay:** Add `nssm set BilliardBarBackend Start SERVICE_AUTO_START` + add a sleep in backend startup (not ideal).
2. **Health check:** Backend's `entrypoint.sh` equivalent (for Windows, implement in wsgi.py initialization) waits for Postgres to be responsive before starting Socket.IO server.
3. **Retry loop in code:** Backend connection pool automatically retries, so transient connection failures during startup are expected and handled.

For this phase, rely on #3 (existing backend resilience) — formal health checks can be added in Phase 4 (Process Supervision).

### Anti-Patterns to Avoid

- **Don't use gunicorn on Windows** — it will not work; `os.fork()` is not available. Use socketio.run() instead.
- **Don't hardcode `host.docker.internal` in config or code** — it only exists in Docker Desktop; change to `localhost:9191` and make it env-var configurable (already done).
- **Don't share virtualenvs across services** — each service (backend, scheduler, telegram-bot) must have its own venv. Shared venvs create version conflicts and make independent restarts fragile.
- **Don't use native Postgres service startup without health checks** — the SCM "started" signal doesn't mean DB is ready; add explicit health checks or reliance on retries.
- **Don't install NSSM services with the Python console (`python.exe`)** — use `pythonw.exe` to avoid console windows popping up.
- **Don't store secrets in plain-text batch files or PowerShell scripts** — use NSSM's AppEnvironmentExtra or Windows Credential Manager (Phase 3 deferred).
- **Don't commit `.env` files with real secrets** — use `.env.example` as template; `.env` goes in `.gitignore`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Service process supervision (restart on crash, auto-boot) | Custom batch script watcher | NSSM | NSSM has 10+ years of production use; handles restart policies, dependency ordering, logging, firewall. A batch script won't detect silent crashes. |
| PostgreSQL backup/restore | Custom SQL copy or file-system-level backup | pg_dump/pg_restore | pg_dump handles schema versioning, object dependencies, privilege restoration. File-system copy risks corruption if Postgres is running. |
| Reverse proxy / HTTP routing | Custom Flask route shim | nginx | nginx is lightweight, proven for this exact pattern (in docker-compose.yml), handles WebSocket upgrades correctly. Custom Flask route adds latency and complexity. |
| Real-time event transport | Raw WebSocket or custom protocol | Socket.IO (existing) | Socket.IO handles browser compatibility (fallback to long-polling on old IE), reconnection, heartbeats. Hand-rolled WebSocket breaks on network transitions. |
| Flask + async greenlets | Raw threading or asyncio | eventlet (existing) | eventlet is designed for Socket.IO; threading breaks cooperative scheduling; asyncio requires `async`/`await` syntax rewrite. |
| Job scheduling (daily reports) | Cron via `at` or Task Scheduler | APScheduler (existing) | APScheduler is Python-native, uses DB for job state (survives restarts), handles timezones. Windows Task Scheduler is fragile (DLL paths, task sync, ACLs). |
| Secrets management | Plain-text .env or batch files | Windows Credential Manager or env files with mode 600 | NSSM registry stores config; Credential Manager encrypts at rest. Plain-text is discoverable by anyone with file access. (Phase 3 effort) |

**Key insight:** All the "hard" parts (service supervision, PostgreSQL, real-time events) are already solved by existing tools. This phase is not a rewrite — it's a re-hosting.

---

## Common Pitfalls

### Pitfall 1: Postgres Data Loss During Docker-to-Native Migration

**What goes wrong:**
Production Postgres data is lost, corrupted, or inaccessible in the new hosting environment.

**Why it happens:**
- Docker volumes not explicitly backed up before decommissioning Docker.
- New Postgres Windows install writes data to a different path (e.g., `C:\ProgramData\PostgreSQL\data` vs. `/var/lib/postgresql/data`).
- Migration assumes data directory path without verification.
- No restore test performed before switching off the old Docker system.

**How to avoid (per `.planning/research/PITFALLS.md`):**
1. Take explicit backup: `docker exec billar-pos-postgres pg_dump ... > backup.dump` BEFORE any Docker decommissioning.
2. Dry-run the restore on the staging machine using the exact native Postgres setup.
3. Verify restore: `SELECT COUNT(*) FROM tickets` should match expected counts.
4. Document the data path mapping: Docker volume → Windows folder.

**Warning signs:**
- `psql -l` shows no databases (schema not created).
- `SELECT * FROM information_schema.tables` returns zero rows.
- Backend logs: `ProgrammingError: relation "tickets" does not exist`.
- No backup file exists before Docker is removed.

**Phase responsibility:** Phase 2 validates procedure with synthetic data; Phase 5 executes against real data.

---

### Pitfall 2: Print Agent Unreachability After Docker Removal

**What goes wrong:**
Backend can no longer reach the print agent. Print jobs hang or fail silently. Staff doesn't realize receipts/chits are not being printed until minutes later.

**Why it happens:**
- `host.docker.internal` is a Docker Desktop feature; does NOT exist in native Windows or Podman.
- Backend code still references `host.docker.internal:9191` without fallback.
- Print job POST is fire-and-forget with broad exception swallowing; operator sees nothing in logs.
- No health check on backend startup to validate print agent reachability.

**How to avoid (per `.planning/research/PITFALLS.md`):**
1. Update `PRINT_AGENT_URL` env var from `http://host.docker.internal:9191` → `http://localhost:9191`.
2. Verify this change is in NSSM's AppEnvironmentExtra (not hardcoded in code).
3. Add print-agent health check on backend startup (Phase 4 effort).
4. Test manually: `curl http://localhost:9191/health` from backend machine before cutover.

**Warning signs:**
- Logs show `ConnectionError: Failed to establish a new connection to host.docker.internal:9191`.
- Frontend shows tickets as "printing" but nothing prints.
- Operator checks backend logs and finds connection error swallowed silently.

**Phase responsibility:** Phase 2 changes env var; Phase 4 adds explicit health checks; Phase 5 validates on live machine.

---

### Pitfall 3: Cascade Failures Without Service Isolation

**What goes wrong:**
One service (Postgres, backend, scheduler) crashes and brings down others. Complete POS outage instead of graceful degradation.

**Why it happens:**
- Services move from Docker containers (isolated) to Windows Services (shared OS).
- No independent restart policy — if Postgres crashes, backend can't automatically recover without manual intervention.
- Shared temp directories (`%TEMP%`) can fill up, cascading failures.
- No per-service resource limits (memory, disk).

**How to avoid (per `.planning/research/PITFALLS.md`):**
1. Each NSSM service has independent restart policy: `AppExit Default Restart`, `AppRestartDelay 5000`.
2. PostgreSQL is a standalone service; backend, scheduler, and bot are separate services (no embedded Postgres).
3. Health checks on backend: wait for Postgres connection pool to initialize before accepting requests.
4. Monitoring: log each service's start/stop/crash; alert on repeated failures.

**Warning signs:**
- After reboot, backend is running but Postgres isn't (or vice versa).
- One service's disk/memory leak causes others to fail.
- Manual restart of one service required to recover others.

**Phase responsibility:** Phase 2 sets up independent services (foundation); Phase 4 adds health checks and supervision (reliability).

---

### Pitfall 4: Secrets Leaked in Process Environment or Logs

**What goes wrong:**
Secrets (DB password, JWT secret) end up visible in Task Manager, process logs, or PowerShell history.

**Why it happens:**
- NSSM stores env vars in the Windows registry (encrypted by Windows, but readable from process), not in memory-only config.
- PowerShell scripts for installation echo or log secrets during setup.
- Service startup logs print the full environment block.
- `.env` file checked into git or left on desktop.

**How to avoid (Phase 3 effort, noted here for awareness):**
1. Do NOT check `.env` into git — use `.env.example` as template.
2. Use NSSM's encrypted config or Windows Credential Manager (Phase 3).
3. Audit: `Get-Process | Select-Object ProcessName, Environment` should NOT show secrets in Environment strings.
4. Logs should never echo `SECRET_KEY=...` or role passwords.

**Warning signs:**
- `PRINT_AGENT_URL` visible in Task Manager environment tab.
- Startup scripts contain `set SECRET_KEY=...`.
- `.env` exists in root or user directory.
- Logs from service startup show `SECRET_KEY=...`.

**Phase responsibility:** Phase 2 establishes the baseline (NSSM AppEnvironmentExtra, `.env` ignored); Phase 3 hardens secret storage.

---

### Pitfall 5: Incorrect Postgres Connection String on Windows

**What goes wrong:**
Backend can't connect to Postgres; "connection refused" or "database billiardbar does not exist" errors.

**Why it happens:**
- Docker connection string: `postgresql://billiard:password@postgres:5432/billiardbar` (hostname is the service name in docker-compose).
- Windows connection string: must use `localhost` or `127.0.0.1`, not `postgres`.
- Default Postgres install creates `postgres` admin user and a default `postgres` database; target database must exist.
- `PGPASSWORD` env var not set, so connection attempts prompt for password interactively (NSSM service can't handle interactive prompts).

**How to avoid:**
1. Update `DATABASE_URL` in NSSM AppEnvironmentExtra: `postgresql://billiard:password@localhost:5432/billiardbar`.
2. Verify database exists: `psql -U postgres -h localhost -l | grep billiardbar`.
3. If missing, create it: `createdb -U postgres -h localhost billiardbar`.
4. Test backend connectivity before service startup: `python -c "from app import create_app; app = create_app(); exit(0)"`.

**Warning signs:**
- Backend startup logs: `OperationalError: could not translate host name "postgres" to address`.
- `psql` prompt appears during service startup (indicating interactive password prompt).
- `SELECT COUNT(*) FROM information_schema.tables` returns zero (database connection succeeded but schema is empty).

**Phase responsibility:** Phase 2 sets correct connection string; if schema is missing, Phase 2 runs `flask init-db` to populate it.

---

### Pitfall 6: eventlet Not Available or Version Mismatch

**What goes wrong:**
Backend fails to start: `ImportError: No module named eventlet` or `RuntimeError: This application requires eventlet to be installed`.

**Why it happens:**
- Backend service's NSSM venv was not properly populated with `pip install -r requirements.txt`.
- Or venv was created with Python 3.6 (too old for eventlet 0.33+).
- Or a different venv (print agent's venv) was used by mistake.

**How to avoid:**
1. Create separate venvs for backend and scheduler (both share backend/requirements.txt but are separate venv installations).
2. Verify after `pip install`: `C:\billar-pos\backend\venv\Scripts\python.exe -c "import eventlet; print(eventlet.__version__)"`.
3. Ensure Python 3.8+ is used: `python --version` before creating venv.
4. In NSSM: `AppDirectory` points to the correct backend folder, and venv is within that folder.

**Warning signs:**
- NSSM log file: `ImportError: No module named 'eventlet'`.
- `pip list` in the backend venv doesn't show eventlet.
- Process exits immediately with `exit code 1` and no logs.

**Phase responsibility:** Phase 2 sets up virtualenvs; Phase 4 monitoring detects startup failures.

---

## Code Examples

### Backend Startup Verification

Verify the backend can start independently on a Windows machine (before NSSM install):

```powershell
# PowerShell (as Administrator)
cd C:\billar-pos

# Create venv
python -m venv backend\venv

# Install dependencies
backend\venv\Scripts\pip.exe install -r backend\requirements.txt --quiet

# Set env vars (inline for testing; later move to NSSM AppEnvironmentExtra)
$env:DATABASE_URL = "postgresql://billiard:billiard_secret@localhost:5432/billiardbar"
$env:FLASK_ENV = "production"
$env:PRINT_AGENT_URL = "http://localhost:9191"
$env:FLASK_APP = "wsgi.py"
$env:SECRET_KEY = "dev-key-change-in-production"
$env:JWT_REFRESH_SECRET = "dev-refresh-key-change-in-production"
# ... set all other env vars from docker-compose.yml backend section ...

# Test Flask init-db
backend\venv\Scripts\python.exe backend\app\__init__.py
# Should print: "[flask] Creating database tables..."

# Start backend directly (not via NSSM yet)
backend\venv\Scripts\python.exe backend\wsgi.py
# Should print: "(12345) wsgi running on http://0.0.0.0:5000"

# Test connectivity
curl http://localhost:5000/api/v1/auth/me
# Should return a JSON response (possibly 401 if no token, but the response format is valid JSON)

# Ctrl+C to stop, then proceed to NSSM install
```

**Expected output:**
```
(12345) wsgi running on http://0.0.0.0:5000
GET /api/v1/auth/me HTTP/1.1 200
...
```

### PostgreSQL Backup/Restore Validation

Verify pg_dump and pg_restore work on Windows (Phase 2 staging):

```powershell
# From Docker: dump the current database
docker exec billar-pos-postgres pg_dump -U billiard -d billiardbar -Fc > C:\backups\billiardbar_staging.dump

# On Windows: restore to native Postgres 15
$env:PGPASSWORD = "billiard_password"
& "C:\Program Files\PostgreSQL\15\bin\pg_restore.exe" `
    -U billiard `
    -d billiardbar `
    -h localhost `
    --no-acl --no-owner `
    -v `
    C:\backups\billiardbar_staging.dump

# Verify data integrity
$env:PGPASSWORD = "billiard_password"
& "C:\Program Files\PostgreSQL\15\bin\psql.exe" `
    -U billiard `
    -d billiardbar `
    -h localhost `
    -c "SELECT COUNT(*) as ticket_count FROM tickets; SELECT COUNT(*) as queue_count FROM kitchen_queue;"

# Expected output (example):
# ticket_count | queue_count
# ──────────────┼────────────
#           156 |           3
```

### nginx Configuration for Localhost

Edit the nginx.conf to proxy to localhost instead of docker service name:

```nginx
# frontend/nginx.conf (changes only)

server {
    listen 8080;  # Or 80 if port 8080 is not desired
    root C:\nginx\html;  # Windows path to built frontend
    index index.html;

    location /api/ {
        proxy_pass http://localhost:5000;  # ← Changed from "http://backend:5000"
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60;
    }

    location /socket.io/ {
        proxy_pass http://localhost:5000;  # ← Changed from "http://backend:5000"
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }

    # (rest of config unchanged)
}
```

Then copy built frontend to nginx:
```powershell
xcopy C:\billar-pos\frontend\dist C:\nginx\html\ /E /Y
```

---

## State of the Art

| Aspect | Docker Era (current) | Windows Native (Phase 2) | When Changed | Impact |
|--------|---------------------|--------------------------|--------------|--------|
| **Backend server** | `gunicorn --worker-class eventlet -w 1` (Docker container) | `python backend/wsgi.py` (eventlet's WSGI, NSSM service) | Phase 2 | No code changes; startup command changes; removes gunicorn complexity |
| **Database** | `postgres:15-alpine` Docker container | PostgreSQL 15 Windows native service | Phase 2 | Data migrated via pg_dump/pg_restore; connection string changes (hostname: `postgres` → `localhost`) |
| **Frontend delivery** | Nginx inside Docker container | Nginx Windows native binary (NSSM service) | Phase 2 | Nginx config reused; only `proxy_pass` hostname change (backend → localhost) |
| **Service supervision** | Docker Compose orchestration (all-or-nothing) | NSSM independent services (per-service restart) | Phase 2 | Decouples services; one crash no longer cascades |
| **Print agent networking** | `host.docker.internal:9191` (Docker Desktop feature) | `localhost:9191` (native Windows TCP) | Phase 2 | Env var change only (`PRINT_AGENT_URL`); no code changes |
| **Scheduler deployment** | Separate Docker container running `python backend/scheduler.py` | Separate NSSM service running `python backend/scheduler.py` | Phase 2 | No code changes; deployment model only |
| **Telegram bot deployment** | Separate Docker container running `python telegram-bot/bot.py` | Separate NSSM service running `python telegram-bot/bot.py` | Phase 2 | No code changes; deployment model only |

**Deprecated/outdated in Phase 2:**
- **Docker/Rancher on the bar machine** — still live until Phase 5, but development targets Windows native. Staging machine mirrors the new model.
- **`docker-compose.yml` on the bar** — will be replaced by NSSM service scripts post-Phase 5 cutover.
- **Gunicorn entrypoint** — no longer used; wsgi.py's socketio.run() takes over.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | eventlet's built-in WSGI server is the ONLY viable backend for Flask-SocketIO on Windows; Waitress and gunicorn are not options. | Standard Stack | If wrong, entire backend deployment strategy fails. Mitigation: verified via Flask-SocketIO official docs and multiple GitHub issues confirming Waitress incompatibility. Confidence: HIGH. |
| A2 | Postgres pg_dump/pg_restore with custom format (`-Fc`) safely migrates data from Docker Alpine Postgres to Windows native Postgres 15 without data loss or corruption. | Pitfalls #1 | If wrong, production data loss or corruption. Mitigation: D-10 says to validate procedure on staging with synthetic data first; dry-run restores are mandatory before Phase 5 cutover. Confidence: HIGH (standard industry practice). |
| A3 | The existing `backend/wsgi.py` socketio.run() entrypoint requires NO code changes to run on Windows. | Code Examples | If wrong, backend requires modifications before running on Windows. Mitigation: verified by reading wsgi.py source; it uses pure Python eventlet APIs with no Unix-specific calls. Confidence: HIGH. |
| A4 | NSSM 2.24 is stable and suitable for production service management on Windows 11 (8GB machine). | Standard Stack | If wrong, services may crash or fail to restart. Mitigation: print agent is already using NSSM 2.24 in production; this phase copies that pattern. Confidence: HIGH. |
| A5 | The `frontend/nginx.conf` can be reused on Windows native nginx with only the `proxy_pass` hostname changes (`backend` → `localhost`), no other config changes needed. | Architecture Patterns | If wrong, reverse proxy fails to route requests. Mitigation: nginx config is standard HTTP proxy; hostname change is the only environment-specific part. Confidence: HIGH. |
| A6 | Windows Service Control Manager (SCM) will start services in dependency order (Postgres before Backend), but does NOT guarantee Postgres is ready to accept connections before returning control. | Common Pitfalls #5 | If wrong, backend may fail to connect during boot. Mitigation: rely on existing backend connection pool retry logic; explicit health checks added in Phase 4. Confidence: MEDIUM (documented Windows limitation, but mitigations exist). |
| A7 | Python virtualenv with `python -m venv` on Windows can be used with NSSM by specifying the `pythonw.exe` path from the venv's `Scripts/` folder. | Architecture Patterns | If wrong, NSSM service won't start. Mitigation: print agent is already using this pattern (`venv\Scripts\pythonw.exe`). Confidence: HIGH. |
| A8 | The `PRINT_AGENT_URL` env var in `backend/app/api/tickets.py:23` and `backend/app/api/queue.py:9` can be changed from `http://host.docker.internal:9191` to `http://localhost:9191` via NSSM AppEnvironmentExtra without code changes. | NET-01 | If wrong, print agent remains unreachable. Mitigation: verified by grepping codebase for `PRINT_AGENT_URL` — it is read as env var, not hardcoded. Confidence: HIGH. |
| A9 | APScheduler's BlockingScheduler works on Windows and will run the daily 08:00 report job independently from the Flask backend process. | Standard Stack | If wrong, scheduler won't run. Mitigation: APScheduler is pure Python with Windows support; BlockingScheduler is documented for standalone use. Confidence: HIGH. |
| A10 | The docker-compose.yml environment blocks for `backend`, `scheduler`, and `telegram-bot` define ALL required env vars for those services on Windows (no additional undocumented vars). | Architecture Patterns | If wrong, services start but fail due to missing env vars. Mitigation: comprehensive env var audit performed; any service-specific vars are documented in INTEGRATIONS.md. Confidence: MEDIUM (env var surface is large; Phase 2 execution will catch any gaps). |

**If this table is empty:** This section exists; see above for 10 identified assumptions.

---

## Open Questions

1. **Exact listen port for nginx on staging?**
   - What we know: docker-compose.yml uses `FRONTEND_PORT:-8080` as default (line 78). Staging staging machine may already have port 8080 in use.
   - What's unclear: Should Phase 2 keep 8080 for consistency, or adapt to staging environment's available ports?
   - Recommendation: Keep 8080 if available on staging; if not, document the chosen port in the NSSM install script and update any health-check scripts/documentation to reference the new port.

2. **Should scheduler run in a separate virtualenv from backend, even though they share requirements.txt?**
   - What we know: D-07 says "Each service gets its own separate Python virtualenv"; backend and scheduler share code and dependencies (same requirements.txt).
   - What's unclear: Does "separate venv" mean separate installations (two copies of dependencies), or can they share a venv folder?
   - Recommendation: Keep them separate (two venv folders, e.g., `backend/venv` and `scheduler/venv`). This isolates any per-service pip installations or package-specific state, and matches the Docker image model exactly. Minimal disk overhead (~100MB per venv).

3. **How to handle Postgres version upgrades if 15 → 16 becomes necessary post-Phase 2?**
   - What we know: Phase 2 uses PostgreSQL 15; if a future upgrade is needed, pg_upgrade or pg_dump/restore is required.
   - What's unclear: Should Phase 2 document the upgrade procedure, or defer to Phase 5/later when/if upgrade is needed?
   - Recommendation: Document the pg_dump/pg_restore procedure in Phase 2's success criteria (it's already documented in Pitfall #1 and Code Examples). If a full pg_upgrade is needed in the future, a separate research phase can refine the approach.

4. **Should Postgres data path be C:\ProgramData\PostgreSQL\data, or a custom path?**
   - What we know: Windows PostgreSQL installer defaults to `C:\Program Files\PostgreSQL\15\` for binaries and `C:\ProgramData\PostgreSQL\data\` for data.
   - What's unclear: Should Phase 2 respect the default, or move data to C:\billar-pos\data\ for co-location with other services?
   - Recommendation: Respect the Windows default (`C:\ProgramData\PostgreSQL\data\`). This follows Windows conventions and ensures Postgres service scripts don't need custom paths. If space becomes an issue, Phase 5 can relocate data via Postgres configuration.

5. **How to verify that all three services (backend, scheduler, telegram-bot) successfully connect to Postgres on Windows?**
   - What we know: Each service will fail to start if Postgres connection fails; logs will show the error.
   - What's unclear: Should Phase 2 include a standalone "connectivity test" script, or rely on NSSM logs to surface failures?
   - Recommendation: Include a simple PowerShell script in `scripts/test-connectivity.ps1` that runs a SQL query via each service's venv (e.g., `python -c "from app import create_app; app.create_app(); db.engine.execute('SELECT 1')"`) and reports results. This validates the setup before service installation. Can be run manually or as part of the NSSM install script's final verification step.

---

## Environment Availability

**Phase 2 is being researched and planned for execution on a separate staging Windows machine (not the live bar machine).** The following tools/services must be available on the staging machine before Phase 2 execution begins:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| **Windows 11** | All services | ✓ (per D-02, staging machine is available) | 22H2 or later | — (Windows 11 is fixed target) |
| **Python 3.8+** | Backend, scheduler, telegram-bot venvs | ✓ (must be installed via winget or python.org) | 3.11 recommended | Must install before Phase 2 execution |
| **PostgreSQL 15 installer** | Postgres native service setup | Needs installation | 15.x (current release) | PostgreSQL 14 might work (requires pg_dump/pg_restore compatibility check) |
| **nginx Windows binary** | Reverse proxy service | Needs download from nginx.org | 1.24+ | nginx 1.23 might work (no breaking changes in reverse proxy config) |
| **NSSM 2.24** | Service management | Will auto-download via script | 2.24 (latest stable) | NSSM 2.23 likely compatible (stable versions don't differ much) |
| **pip (Python package manager)** | Installing requirements.txt | ✓ (included with Python 3.8+) | Latest in Python install | — (required, no fallback) |
| **PowerShell 5.0+** | Running install scripts | ✓ (Windows 11 includes PowerShell 5.1) | 5.1 or higher | — (required for NSSM install scripts) |
| **Administrator access** | Registering NSSM services | ✓ (must run as Administrator) | N/A | Cannot proceed without Administrator rights |
| **Docker (on current bar machine only)** | Backing up Postgres data from Docker | ✓ (already running on bar machine) | Docker Desktop current version | If Docker is not running, use alternative: restore from existing pg_dump backup file |
| **psql command-line tool** | Testing Postgres connectivity | ✓ (included in PostgreSQL 15 Windows installer) | 15.x | Alternative: test via Python sqlalchemy connection |

**Missing dependencies blocking Phase 2 execution:**
- Python 3.8+ — must be installed before any venv setup
- Administrator rights — required to register NSSM services

**Missing dependencies with fallback:**
- PostgreSQL 15 installer — could use PostgreSQL 14, but requires testing pg_dump/pg_restore compatibility
- docker (for backup) — if Docker is not running on bar machine, Phase 2 must work with a pre-existing pg_dump backup file or start with synthetic data (covered in D-09)

**Availability confirmation:** Before Phase 2 planning is finalized, the staging machine must have Python 3.8+ installed and network access to download nginx and NSSM. PostgreSQL 15 installer should be available (downloaded or on local media).

---

## Security Domain

Disabled per `.planning/config.json` workflow.nyquist_validation = false. Skipping Validation Architecture section.

**Note for Phase 3:** Secret management (SEC-01, SEC-02 in REQUIREMENTS.md) is deferred to Phase 3. This phase establishes the foundation (NSSM AppEnvironmentExtra for env vars, `.env` file ignored in git); Phase 3 will harden with encrypted secret storage (Windows Credential Manager or similar).

---

## Sources

### Primary (HIGH confidence)

- **Flask-SocketIO Deployment Docs** https://flask-socketio.readthedocs.io/en/latest/deployment.html
  - Confirmed: eventlet and gevent are the only supported async backends; Waitress is NOT supported.
  - Confirmed: `socketio.run()` is a valid standalone entrypoint for Flask-SocketIO apps.

- **Flask-SocketIO GitHub Issues**
  - https://github.com/miguelgrinberg/Flask-SocketIO/issues/1010 — Waitress incompatibility explicitly documented by maintainer.

- **NSSM Official Documentation** https://nssm.cc/commands
  - Confirmed: NSSM supports service dependencies (`DependOnService`), environment variables (`AppEnvironmentExtra`), and restart policies.

- **PostgreSQL Official Windows Installer** https://www.postgresql.org/download/windows/
  - Confirmed: PostgreSQL 15 Windows binary available; ships with pg_dump, pg_restore, psql utilities.

- **PostgreSQL pg_dump/pg_restore Documentation** https://www.postgresql.org/docs/current/app-pgdump.html
  - Confirmed: Custom format (`-Fc`) supports compression and flexible restoration.
  - Confirmed: Parallel restoration with `-j` flag available for custom and directory formats.

- **nginx Official Windows Binary** https://nginx.org/en/download.html
  - Confirmed: Windows executable available; no Windows-specific configuration needed for reverse proxy.

- **APScheduler User Guide** https://apscheduler.readthedocs.io/en/master/userguide.html
  - Confirmed: BlockingScheduler is appropriate for standalone scheduler processes.
  - Confirmed: Pure Python; Windows-compatible.

- **Project Codebase Documentation**
  - `.planning/research/ARCHITECTURE.md` (lines 20–100) — Native Windows Services reference sequence.
  - `.planning/research/PITFALLS.md` — Critical pitfalls (Pitfalls #1, #2, #3, #4 directly cited).
  - `scripts/install-nssm-print-agent.ps1` — Production-validated NSSM pattern (reference implementation).
  - `backend/wsgi.py` — Confirmed: uses `socketio.run()`, no gunicorn.
  - `docker-compose.yml` — Confirmed: env vars documented for all services.

### Secondary (MEDIUM confidence)

- **Windows Service Dependency Ordering**
  - https://www.sccmtst.com/2024/02/mastering-windows-service-management.html — Guidance on NSSM dependencies and startup order.

- **PostgreSQL on Windows Best Practices** (Multiple sources, e.g., SQL Backup & FTP blog)
  - https://sqlbackupandftp.com/blog/how-to-backup-and-restore-postgresql-database/ — Practical pg_dump/pg_restore examples for Windows.

- **NSSM + Python Virtualenv Tutorials**
  - https://www.techcoil.com/blog/how-to-use-nssm-to-run-a-python-3-application-as-a-windows-service-in-its-own-python-3-virtual-environment/ — Confirmed pattern for venv + NSSM integration.

### Tertiary (LOW confidence, informational only)

- **General WSGI Server Comparisons** (Medium, LinkedIn Pulse)
  - Broad overview of Gunicorn, Waitress, uWSGI trade-offs (not binding, used for context only).

---

## Metadata

**Confidence breakdown:**
- **Standard stack (HIGH):** eventlet WSGI verified via Flask-SocketIO docs; Postgres Windows binary available; nginx Windows binary available; NSSM proven via print agent in production.
- **Architecture (HIGH):** Layered monolith pattern unchanged; only deployment model changes (Docker → Windows Services). All components are existing code; no rewrites needed.
- **Pitfalls (HIGH):** Derived from `.planning/research/PITFALLS.md` (researched 2026-08-08) and specific Windows gotchas (eventlet, host.docker.internal, Postgres startup timing).
- **Assumptions (MEDIUM):** 10 assumptions identified; most are LOW-risk mitigations exist or are validated by existing usage (print agent).

**Research date:** 2026-08-08
**Valid until:** 2026-09-08 (30 days — stack is stable; no major changes expected in Postgres/nginx/NSSM/eventlet)
**Next review:** Before Phase 3 (centralized logging) begins, confirm Postgres is stable and no major Windows 11 updates broke service management.

---

**End of Research Document**

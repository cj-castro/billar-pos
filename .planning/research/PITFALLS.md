# Hosting Migration Pitfalls Research

**Domain:** On-premise Windows POS system migration from Docker/Rancher to alternative hosting
**System:** BilliardBar POS (Flask backend, React frontend, Postgres, scheduler, telegram-bot, Windows print agent)
**Researched:** 2026-08-08
**Confidence:** HIGH (based on documented production issues + known codebase fragilities)

---

## Critical Pitfalls

### Pitfall 1: Postgres Data Loss or Corruption During Docker-to-Native Transition

**What goes wrong:**
The production Postgres database (containing all tickets, inventory, cash sessions, audit logs) is lost, corrupted, or inaccessible in the new hosting environment. This is a complete data loss incident — every transaction, balance, and audit record since POS deployment is gone.

**Why it happens:**
- Docker volumes or bind mounts are not explicitly backed up before decomissioning Docker
- Postgres data directory path is incorrect or not mounted in the new environment (Windows Service or systemd)
- New Postgres version (e.g., upgrading from 15 to 16) has incompatible data format, causing "data directory looks invalid" errors
- Migration script assumes data exists at `/var/lib/postgresql/data` but the new environment uses `C:\ProgramData\PostgreSQL\data` (Windows path assumptions)
- No verification step to confirm data migrated correctly before switching off the old system

**How to avoid:**
1. **Before decomissioning Docker:** Take an explicit database backup using `pg_dump` (or full `pg_basebackup` for point-in-time recovery). Verify the backup can be restored in a clean Postgres instance.
2. **Document data paths:** Record the exact Docker volume name or bind mount path currently holding Postgres data. Map this 1:1 to the new hosting model's data directory.
3. **Dry-run the migration:** In a test environment (separate Windows machine or VM), migrate Postgres data using the same procedure, verify all tables and data are readable, then switch backend to read from the test DB to verify application-level access works.
4. **Version compatibility:** If upgrading Postgres, test the upgrade path explicitly. Document: old version → new version, and whether `pg_upgrade` or `pg_dump`/`restore` is required.
5. **Backup verification automation:** After data migration, run a simple SQL query (e.g., `SELECT COUNT(*) FROM tickets`) as part of the deployment validation to confirm data is present.

**Warning signs:**
- Postgres startup fails with "data directory looks invalid" or permission-denied errors
- `SELECT * FROM information_schema.tables` returns zero rows (schema not found)
- Application logs show `ProgrammingError: relation "tickets" does not exist`
- No backup file exists before decommissioning the old Docker setup
- Data path in the new environment is a guess ("probably in c:\db" or "systemd will handle it")

**Phase to address:**
**Phase 2: Core Services Migration** — Backup + migration plan must be finalized before touching Docker. Run Phase 2 in a staging environment first.

---

### Pitfall 2: Loss of Process Isolation — Cascade Failures After Docker Decomission

**What goes wrong:**
Without Docker's process boundaries, a crash in one service (Postgres, backend, scheduler) cascades to others or exhausts shared OS resources (disk, memory), bringing down the entire POS. For example, Postgres running out of disk space during an index rebuild triggers an unrecoverable state, and without isolated containerization, the backend can't recover gracefully.

**Why it happens:**
- Services move from isolated Docker containers to native Windows Services or systemd units sharing the same OS, same filesystem, same memory pool
- No per-service resource limits (memory cap, disk quota) — one runaway process consumes all RAM/disk
- No independent restart policy — when Postgres crashes, everything that was containerized together crashes too
- Shared temp directories (`/tmp` on Linux, `%TEMP%` on Windows) can fill up, cascading failures across services
- Service dependencies not explicitly configured — backend starts before Postgres is fully ready, causing connection pool exhaustion

**How to avoid:**
1. **Implement independent service supervision:** Use Windows Services (NSSM or WinSW) or systemd with explicit, isolated restart policies — Postgres restarts independently from backend, not as a group.
2. **Set per-service resource limits:**
   - Windows: Use `WinSW` with `<lowMemoryAction>` / CPU affinity directives
   - Systemd: Use `MemoryLimit=`, `CPUQuota=`, `TasksMax=` in the unit file
3. **Explicit health checks and dependencies:** Add `Requires=` (systemd) or dependency rules (NSSM) ensuring Postgres is healthy before backend tries to connect. Backend must wait for a successful DB connection, not just "Postgres service is running."
4. **Isolate temp directories:** Each service gets its own temp directory or a shared one with aggressive cleanup; don't let one service's temp explosion crash others.
5. **Implement monitoring:** Dashboard showing which services are running, failed, and why. Alert immediately if a critical service crashes.

**Warning signs:**
- After reboot, backend is running but Postgres isn't (or vice versa), causing connection failures
- Disk full errors in logs without cleanup; services crash in cascade
- Memory leaks in one service consume all system RAM; OS or other services become unresponsive
- "Service dependency not met" errors on startup
- Manual restart of one service required to recover others

**Phase to address:**
**Phase 3: Process Supervision** — Supervise configuration (dependencies, restart policies, resource limits, health checks) must be designed here.

---

### Pitfall 3: Print Agent Networking Breaks When Docker is Removed

**What goes wrong:**
The backend can no longer reach the print agent (`http://host.docker.internal:9191`). Print jobs hang indefinitely or fail with "connection refused" / "host not found." Receipts and kitchen chits never print, but the frontend still shows them as "printing" — staff doesn't realize payments/orders aren't actually being printed.

**Why it happens:**
- `host.docker.internal` is a Docker Desktop feature; it does NOT exist in:
  - Podman (different alias or no alias)
  - Native Windows Services (localhost `127.0.0.1` only)
  - Systemd on Linux (not applicable; the POS runs on Windows)
- Backend code hardcodes or defaults to `PRINT_AGENT_URL=http://host.docker.internal:9191` without fallback
- Print job POST is fire-and-forget with broad `except Exception` swallowing the connection error; operator sees nothing wrong until later when no receipts were printed
- No health check on startup to validate print agent reachability

**How to avoid:**
1. **Document the print agent discovery strategy before migration:** Decide: Is print agent always on `localhost:9191` (native Windows)? Or at a specific IP? Or dynamically resolved?
2. **Update `PRINT_AGENT_URL` env var:** In the new hosting model, set it to the correct address (e.g., `http://localhost:9191` for Windows Service, or explicit IP if backend and print agent run on different hosts).
3. **Add print-agent health check on backend startup:**
   ```python
   # backend/app/__init__.py or config validation
   if FLASK_ENV == 'production':
       try:
           response = requests.head(f"{PRINT_AGENT_URL}/health", timeout=2)
           if response.status_code != 200:
               logger.warning(f"Print agent at {PRINT_AGENT_URL} returned {response.status_code}")
       except Exception as e:
           logger.error(f"Print agent unreachable at {PRINT_AGENT_URL}: {e}")
           # Don't fail startup, but alert operator
   ```
4. **Test print agent reachability in the target environment BEFORE migration:** Manually test `curl http://<target-addr>:9191/printers` from the backend machine.
5. **Log print job failures explicitly:** Change the fire-and-forget handler to at least log failures at WARNING or ERROR level, so `docker compose logs backend` shows what went wrong.

**Warning signs:**
- Logs show `ConnectionError: Failed to establish a new connection to host.docker.internal:9191`
- Print agent endpoint responds with 404 or "service not found"
- Frontend still shows tickets as "printing" but nothing comes out of the printer
- Staff notices receipts aren't being printed 30 minutes after payment
- Operator checks backend logs and finds exception swallowed silently in `_spawn_auto_print_chit`

**Phase to address:**
**Phase 1: Research/Decision** — Document print-agent networking assumptions and how each candidate hosting model addresses them.
**Phase 2: Core Services Migration** — Update `PRINT_AGENT_URL` and add health checks before switching.

---

### Pitfall 4: Secrets and Environment Variables Leaked or Misconfigured

**What goes wrong:**
Secrets (database password, JWT secrets, per-role login credentials) end up in plain-text files, batch scripts, service startup logs, or are visible via process introspection (Task Manager, `ps aux`). An attacker or disgruntled staff member with local access to the POS machine can easily extract credentials and compromise the system.

**Why it happens:**
- Docker's env-var isolation is lost when services move to native OS processes; Windows Services and systemd typically load env vars from plain-text files
- Migration script copies secrets from `docker-compose.yml` to a batch script (`start-pos.bat`) or systemd unit file without encryption
- `.env` file (containing all secrets) is left on the desktop, checked into git, or placed in a world-readable directory
- No centralized secrets management — secrets are scattered across multiple config files with no way to rotate them atomically
- Operator documentation tells people to "just set these env vars in the startup script" without mentioning security implications

**How to avoid:**
1. **Establish a secrets management plan BEFORE migration:**
   - Windows: Use Windows Credential Manager, Windows Vault, or encrypted `.ini` files (never plain-text `.env`)
   - Systemd: Use `EnvironmentFile=/etc/pos/secrets.env` with mode `600` (owner-read-only), not inline env vars in the unit file
2. **Document required secrets:** Create `.env.example` listing all required vars (DATABASE_URL, SECRET_KEY, JWT_REFRESH_SECRET, per-role passwords/PINs, PRINT_AGENT_URL, FLASK_ENV, etc.) with `PLACEHOLDER` values, checked into git.
3. **Do NOT check `.env` into git:** Add `.env` and any secrets file to `.gitignore`. Provide a setup script or documentation showing how to generate/populate secrets in the new environment.
4. **For Windows Services:** Use WinSW's `<env>` element with encrypted values, or load from Credential Manager via PowerShell at startup.
5. **Audit the new environment:** After migration, verify that `Get-Process | Select-Object ProcessName, Environment` doesn't leak secrets in process environment; ensure startup scripts don't echo secrets in logs.
6. **Secret rotation plan:** Document how to rotate `SECRET_KEY`, `JWT_REFRESH_SECRET`, and role passwords in the new hosting model without downtime.

**Warning signs:**
- Secrets visible in Windows Task Manager's "Environment Variables" tab for the running service
- `.env` file exists in the root directory or `C:\Users\...` (discoverable)
- Startup batch script contains plain-text `set SECRET_KEY=...`
- Systemd unit file has `Environment=SECRET_KEY=...` visible to unprivileged users
- Git history shows someone committed `.env` by accident
- Logs from service startup show "SECRET_KEY=..." or role passwords being echoed

**Phase to address:**
**Phase 2: Core Services Migration** — Secrets management strategy and implementation must be finalized before any service transitions.

---

### Pitfall 5: Auto-Start-on-Boot and Power-Loss Recovery Fail or Behave Unexpectedly

**What goes wrong:**
After a reboot or power failure:
- Services don't automatically restart, or restart in the wrong order (backend starts before Postgres is ready)
- Postgres starts but with stale/locked data; recovery requires manual intervention
- Orphaned processes from the previous run don't get killed, causing port conflicts or resource leaks
- No visibility into which services started successfully vs. which failed; operator doesn't realize the POS is down until customers complain

**Why it happens:**
- Windows Services (NSSM/WinSW) or systemd units are misconfigured — missing `Requires=`, `After=` dependencies
- No health checks — a service is marked "running" even if it's hung or can't connect to dependencies
- Startup timeout is too short; backend tries to connect to Postgres before it's fully initialized
- Postgres crash during shutdown leaves `.pid` lock file, preventing restart
- Print agent doesn't auto-start or fails silently, no alert
- No watchdog to verify services stay up — a process might crash 1 minute after boot, before operator checks

**How to avoid:**
1. **Configure explicit service dependencies:**
   - **Windows (WinSW):** Use `<depends>` elements to ensure backend depends on Postgres; print agent depends on nothing.
   - **Systemd:** Use `After=postgresql.service` and `Requires=postgresql.service` in `backend.service`, ensuring startup order.
2. **Implement healthchecks:**
   - Add a simple `/health` endpoint in the backend that checks DB connectivity
   - Postgres: verify it can respond to `SELECT 1`
   - Print agent: add a `/health` endpoint (currently none exists)
   - Supervisor (systemd or NSSM) checks health periodically; if health fails, restart the service
3. **Startup sequence verification script:** Before marking services as "ready," run a validation script:
   ```bash
   # Test DB connection
   psql -h localhost -U billar -d posdb -c "SELECT COUNT(*) FROM users"
   # Test backend
   curl -f http://localhost:5000/health || exit 1
   # Test print agent
   curl -f http://localhost:9191/printers || exit 1
   ```
   Only mark POS as "up" once all checks pass.
4. **Graceful shutdown:** Configure `systemd` to send `SIGTERM` (not `SIGKILL`) to backend, giving it time to flush in-flight requests; use `TimeoutStopSec=30` to allow graceful shutdown.
5. **Test reboot and power-loss recovery:** Before going live, simulate a power failure (pull the plug) or reboot the machine multiple times; verify all services auto-start and the POS is operational within 2 minutes.

**Warning signs:**
- After reboot, backend process is running but can't connect to Postgres; logs show "connection refused"
- Postgres won't start; logs show "could not open lock file /var/lib/postgresql/data/postmaster.pid"
- Print agent doesn't exist in Task Manager or systemctl, but operator expected it to auto-start
- Operator reboots machine, POS appears to be up (services running), but frontend can't load tickets (backend hung)
- `systemctl status pos-backend` shows "active (running)" but `curl http://localhost:5000/health` times out

**Phase to address:**
**Phase 3: Process Supervision** — Service dependencies, healthchecks, and startup validation must be implemented here.

---

### Pitfall 6: Eventlet Single-Worker Constraint is Violated, Breaking Background Task Concurrency

**What goes wrong:**
Background tasks (print jobs, async email reports, timer updates) hang indefinitely or deadlock. For example, a print job is sent to the print agent, but the request never returns; the backend thinks it's waiting, but the eventlet scheduler is blocked. Timers don't update, kitchen orders don't go through, the POS appears frozen.

**Why it happens:**
- Backend is migrated to a multi-worker configuration (e.g., `gunicorn -w 4 --worker-class eventlet`) in an attempt to improve throughput, breaking eventlet's cooperative scheduling
- A developer accidentally spawns a real `threading.Thread` in a background task instead of using `socketio.start_background_task` (which is eventlet-aware)
- Print job handler is refactored to use `asyncio` without understanding that eventlet's `gevent` model is not compatible with `asyncio`
- Deployment documentation doesn't explicitly state that the worker count must remain `1`; a new operator increases it to 4 in production

**How to avoid:**
1. **Enforce single-worker configuration:**
   - In the Gunicorn startup command: `gunicorn --worker-class eventlet -w 1 --timeout 300 ...` (explicitly `1`, not a variable)
   - Add a comment in the deployment docs: "DO NOT CHANGE `-w 1` — the backend uses eventlet's cooperative scheduler which requires a single worker."
   - In the code, add a startup check that logs and verifies worker count:
     ```python
     import multiprocessing
     # In app factory, after gunicorn is running
     # This is more for documentation than enforcement, but makes it visible
     logger.info(f"Starting with {os.environ.get('GUNICORN_WORKERS', 1)} worker(s) — eventlet requires exactly 1")
     ```
2. **Audit all background work sites:**
   - Search codebase for `threading.Thread`, `Process`, `executor.submit`, `asyncio.create_task` — all are dangerous with eventlet
   - Verify every async task uses `socketio.start_background_task` (see `backend/app/api/tickets.py:81`, where this is already correct)
   - Document the constraint clearly in comments:
     ```python
     # MUST use socketio.start_background_task, NOT threading.Thread or asyncio
     # The backend runs gunicorn --worker-class eventlet -w 1 (single worker)
     # Raw threads break eventlet's cooperative scheduler
     socketio.start_background_task(self._spawn_auto_print_chit)
     ```
3. **Testing:** Include a test that verifies print jobs complete within 5 seconds (catch hangs early):
   ```python
   # In backend/tests/ (even if hand-rolled)
   def test_print_job_does_not_hang():
       # Submit a print job, verify it completes in < 5 seconds
       # If this hangs, eventlet scheduler is broken
   ```
4. **Prevent `asyncio` usage:** If someone suggests porting code to `asyncio` for performance, reject it. If higher concurrency is truly needed, propose Celery (separate async queue with independent worker pool) as a distinct component, not inside the Flask app.

**Warning signs:**
- Backend logs show print jobs submitted but never completed (no response from print agent)
- Timers stop updating mid-session (Socket.IO events not being sent)
- Kitchen orders appear stuck in "sending" state
- Operator increases gunicorn worker count to "improve performance," then everything hangs
- Logs show `greenlet` warnings or eventlet warnings

**Phase to address:**
**Phase 1: Research/Decision** — Clarify that eventlet's single-worker model is a non-negotiable constraint for this system.
**Phase 2: Core Services Migration** — Verify single-worker configuration is enforced in the new hosting model; audit all background work.

---

### Pitfall 7: Ghost-Ticket Data Corruption Recurs or Worsens During Migration

**What goes wrong:**
The known recurring "ghost-ticket" problem (open tickets exist on resources marked AVAILABLE, orphaned timers keep running, duplicate open tickets) recurs during the migration process or immediately after cutover. Recovery tooling (`clean-ghosts`, `force-close`) may fail or produce inconsistent results because the root cause was never fixed — migration just moved the broken system to a new hosting model.

**Why it happens:**
- Ghost tickets occur when crashes or network drops leave transactions incomplete (e.g., `OPEN` ticket created, but resource status not updated atomically)
- The current recovery tooling is a workaround, not a fix; migrating without addressing the root cause means the problem survives the migration
- New hosting model's restart behavior may be more aggressive or less graceful than Docker, making mid-transaction crashes MORE likely
- Testing the new hosting model may involve frequent restarts or crashes (inevitable in migration testing), triggering ghost tickets at higher frequency
- No automated verification that `clean-ghosts` successfully recovered all ghosts — manual audit is easy to skip or do incorrectly

**How to avoid:**
1. **Audit and clean the existing database BEFORE migration:**
   - Run `POST /api/v1/tickets/clean-ghosts` on the live production system one final time before cutover
   - Manually verify using the diagnostic SQL queries in `RECOVERY.md:196-217` that all ghosts are gone
   - Document the "cleaned" state as a baseline
2. **Root-cause analysis (critical, not optional):**
   - The current recovery tooling indicates this has happened in production; understand WHY
   - Likely causes: backend crash mid-transaction during ticket close, timer update, or resource status change
   - Review `backend/app/api/tickets.py` for transaction boundaries — ensure all ticket mutations are atomic
   - Check if `db.session.commit()` can be interrupted mid-operation on network drop
   - Add explicit transaction logging to understand which operations are leaving the DB inconsistent
3. **Add transactional safety checks:**
   - Verify that `OPEN` ticket and resource `AVAILABLE` status are NEVER simultaneously true for the same resource (add a DB constraint if missing)
   - Use `db.session.with_for_update()` locking on all ticket mutations (already done in some places; audit all)
   - Ensure Postgres transaction isolation level is at least `READ_COMMITTED` (should be default)
4. **Implement graceful shutdown and crash recovery:**
   - On SIGTERM, backend should flush in-flight requests and complete transactions before shutting down
   - On startup, run a lightweight ghost-detection query and log results (don't auto-fix; just alert operator)
   - Document: "If ghosts are detected on startup, run `POST /api/v1/tickets/clean-ghosts` manually and verify with SQL"
5. **Test crash recovery in the new environment:**
   - In staging, simulate frequent crashes (SIGKILL backend during transaction, network drop, Postgres shutdown) and verify:
     - `clean-ghosts` can recover all cases
     - No data is lost (only inconsistency, not data loss)
     - Resources eventually return to a consistent state after `clean-ghosts`
   - Document failure modes that `clean-ghosts` cannot fix; flag those for future deep-dive

**Warning signs:**
- After migration testing, `clean-ghosts` reports more orphaned tickets than before
- Manual audit of the DB shows duplicate open tickets on the same resource
- Timers keep running on closed tickets; operator has to manually stop them via force-close
- Recovery tooling produces errors (e.g., "cannot close ticket ID XYZ because resource is not in expected state")
- Ghost-ticket recovery runbook doesn't work with the new hosting model

**Phase to address:**
**Phase 1: Research/Decision** — Document the root cause of ghost tickets; determine if it's a blocker for migration or acceptable risk.
**Phase 2: Core Services Migration** — Clean up all existing ghosts before cutover; implement transaction-safety improvements.
**Phase 4: Cutover** — Monitor ghost-ticket prevalence closely after switching to new hosting; be ready to revert if they spike.

---

### Pitfall 8: Incomplete Rewrite (Rust or Electron) Leaves Two Codebases and Causes Feature Parity Gaps

**What goes wrong:**
If only PART of the backend is rewritten (e.g., Rust for core ticket logic, but Python still running for inventory/promotions), the system must maintain two parallel implementations:
- Feature changes must be applied twice (once in Python, once in Rust)
- Bugs fixed in one codebase don't get fixed in the other
- Data written by Rust code breaks Python code's ORM assumptions or vice versa
- Deployment becomes fragile ("did we restart both backends?")
- Cutover is risky because old and new code run simultaneously, and swapping traffic is error-prone
- Eventual decommission of the old code is delayed, accumulating debt

**Why it happens:**
- Rust rewrite feels attractive for performance, but the entire backend is 1549 lines in `tickets.py` alone; rewriting the whole thing takes months
- Partial rewrite seems like a pragmatic compromise: rewrite high-traffic paths in Rust, leave the rest in Python
- Operator error: two services running with the same API, confusing which one is active
- Testing only exercises one code path; the other accumulates bit-rot

**How to avoid:**
1. **Make a hard decision: all-or-nothing rewrite, not partial.**
   - **All-in Rust:** Rewrite the entire backend (Flask + all blueprints). Plan for 3-6 months. Test thoroughly. Cutover atomically by pointing the frontend to the new backend.
   - **Keep Python:** Don't rewrite. If performance is the blocker, explore optimization within Python (connection pooling, caching, async handlers via Celery) before rewriting.
   - **Never do:** "Rewrite tickets.py in Rust, keep inventory.py in Python" running side-by-side.
2. **If all-in Rust is chosen:**
   - Scope: Reimplement every endpoint (full 1:1 feature parity), not a subset
   - Data: Ensure Rust code uses the same Postgres schema; test that data written by Rust is readable by recovery tools and vice versa
   - Testing: Extensive end-to-end tests; run both backends in parallel during testing (replay production traffic to both, compare responses)
   - Cutover plan: Green/blue deployment; switch frontend to Rust backend atomically; decommission Python backend after 24-48 hours of stable operation
   - Rollback plan: Keep Python backend running for 1 week post-cutover; if critical bug found, revert to Python instantly
3. **If partial rewrite is unavoidable (urgent deadline):**
   - Document explicitly which endpoints are in which language
   - Add a request ID / tracing header to correlate logs across languages
   - Implement strict contract tests: Python and Rust implementations are tested against the same request/response suite
   - Use a feature flag to toggle between implementations per endpoint; don't run both in production
   - Set a hard cutover date: "Rust v1 cutover: 2026-09-01; Python decommissioned: 2026-09-15"
4. **Electron wrapper (alternative concern):**
   - If Electron is chosen, do NOT bundle the Python backend inside the Electron binary
   - Keep Python + Postgres as separate services (Windows Service, systemd, or independent process supervisor)
   - Electron is only the frontend; backends are separate, deployed independently
   - This avoids the "huge binary, difficult updates, resource exhaustion" problems of bundled Electron apps

**Warning signs:**
- Two backend processes listening on different ports; frontend can reach both
- Git history shows parallel changes to `backend/app/tickets.py` and `backend_rust/src/tickets.rs` fixing the same bug separately
- Deployment docs say "restart both the Python and Rust backends"
- Testing reports differ between Python and Rust implementations (e.g., promotion logic calculates discount differently)
- Operator confusion: "which backend is actually handling requests right now?"

**Phase to address:**
**Phase 1: Research/Decision** — Decide: rewrite all or rewrite nothing. If rewriting, estimate scope and timeline; if the timeline is too long, abandon the rewrite and optimize Python instead.

---

## Technical Debt Patterns

Common shortcuts that seem reasonable but create long-term migration problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip Postgres backup before Docker decomission | "We'll migrate the live DB directly" | Complete data loss if anything goes wrong | **NEVER** — backups take 5 minutes; data loss is catastrophic |
| Hardcode `host.docker.internal` in backend code | "Works in Docker Desktop" | Print agent unreachable when switching hosting model | Only in dev; must be configurable via `PRINT_AGENT_URL` env var before production |
| Store secrets in `.env` file without encryption | "Quick setup; .env in .gitignore prevents leaks" | Secrets discoverable on disk; no way to rotate them atomically | Only in dev; production needs secrets management (Vault, Windows Credential Manager, etc.) |
| Don't document eventlet worker constraint | "Code already uses eventlet; we'll just keep it" | Future operator increases workers to "improve performance," breaking everything | **NEVER** — document in DEPLOYMENT.md, startup logging, and code comments |
| Skip service dependency configuration in systemd/NSSM | "Services will start in the right order eventually" | Race conditions; backend connects to Postgres before it's ready; timers fail | **NEVER** — dependencies are cheap and prevent silent failures |
| Skip healthchecks, rely on process status | "Process running = service healthy" | Hung process shows as running; operator doesn't realize service is down until customers complain | Only in dev; production needs HTTP/SQL healthchecks for critical services |
| Rewrite only high-traffic endpoints in Rust | "Pragmatic; get performance wins without full rewrite" | Two codebases, feature parity gaps, deployment complexity, bit-rot in Python | **NEVER** — commit to full rewrite or none; partial rewrites are not worth the debt |
| Don't test ghost-ticket recovery with new hosting model | "Recovery tooling works in Docker; it'll work in [new model]" | Ghost tickets recur; recovery tools fail; operator is blindsided | **NEVER** — test crash recovery explicitly in staging; don't assume it's unchanged |

---

## Integration Gotchas

Common mistakes when connecting system components during migration.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|-----------------|
| **Postgres connectivity** | Assume `localhost` works in new environment; don't verify DB_URL | Before migration, test `psql -h <new-db-host> -U <user> -d <db>` from the new backend machine; log the DB_URL on startup; add health check |
| **Print agent reach** | Use `host.docker.internal` assumption; don't test with new hosting model | Explicitly set `PRINT_AGENT_URL` to target address; add health check on backend startup; test from new environment first |
| **Scheduler (APScheduler)** | Assume scheduler runs inside the same container/process; don't configure job database | After migration, verify scheduler and backend use the same Postgres DB for `apscheduler_jobs` table; test scheduler can connect independently |
| **Telegram bot** | Bot runs as sibling process reading the same DB; no cross-process coordination | After migration, verify bot can connect to Postgres; add health check; test bot doesn't deadlock with backend (both reading/writing same tables) |
| **Socket.IO rooms** | Assume single-process backend; room broadcast goes to all connected clients | If backend is ever split into multiple processes, Socket.IO requires shared message broker (Redis); today single-process is fine; document this as a scaling boundary |

---

## Performance Traps

Patterns that work at small scale but fail as this system scales or restarts more frequently.

| Trap | Symptoms | Prevention | Scale Threshold |
|------|----------|------------|-----------------|
| **Single eventlet worker bottleneck** | Backend CPU at 100% handling concurrent requests; timers stall during busy period | Don't increase workers (breaks eventlet); instead, optimize request handlers and move heavy work to Celery (separate process pool) | ~20 concurrent users on slow hardware; 50+ on modern hardware |
| **Postgres connection pool exhaustion** | "too many connections" errors during traffic spike | Ensure connection pool size is appropriate for backend concurrency; with single eventlet worker, small pool (5-10) is sufficient | ~100 concurrent users if pool size is misconfigured |
| **Ghost-ticket accumulation over time** | More orphaned tickets after each reboot; audit becomes tedious | Implement root-cause fix (atomic transactions); run `clean-ghosts` regularly via cron (weekly); monitor ghost-ticket count as a metric | Noticeable after 1-2 months of frequent restarts |
| **In-process memory rate limiter** | Rate limits reset after restart; in-memory limiter doesn't scale across processes | Today (single process) is fine; if backend ever scales to multiple processes, use Redis for shared rate-limit state | Only if horizontal scaling is attempted |
| **Disk fill from logs** | Old logs accumulate; disk space exhausted; services crash | Implement log rotation (systemd journal, logrotate on Linux; Windows Event Log for Windows Services); archive old logs monthly | ~1 GB logs/month on high-volume system |

---

## Security Mistakes

Domain-specific security issues during hosting migration.

| Mistake | Risk | Prevention |
|---------|------|-----------|
| **Default credentials shipped to production** | Any attacker with network access can login as `admin`/`admin123` or any known role password | Before production deployment, verify `.env` or secrets file has been populated with strong, unique secrets; add startup check that rejects default `SECRET_KEY` and per-role passwords in `FLASK_ENV=production` |
| **Print agent bound to 0.0.0.0 with no auth** | LAN attacker can trigger unlimited receipts/chits; denial of service via print queue (printer jammed for hours) | Bind to `127.0.0.1` if backend and print agent are on same machine; if LAN access needed, add shared-secret header check (e.g., `X-Print-Token`) |
| **Secrets in Windows Service startup script** | Local attacker with file-system access can read service startup script and extract secrets | Use Windows Credential Manager or encrypted secrets file (mode 600); load via secure method (PowerShell with restricted permissions); don't embed secrets in batch scripts or registry |
| **Secrets in systemd unit file** | Local unprivileged user can read unit file from `/etc/systemd/system/` and extract secrets | Use `EnvironmentFile=` with mode 600 (owner-read-only), not inline `Environment=` directives; consider systemd's LoadCredential feature if available |
| **Postgres password in connection string in logs** | Backend startup logs, error messages, or crash dumps expose DB password | Use env var `DATABASE_URL=postgres://user:password@localhost/db`; log only "Postgres connected to localhost:5432 as user" without password; audit logs for any DB_URL leaks |
| **No audit trail of who changed secrets** | Operator rotates password but no record of when or why; forensics are impossible if breach occurs | Use a secrets management tool (HashiCorp Vault, AWS Secrets Manager) with audit logging; document manual rotation steps with timestamp |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces. Verify before considering migration successful.

- [ ] **Postgres data migration:** Backup exists, backup is verified restorable, data migrated to new environment, row counts match old environment, audit log intact
- [ ] **Service auto-start:** After reboot, all services start automatically; Postgres is ready before backend tries to connect; print agent is running; health checks pass
- [ ] **Secrets management:** Secrets file or vault configured; no plain-text secrets in code or config; startup fails loudly if secrets are missing; rotation procedure documented
- [ ] **Print agent reachability:** Backend can reach print agent at configured URL; health check on startup succeeds; test print job completes successfully
- [ ] **Postgres connectivity:** Backend connects to DB on startup; SELECT 1 succeeds; connection pool size is appropriate; no "too many connections" errors under load
- [ ] **Socket.IO and real-time updates:** Frontend connects to backend Socket.IO; kitchen queue updates appear in real-time; floor map updates broadcast to all connected clients
- [ ] **Scheduler (daily report):** APScheduler task fires at 08:00 America/Mexico_City; email with sales report is sent; job runs independently if backend is restarted
- [ ] **Telegram bot:** Bot connects to DB; receives operational alerts; doesn't crash if backend is down (bot is independent process)
- [ ] **Ghost-ticket recovery:** `POST /api/v1/tickets/clean-ghosts` works in new environment; orphaned tickets are identified and closed; no data loss
- [ ] **Graceful shutdown:** Backend receives SIGTERM, flushes in-flight requests, commits transactions, shuts down cleanly within 30 seconds; no orphaned processes left behind
- [ ] **Monitoring and alerting:** Dashboard shows status of all services; alerts fire if critical service is down; operator can see logs from all services in one place
- [ ] **Rollback plan documented:** If migration goes wrong, procedure to revert to Docker is documented and tested; rollback can be executed in under 30 minutes

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover and minimize damage.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| **Postgres data unavailable** | **HIGH** (hours to days) | 1. Stop backend and print agent immediately (prevent further writes). 2. Check if backup exists and is recent; restore from backup to a test DB. 3. If backup doesn't exist, check for Postgres WAL backups or point-in-time recovery options. 4. Worst case: restore from last known-good backup, losing transactions since backup. 5. Document what was lost; reconcile with manual records. |
| **Backend can't reach Postgres** | **MEDIUM** (minutes to 1 hour) | 1. Check Postgres process is running (`systemctl status postgresql` or Windows Services). 2. Test connectivity manually: `psql -h <host> -U <user> -d <db>`. 3. Check firewall/network connectivity between backend and DB. 4. If Postgres is hung, restart it. 5. If connection pool is exhausted, restart backend to reset pool. 6. Verify DB_URL env var is correct. |
| **Print agent unreachable** | **LOW** (minutes) | 1. Check print agent process is running. 2. Test connectivity: `curl http://<print-agent-url>:9191/printers`. 3. If network issue, restart network interface or check routing. 4. Update `PRINT_AGENT_URL` if address changed and restart backend. 5. In interim, receipts/chits queue in backend; they print once print agent is restored. Customers won't notice if downtime is < 10 min. |
| **Secrets leak or exposed** | **HIGH** (1-2 hours) | 1. Immediately rotate all affected secrets (generate new `SECRET_KEY`, new DB password, new JWT secret, new role passwords). 2. Update `.env` or secrets vault with new values. 3. Restart backend and any services using old secrets. 4. All existing JWT tokens become invalid; users forced to log in again. 5. Audit logs for unauthorized access using old credentials. 6. Send operator alert (not customer-facing unless breach was critical). |
| **Services don't restart after reboot** | **MEDIUM** (30 min to 1 hour) | 1. SSH or RDP to machine and check which services are running: `systemctl status` or Windows Services. 2. Manually start failed services in dependency order (Postgres first, then backend, etc.). 3. Check logs for startup errors: `journalctl -u backend` or Event Viewer. 4. Fix the root cause (wrong config, missing directory, permission issue). 5. Re-test reboot to verify all services auto-start. |
| **Ghost tickets discovered** | **MEDIUM** (1-2 hours) | 1. Stop accepting new orders immediately (alert staff). 2. Run `POST /api/v1/tickets/clean-ghosts` — this auto-closes true orphans. 3. Manually audit remaining tickets against resources using diagnostic SQL (see `RECOVERY.md:196-217`). 4. Use `POST /api/v1/tickets/<id>/force-close` for any stuck tickets. 5. Audit timers; manually stop any still-running on closed tickets. 6. Root-cause analysis: was it a crash? network drop? backend restart mid-transaction? Use logs + git history to understand. |
| **Eventlet scheduler broken (tasks hang)** | **HIGH** (code fix required) | 1. Immediately restart backend (gives 30 seconds of fresh concurrency; may clear some queues). 2. Check gunicorn worker count: `systemctl show -p ExecStart backend` — must be `-w 1`. 3. Search logs for `threading.Thread` or `asyncio` usage introduced recently. 4. If found, revert the change (threading breaks eventlet). 5. If not found, audit background job sites for deadlocks. 6. Worst case: temporary scale to multiple workers while you investigate (system will hang more, but you buy time for debugging). Revert to 1 worker once fixed. |
| **Rust/Partial rewrite has feature gap** | **HIGH** (days to weeks) | 1. Identify which feature/endpoint is missing in Rust. 2. If critical (payment processing), roll back to Python backend until Rust implementation is complete. 3. Implement feature in Rust. 4. Test thoroughly in staging. 5. Re-migrate to Rust. 6. In future: don't partial-rewrite. |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Postgres data loss | **Phase 1: Research/Decision** — Document data migration strategy; verify backup/restore procedure in staging | Backup + restore test passes; baseline row counts documented |
| Process isolation loss | **Phase 2: Core Services Migration** + **Phase 3: Process Supervision** — Design service dependencies, resource limits, healthchecks | Reboot test passes; services auto-start in correct order; healthchecks verify readiness |
| Print agent networking | **Phase 1: Research/Decision** — Document how print agent is reached in each candidate hosting model | Health check added; test print job works; PRINT_AGENT_URL is configurable |
| Secrets management | **Phase 2: Core Services Migration** — Implement secrets management before deploying any service | Secrets file/vault configured; no hardcoded secrets in code; rotation procedure documented |
| Auto-start/boot recovery | **Phase 3: Process Supervision** — Service dependencies, startup sequence, healthchecks, graceful shutdown | Reboot test passes; power-loss simulation passes; recovery runbook tested |
| Eventlet constraint violation | **Phase 1: Research/Decision** + **Phase 2: Core Services Migration** — Document constraint; verify single-worker config; audit background-work sites | Gunicorn worker count is 1; code audit shows all background work uses `socketio.start_background_task` |
| Ghost-ticket recurrence | **Phase 1: Research/Decision** — Root-cause analysis; **Phase 2: Core Services Migration** — Cleanup + transactional safety improvements | All ghosts cleaned before cutover; crash-recovery test passes; `clean-ghosts` succeeds on new system |
| Incomplete rewrite (Rust/Electron) | **Phase 1: Research/Decision** — Make all-or-nothing decision; scope and timeline assessment | Rewrite scope documented; decision (full or none) made before Phase 2 begins; if full: 100% feature parity in staging |

---

## Sources

- `.planning/codebase/CONCERNS.md` — Detailed analysis of known production issues (ghost tickets, insecure defaults, missing role checks, testing gaps)
- `.planning/PROJECT.md` — Project context (deployment model, constraints, known issues)
- `CLAUDE.md` — Architecture overview (eventlet single-worker constraint, transaction locking patterns, Socket.IO first for real-time)
- `RECOVERY.md` — Existing ghost-ticket recovery tooling and diagnostic SQL (indicates issue has happened in production)
- `backend/app/api/tickets.py:1276-1406` — Ghost-ticket detection and recovery endpoints
- `backend/app/__init__.py:68-696` — Hand-rolled SQL migrations (schema management strategy)
- `scripts/print_agent/print_agent.py` — Windows print agent (unauthenticated, bound to 0.0.0.0, reachable via `host.docker.internal`)
- `backend/app/extensions.py:11` — SocketIO configuration (eventlet, single-process)

---

*Hosting migration pitfalls research for: BilliardBar POS*
*Researched: 2026-08-08*
*Confidence: HIGH (based on documented production fragilities and codebase analysis)*

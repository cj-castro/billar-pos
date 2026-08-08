# Phase 2: Core Service Migration - Context

**Gathered:** 2026-08-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Get the application's core services (Flask/eventlet backend, PostgreSQL 15, React frontend, scheduler, Telegram bot) running natively on Windows, independent of Docker, validated on an equivalent-spec staging machine — with print-agent connectivity restored to `localhost` and a verified-restorable Postgres backup procedure proven out. This phase does NOT deploy to or touch the live bar machine, and does NOT perform the actual production cutover — that's Phase 5. Covers SVC-01..05, NET-01, DATA-01.

</domain>

<decisions>
## Implementation Decisions

### Migration environment & Docker coexistence
- **D-01:** Phase 2 work happens entirely on a separate, already-available staging Windows machine — not the live bar machine. The bar machine keeps running Docker/Rancher untouched throughout Phase 2.
- **D-02:** The staging machine has equivalent specs to the bar machine (Windows 11, ~8GB RAM) — validation results (service behavior, resource usage) should transfer directly to the real hardware later.
- **D-03:** Deploying the validated native setup onto the actual bar machine is explicitly OUT of scope for Phase 2 — that happens as part of Phase 5's cutover. Phase 2's deliverable is a fully working, staging-validated native setup (services + scripts + procedures), not a bar-machine installation.

### Service wrapping approach
- **D-04:** NSSM is the service-wrapper tool for backend, scheduler, and telegram-bot — reusing the exact pattern already proven for the print agent (`scripts/install-nssm-print-agent.ps1`). Do not introduce WinSW.
- **D-05:** The backend NSSM service wraps `python backend/wsgi.py` directly (eventlet's built-in `socketio.run()` server, already present in the `__main__` block and already exercised via local dev), NOT gunicorn — gunicorn does not run natively on Windows (requires `os.fork()`). This is a hard technical constraint, not just a preference: gunicorn cannot be used at all on the native Windows target. Running `wsgi.py` directly is inherently single-process, which also preserves the eventlet single-worker constraint (DATA-03, verified in Phase 4) with no extra config.
- **D-06:** The backend service runs `flask init-db` and `python seed.py` on every service start, matching `backend/entrypoint.sh`'s current idempotent behavior exactly (STEP blocks use `IF NOT EXISTS` guards) — no new one-time-setup step to remember operationally.
- **D-07:** Each service (backend, scheduler, telegram-bot) gets its own separate Python virtualenv on the staging machine, mirroring both the current Docker image boundaries and the print agent's existing `venv/` pattern. Do not share venvs across services.

### Postgres data migration method
- **D-08:** Postgres migration uses logical dump/restore (`pg_dump` / `pg_restore`), not a physical data-directory copy — safer across the Docker-container-to-native-install boundary and avoids Postgres build/version/path sensitivity.
- **D-09:** Staging validation uses `backend/seed.py`'s synthetic/demo data, NOT a copy of the live production database. Real customer/ticket data is not moved to the staging machine.
- **D-10 (requirements deviation — flag for planner/verifier):** Because staging only uses synthetic data, DATA-01's "verified Postgres backup exists and is restore-tested" requirement — as it applies to the REAL production database — is explicitly deferred to Phase 5's cutover procedure, not delivered as a standalone Phase 2 artifact. Phase 2 instead proves the dump/restore *procedure* works (mechanics, scripts, native-Postgres compatibility) using synthetic data. `.planning/REQUIREMENTS.md`'s traceability table currently maps DATA-01 to Phase 2 — this has NOT been edited (same precedent as Phase 1's D-05 deviation) but planner/verifier should treat DATA-01 as "procedure validated in Phase 2, executed against real data in Phase 5," not "fully satisfied in Phase 2."

### Reverse proxy choice
- **D-11:** nginx is the reverse proxy (not Caddy) — `frontend/nginx.conf` already implements exactly what's needed (static SPA serving, `/api/` proxy, `/socket.io/` proxy with WebSocket upgrade headers and long-lived timeouts for real-time). A native Windows nginx binary can reuse this config nearly as-is.
- **D-12:** nginx runs as an NSSM-wrapped service, consistent with all other services (backend, scheduler, bot, print agent) — one uniform service-management pattern across the whole stack, not nginx's own native Windows service mode.
- **D-13:** Plain HTTP, no TLS — matches current Docker behavior exactly (LAN-only, on-site deployment, no public exposure). Adding HTTPS is explicitly out of scope for this phase (would be new capability, not a migration requirement).

### Claude's Discretion
- Exact nginx listen port on the staging/native setup (e.g., keep 8080 to match the current `FRONTEND_PORT` default, or use 80) — pick whichever fits the staging environment's existing port usage.
- Exact layout/naming of the per-service NSSM install scripts (e.g., mirroring `scripts/install-nssm-print-agent.ps1`'s structure for `install-nssm-backend.ps1`, etc.) — planner/executor may follow existing conventions.
- Exact pg_dump/pg_restore invocation flags (custom-format `-Fc` vs plain SQL) as long as the restore is verified to work against native Postgres 15.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Hosting decision & architecture research
- `.planning/research/SUMMARY.md` — executive summary, ranked verdict, decision already made (native Windows Services)
- `.planning/research/ARCHITECTURE.md` — Native Windows Services section (lines 20-100) has the step-by-step build/migration sequence this phase should follow closely
- `.planning/research/STACK.md` — resource-footprint numbers, technology stack per hosting option
- `.planning/research/PITFALLS.md` — critical pitfalls; §"host.docker.internal" print-agent unreachability pitfall (lines 79-109, 372, 389) directly informs NET-01

### Phase 1 decision record
- `.planning/phases/01-validation-decision-lock/01-CONTEXT.md` — GO decision on native Windows Services, no live measurement performed (D-01–D-05)

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — SVC-01..05, NET-01, DATA-01 definitions; note D-10 above flags a deviation from its DATA-01 traceability mapping
- `.planning/ROADMAP.md` — Phase 2 goal and success criteria

### Codebase maps
- `.planning/codebase/STACK.md` — full stack inventory, env vars, Docker build details
- `.planning/codebase/INTEGRATIONS.md` — print agent HTTP integration, required env vars per service, secrets location
- `.planning/codebase/ARCHITECTURE.md` — print agent trust boundary, `PRINT_AGENT_URL` usage

### Existing native-service pattern to model after
- `scripts/install-nssm-print-agent.ps1` — proven NSSM install pattern: locate/install NSSM, venv setup, service registration, log rotation config, firewall rule, health check verification. This is the template for the new backend/scheduler/bot/nginx install scripts.

### Files defining current service startup behavior (being replaced/adapted)
- `backend/entrypoint.sh` — current Docker startup sequence (`flask init-db` → `seed.py` → gunicorn) that D-06 says to replicate in the native service startup
- `backend/wsgi.py` — the `socketio.run()` entrypoint D-05 designates as the native service's actual command
- `frontend/nginx.conf` — the proxy config D-11 says to reuse for the native nginx setup
- `docker-compose.yml` — source of truth for required env vars per service (backend, scheduler, telegram-bot) that native service configs must replicate

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/install-nssm-print-agent.ps1` — full working NSSM installer pattern (venv creation, service registration, log rotation, firewall rule, health check) to copy/adapt for backend, scheduler, telegram-bot, and nginx
- `frontend/nginx.conf` — proxy config already handles `/api/` and `/socket.io/` correctly including WebSocket upgrade headers; reusable near-verbatim for native nginx
- `backend/wsgi.py` — already has the non-gunicorn eventlet entrypoint (`socketio.run()`) needed for Windows; no new backend code required

### Established Patterns
- Idempotent DB setup via `flask init-db`'s `IF NOT EXISTS`-guarded STEP blocks — safe to re-run on every service start (D-06 keeps this behavior)
- Per-service Python dependency isolation already exists at the Docker-image level (`backend/requirements.txt` shared by backend+scheduler, `telegram-bot/requirements.txt` separate) — D-07 carries this into native venvs

### Integration Points
- `PRINT_AGENT_URL` is already env-var configurable in `backend/app/api/tickets.py:23` and `backend/app/api/queue.py:9` (defaults to `http://host.docker.internal:9191`) — NET-01 is just an env var value change to `http://localhost:9191`, no code change needed
- `docker-compose.yml` environment blocks for `backend`, `scheduler`, `telegram-bot` are the authoritative list of env vars each native service's NSSM config must set

</code_context>

<specifics>
## Specific Ideas

No specific UI/format requirements (this is an infrastructure phase). The clearest steer from discussion: reuse everything that already works (print agent's NSSM pattern, nginx.conf, wsgi.py's eventlet entrypoint) rather than introducing new tools or patterns — this phase is about relocating proven pieces onto native Windows, not redesigning them.

</specifics>

<deferred>
## Deferred Ideas

- **HTTPS/TLS for the reverse proxy** — considered and explicitly rejected as out-of-scope for this migration phase (D-13). Not tracked as a future requirement since the deployment is LAN-only by design; revisit only if the deployment model itself ever changes.
- **Real-production-data backup/restore verification for DATA-01** — not deferred to a future phase exactly, but explicitly pushed to Phase 5's cutover procedure rather than being a Phase 2 deliverable (see D-10). Phase 5's planning should account for this.

None — discussion otherwise stayed within phase scope.

</deferred>

---

*Phase: 2-Core Service Migration*
*Context gathered: 2026-08-08*

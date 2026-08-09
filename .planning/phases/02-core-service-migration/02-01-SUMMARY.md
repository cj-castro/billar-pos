---
phase: 02-core-service-migration
plan: 01
subsystem: infra
tags: [nssm, windows-service, flask, eventlet, socketio, print-agent, powershell]

# Dependency graph
requires:
  - phase: 01-validation-decision-lock
    provides: GO decision on native Windows Services (NSSM) as the hosting replacement, print-agent NSSM pattern proven in production
provides:
  - "backend/service_entry.py: native Windows service entrypoint sequencing flask init-db -> seed.py -> socketio.run() in-process"
  - "scripts/install-nssm-backend.ps1: NSSM installer/registrar for the BilliardBarBackend Windows Service, sourcing secrets from .env at install time"
  - "PRINT_AGENT_URL fallback defaults updated to http://localhost:9191 in backend/app/api/tickets.py and backend/app/api/queue.py (NET-01)"
affects: [02-core-service-migration remaining plans (scheduler/telegram-bot/nginx NSSM wrappers, Postgres native migration), 05-cutover]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "NSSM service wrapper pattern (locate/install NSSM, per-service venv, AppEnvironmentExtra sourced from .env, AppExit Default Restart) reused verbatim from scripts/install-nssm-print-agent.ps1"
    - "Native Windows service entrypoint (service_entry.py) replicates entrypoint.sh's idempotent 3-step startup (init-db -> seed -> server) instead of a Docker CMD"

key-files:
  created:
    - backend/service_entry.py
    - scripts/install-nssm-backend.ps1
  modified:
    - backend/app/api/tickets.py
    - backend/app/api/queue.py

key-decisions:
  - "PRINT_AGENT_URL default change is default-only (os.environ.get fallback); docker-compose.yml supplies its own explicit http://host.docker.internal:9191 default, so the live Docker deployment is unaffected"
  - "service_entry.py runs socketio.run() in-process rather than shelling out to wsgi.py, per D-05 (gunicorn cannot run on native Windows) and to keep NSSM supervising a single long-lived process"
  - "install-nssm-backend.ps1 forwards all .env keys except POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD verbatim, then appends DATABASE_URL/PRINT_AGENT_URL/FLASK_APP/FLASK_ENV overrides after the loop so native-environment values always win over anything conflicting sourced from .env"

patterns-established:
  - "Read-DotEnv PowerShell function: parses repo-root .env (skip blank/# lines, split on first =, strip one layer of quotes) into a hashtable for NSSM AppEnvironmentExtra construction -- reusable for the scheduler/telegram-bot/nginx NSSM scripts still to come in this phase"

requirements-completed: [SVC-01, NET-01]

# Metrics
duration: 10min
completed: 2026-08-08
---

# Phase 2 Plan 1: Backend Native Windows Service Summary

**Native Windows Service entrypoint (`service_entry.py`) and NSSM installer script for the Flask/eventlet backend, plus removal of the last `host.docker.internal` print-agent references.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-08-08T18:32:23-06:00
- **Completed:** 2026-08-08T18:42:20-06:00
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `backend/service_entry.py` replicates `backend/entrypoint.sh`'s idempotent startup sequence (`flask init-db` -> `seed.py` -> server) for native Windows, running `socketio.run()` in-process instead of gunicorn (which cannot run on Windows).
- `scripts/install-nssm-backend.ps1` registers the `BilliardBarBackend` NSSM service, mirroring the proven `install-nssm-print-agent.ps1` pattern (venv setup, log rotation, restart policy, firewall rule, health check), sourcing all secrets from the git-ignored root `.env` at install time via a new `Read-DotEnv` function.
- Both backend `PRINT_AGENT_URL` fallback defaults (`tickets.py`, `queue.py`) now point to `http://localhost:9191`, closing out NET-01, without touching the Docker-path default in `docker-compose.yml`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove host.docker.internal defaults and add the native service entrypoint wrapper** - `68baa82d` (feat)
2. **Task 2: Write the NSSM install/registration script for the backend service** - `22582341` (feat)

**Plan metadata:** (this commit, docs)

## Files Created/Modified
- `backend/service_entry.py` - Native Windows service entrypoint: subprocess `flask init-db`, subprocess `seed.py` (both `check=True`), then in-process `create_app()` + `socketio.run(host='0.0.0.0', port=5000)`.
- `scripts/install-nssm-backend.ps1` - NSSM installer for `BilliardBarBackend`: NSSM locate/install, `backend\venv` setup from `requirements.txt`, `Read-DotEnv`-sourced `AppEnvironmentExtra` (DATABASE_URL rewritten to `localhost:5432`, PRINT_AGENT_URL forced to `localhost:9191`), `AppExit Default Restart`, firewall rule on port 5000, and a retrying health check against `/api/v1/auth/me`.
- `backend/app/api/tickets.py` - `PRINT_AGENT_URL` fallback default: `http://host.docker.internal:9191` -> `http://localhost:9191`.
- `backend/app/api/queue.py` - Same `PRINT_AGENT_URL` fallback default change.

## Decisions Made
- Kept the `PRINT_AGENT_URL` change strictly to the Python fallback defaults (used only when the env var is entirely unset) — `docker-compose.yml`'s explicit `PRINT_AGENT_URL: ${PRINT_AGENT_URL:-http://host.docker.internal:9191}` line is untouched, so the live bar machine's Docker deployment continues to resolve the print agent via Docker Desktop's special DNS name as before.
- Followed the plan's exact instruction to append `DATABASE_URL`/`PRINT_AGENT_URL`/`FLASK_APP`/`FLASK_ENV` overrides *after* the `.env` forwarding loop (rather than excluding those keys from the loop) so later values win in NSSM's `AppEnvironmentExtra` array, even if `.env` happens to define conflicting values for those same keys.
- Used `requirements.txt`-driven `pip install -r` for the backend venv (rather than a hand enumerated package list like the print agent's `pip install flask pywin32`), since the backend has a much larger, already-declared dependency set.

## Deviations from Plan

None - plan executed exactly as written. Both tasks' verification commands and acceptance criteria pass as specified.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. Actual NSSM service installation and startup is validated on a staging Windows machine in a later plan (per this plan's own `<verification>` note); this machine (macOS) has no Windows/NSSM runtime to execute the `.ps1` against.

## Threat Flags

None - both new files fall within the threat_model already declared in `02-01-PLAN.md` (T-02-01..T-02-04); no new unaccounted trust boundary was introduced.

## Next Phase Readiness
- `backend/service_entry.py` and `scripts/install-nssm-backend.ps1` are ready to be exercised on the staging Windows machine referenced in D-01/D-02 of `02-CONTEXT.md`.
- The `Read-DotEnv` pattern established here is directly reusable for the scheduler, telegram-bot, and nginx NSSM install scripts still owed by this phase.
- No blockers for subsequent plans in Phase 2.

---
*Phase: 02-core-service-migration*
*Completed: 2026-08-08*

## Self-Check: PASSED

- FOUND: backend/service_entry.py
- FOUND: scripts/install-nssm-backend.ps1
- FOUND: .planning/phases/02-core-service-migration/02-01-SUMMARY.md
- FOUND commit: 68baa82d
- FOUND commit: 22582341

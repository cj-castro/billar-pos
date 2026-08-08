# Phase 2: Core Service Migration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-08
**Phase:** 2-Core Service Migration
**Areas discussed:** Migration environment & Docker coexistence, Service wrapping approach, Postgres data migration method, Reverse proxy choice

---

## Migration environment & Docker coexistence

| Question | Selected |
|---|---|
| Where does Phase 2 work happen — the bar machine, or a separate machine first? | **Separate/staging machine first** (not "Direct on the bar machine", which was recommended) |
| Do you already have a staging machine, or does one need to be sourced? | **Already have one** |
| How similar is the staging machine to the bar machine (Windows 11, 8GB RAM)? | **Equivalent specs** |
| Does Phase 2 also deploy the validated setup onto the bar machine, or does that wait for Phase 5? | **Stays on staging only — bar machine deployment is Phase 5's job** (not "Deploy to bar machine in Phase 2", which was recommended) |

**Notes:** User has a staging machine with equivalent specs to the bar's production hardware already available, so Phase 2 stays fully off the live system — no coordination needed with bar operating hours. This also means Phase 2's "runs natively on Windows" success criteria (ROADMAP.md) should be read as "validated on staging," with actual bar-machine installation explicitly deferred to Phase 5.

---

## Service wrapping approach

| Question | Selected |
|---|---|
| NSSM or WinSW for backend/scheduler/bot? | **NSSM** (recommended, matches print agent) |
| What does NSSM wrap for backend, given gunicorn doesn't run on Windows? | **`python wsgi.py` directly** (eventlet's built-in `socketio.run()`) (recommended) |
| Should `flask init-db`/`seed.py` run on every service start, or as a one-time step? | **Keep it in the startup path** (recommended, matches entrypoint.sh) |
| Separate venv per service, or shared? | **Separate venv per service** (recommended, matches print agent + Docker image boundaries) |

**Notes:** All four questions landed on the "reuse what already works" option — the print agent's NSSM pattern and `wsgi.py`'s existing eventlet server extend cleanly to the rest of the stack with no new code.

---

## Postgres data migration method

| Question | Selected |
|---|---|
| pg_dump/pg_restore, or physical data-directory copy? | **Logical dump/restore — pg_dump/pg_restore** (recommended) |
| Does staging validate against real production data or synthetic data? | **Seed/synthetic data only** (not "Real production data copy", which was recommended) |
| When does the real production DB actually get backed up and restore-tested, given DATA-01? | **Deferred to Phase 5 cutover** (not "Phase 2 also does a separate real-data test", which was recommended) |

**Notes:** This is a real deviation from `.planning/REQUIREMENTS.md`'s current traceability table, which maps DATA-01 to Phase 2. User explicitly chose not to move real customer/ticket data to a second machine. CONTEXT.md's D-10 flags this for the planner/verifier: Phase 2 validates the dump/restore *procedure* with synthetic data; the *real* production backup/restore-test that DATA-01 describes happens during Phase 5's cutover instead. REQUIREMENTS.md itself was not edited (same precedent as Phase 1's D-05 deviation note).

---

## Reverse proxy choice

| Question | Selected |
|---|---|
| nginx or Caddy? | **nginx** (recommended, reuses existing `frontend/nginx.conf`) |
| NSSM-wrapped, or nginx's own native Windows service mode? | **NSSM-wrapped** (recommended, consistent with the rest of the stack) |
| Plain HTTP, or add HTTPS/TLS? | **Plain HTTP** (recommended, matches current behavior, avoids new scope) |

**Notes:** All three questions landed on the "reuse what exists, don't add new scope" option, consistent with the rest of the discussion's overall pattern.

---

## Claude's Discretion

- Exact nginx listen port on staging (match current `FRONTEND_PORT` default of 8080, or use 80)
- Exact layout/naming of per-service NSSM install scripts, following `scripts/install-nssm-print-agent.ps1`'s structure
- Exact `pg_dump`/`pg_restore` flags (custom-format vs plain SQL), as long as restore is verified against native Postgres 15

## Deferred Ideas

- **HTTPS/TLS for the reverse proxy** — explicitly rejected as out of scope for this migration phase; deployment stays LAN-only.
- **Real-production-data backup/restore verification for DATA-01** — pushed to Phase 5's cutover procedure rather than delivered in Phase 2 (see D-10 in CONTEXT.md).

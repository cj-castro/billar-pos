---
phase: 04-process-supervision-reliability-hardening
plan: 01
subsystem: infra
tags: [flask, postgres, health-check, print-agent, plpgsql, constraint-triggers, reliability]

# Dependency graph
requires: []
provides:
  - "Deepened /api/v1/health that performs a real Postgres SELECT 1 round-trip and returns 200/db:connected or 503/generic-error"
  - "Warn-only print-agent reachability check at backend startup (_check_print_agent_reachability)"
  - "Database-level ghost-ticket structural invariant (fn_check_ticket_resource_consistency + two deferred constraint triggers, STEP 27)"
  - "RECOVERY.md root-cause documentation for DATA-02 ghost tickets"
affects: [04-03, 04-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Warn-only startup health checks (never raise, never block process start) mirrored from _check_default_secrets"
    - "DEFERRABLE INITIALLY DEFERRED Postgres constraint triggers as a structural invariant backstop, checked at COMMIT time not per-statement"

key-files:
  created: []
  modified:
    - backend/app/__init__.py
    - RECOVERY.md

key-decisions:
  - "health() failure branch returns only type(e).__name__ in a generic message — never the raw exception string or SQLALCHEMY_DATABASE_URI (ASVS V13 info-disclosure mitigation)"
  - "Print-agent check uses the identical PRINT_AGENT_URL env var name/default already defined in backend/app/api/tickets.py so both agree"
  - "Ghost-ticket invariant implemented as two DEFERRABLE INITIALLY DEFERRED constraint triggers (one on tickets, one on resources) rather than a single trigger, closing the gap where a future transaction updates only resources"
  - "Investigation concluded all current ticket/resource-mutating code paths are already atomic (single commit); STEP 27 is a structural backstop against future regression, not a fix for a found bug"
  - "clean_ghost_tickets() and its was_reopened guard left unchanged; no automated cleanup added against any database, per D-06"

patterns-established:
  - "New warn-only startup checks are defined as module-level functions after create_app(), matching _check_default_secrets, and called from create_app() with a fenced comment banner"

requirements-completed: [SUP-04, NET-02, DATA-02]

# Metrics
duration: 5min
completed: 2026-08-09
---

# Phase 04 Plan 01: Health Check, Print-Agent Warning & Ghost-Ticket Invariant Summary

**Real Postgres round-trip on /api/v1/health, warn-only print-agent startup check, and two DEFERRABLE constraint triggers enforcing the ghost-ticket invariant at COMMIT time**

## Performance

- **Duration:** 5 min
- **Started:** 2026-08-09T16:50Z (approx, first commit)
- **Completed:** 2026-08-09T16:52:43-06:00
- **Tasks:** 3 completed
- **Files modified:** 2

## Accomplishments
- `/api/v1/health` now performs `db.session.execute(text('SELECT 1'))` and returns 200 with `db: 'connected'` on success, or 503 with a generic `type(e).__name__`-only error detail on failure — never leaking the raw exception string or `SQLALCHEMY_DATABASE_URI`.
- Backend startup now warns (never blocks) when the print agent at `PRINT_AGENT_URL` is unreachable, via a new `_check_print_agent_reachability(app)` mirroring the existing `_check_default_secrets` warn-only pattern, with a hard 3s timeout.
- `flask init-db` STEP 27 installs `fn_check_ticket_resource_consistency()` plus two `DEFERRABLE INITIALLY DEFERRED` constraint triggers (`trg_ticket_resource_consistency` on `tickets`, `trg_resource_ticket_consistency` on `resources`) that raise `ghost-ticket invariant violated` at transaction commit if an OPEN ticket ever references an AVAILABLE resource without `payment_requested = TRUE`.
- `RECOVERY.md` documents the DATA-02 investigation: every shipped ticket/resource-mutating code path was audited and found already atomic; `request_payment` is the one legitimate exception (guarded by `payment_requested`); the residual risk (direct SQL bypass + superuser `session_replication_role=replica`) is explicitly accepted, not fixed; `clean_ghost_tickets()`/`was_reopened` remain the unchanged manual recovery path.

## Task Commits

Each task was committed atomically:

1. **Task 1: Deepen /api/v1/health with a real Postgres round-trip (D-01, SUP-04)** - `294b4c34` (feat)
2. **Task 2: Warn-only print-agent reachability check at backend startup (D-12/D-13, NET-02)** - `0475f752` (feat)
3. **Task 3: Ghost-ticket structural invariant — deferred constraint triggers (D-04/D-05/D-07, DATA-02)** - `3c06296e` (feat)

_Note: worktree mode — this SUMMARY.md and REQUIREMENTS.md are committed separately by the executor; STATE.md/ROADMAP.md are updated centrally by the orchestrator after all wave agents complete._

## Files Created/Modified
- `backend/app/__init__.py` - deepened `health()`, new `_check_print_agent_reachability(app)` + call site, new STEP 27 (ghost-ticket triggers)
- `RECOVERY.md` - new "Root Cause & Structural Fix — Ghost Tickets (Phase 4 / DATA-02)" section

## Decisions Made
- Reused the exact `PRINT_AGENT_URL` env var/default already defined in `backend/app/api/tickets.py` rather than introducing a second source of truth.
- Chose two triggers (tickets + resources) instead of one to close the gap where a future transaction updates only the `resources` table without touching `tickets`.
- Kept `clean_ghost_tickets()` fully unchanged — STEP 27 is additive prevention, not a replacement for the existing manual recovery tooling (D-06 compliance: no automated cleanup scheduled against any database).

## Deviations from Plan

None — plan executed exactly as written. One self-correction during Task 3: an early draft of the STEP 27 explanatory comment repeated the literal phrase "DEFERRABLE INITIALLY DEFERRED" a third time (in prose, not SQL), which would have broken the plan's exact-count-of-2 acceptance check; reworded the comment before committing so the literal phrase appears exactly twice (both inside the actual `CREATE CONSTRAINT TRIGGER` statements). No functional code was affected — caught during verification, before commit.

## Issues Encountered
The worktree's HEAD was initially on a divergent, much older commit chain unrelated to the expected phase-4 base commit (`5d158087`). Per the worktree branch-check protocol this was corrected with `git reset --hard 5d158087edcf13aa94ba8a417fe683dd59de8800` before any task work began — this is the designated recovery path for a worktree branch that hasn't picked up the expected base yet, not a protected-branch situation (branch remained `worktree-agent-a80963530f140b5e3` throughout).

## User Setup Required

None - no external service configuration required. Live runtime verification (real 503 on DB-down, real warning log on print-agent-down, real trigger firing against a live Postgres) is deferred to Plan 04-04's staging validation, per this plan's own `<verification>` note — this environment has no local Windows/Postgres runtime to exercise those paths against.

## Next Phase Readiness
- `backend/app/__init__.py` and `RECOVERY.md` changes are ready for Plan 04-04's staging validation against a live Postgres/print-agent.
- Plan 04-03 (`check-health.ps1` / native-service probes) can rely on `/api/v1/health`'s new 200/db:connected vs 503 contract unchanged in route path and function name, as required.
- No blockers.

---
*Phase: 04-process-supervision-reliability-hardening*
*Completed: 2026-08-09*

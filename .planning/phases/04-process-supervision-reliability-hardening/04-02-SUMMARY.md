---
phase: 04-process-supervision-reliability-hardening
plan: 02
subsystem: infra
tags: [eventlet, psycopg2, gunicorn, socketio, cooperative-scheduling, monkey-patching]

# Dependency graph
requires:
  - phase: 02-core-service-migration
    provides: backend/wsgi.py and backend/service_entry.py as the native Windows Services entrypoints (NSSM-supervised, no gunicorn)
provides:
  - eventlet.monkey_patch() + psycopg2_patcher.make_psycopg_green() as the first executable lines of both native backend entrypoints
  - Confirmed zero raw threading.Thread( instantiations anywhere in backend/
  - Updated CLAUDE.md architecture description of the native-hosting eventlet setup
  - .planning/phases/04-process-supervision-reliability-hardening/04-DATA-03-VERIFICATION.md documenting the gap, fix, and audit
affects: [04-04-staging-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Native entrypoints (wsgi.py, service_entry.py) must call eventlet.monkey_patch() + psycopg2_patcher.make_psycopg_green() before any other import, since there is no gunicorn EventletWorker to do it implicitly"

key-files:
  created:
    - .planning/phases/04-process-supervision-reliability-hardening/04-DATA-03-VERIFICATION.md
  modified:
    - backend/wsgi.py
    - backend/service_entry.py
    - CLAUDE.md

key-decisions:
  - "Inserted monkey-patching block after service_entry.py's module docstring (preserving it as the file's true first statement) rather than before it, since Python only recognizes a docstring if it is the first statement in the file"
  - "No new dependency needed — eventlet==0.36.1 and psycopg2-binary==2.9.9 were already pinned in backend/requirements.txt"

patterns-established:
  - "Cooperative monkey-patching (eventlet + psycopg2) lives at the very top of every process entrypoint, not inside app factory code, so it always runs before psycopg2/sqlalchemy/Flask app package import anywhere in the process"

requirements-completed: [DATA-03]

# Metrics
duration: 12min
completed: 2026-08-09
---

# Phase 04 Plan 02: Eventlet Cooperative Monkey-Patching Restoration Summary

**Restored DATA-03's eventlet single-worker cooperative-scheduling invariant in the native Windows Services entrypoints by adding explicit `eventlet.monkey_patch()` + `psycopg2_patcher.make_psycopg_green()` calls, closing a silent regression from the Docker-to-native migration plus a pre-existing psycopg2 patching gap that existed even under Docker.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-08-09T22:39:00Z
- **Completed:** 2026-08-09T22:51:41Z
- **Tasks:** 2 completed
- **Files modified:** 4 (2 modified entrypoints, 1 modified doc, 1 new doc)

## Accomplishments
- `backend/wsgi.py` and `backend/service_entry.py` both now call `eventlet.monkey_patch()` and `eventlet.support.psycopg2_patcher.make_psycopg_green()` as the very first executable statements, before any other import
- Confirmed via grep-audit that zero raw `threading.Thread(` instantiations exist anywhere in `backend/` — `socketio.start_background_task` (used in `_spawn_auto_print_chit`) remains the only background-spawning mechanism
- Updated `CLAUDE.md`'s "Single eventlet worker" architecture paragraph to describe the native Windows Services hosting model alongside the existing Docker gunicorn description
- Created `.planning/phases/04-process-supervision-reliability-hardening/04-DATA-03-VERIFICATION.md` documenting the constraint, the gap found, the fix applied, and the grep-audit result

## Task Commits

Each task was committed atomically:

1. **Task 1: Add eventlet + psycopg2 cooperative monkey-patching to both native entrypoints; grep-audit for raw threading** - `f0e5cdae` (fix)
2. **Task 2: DATA-03 verification note + CLAUDE.md architecture update** - `b40e70d1` (docs)

_No TDD tasks in this plan — infra/config-style code changes with no `<behavior>` block._

## Files Created/Modified
- `backend/wsgi.py` - Added `eventlet.monkey_patch()` + `psycopg2_patcher.make_psycopg_green()` as the first 4 executable lines, before `from app import create_app`
- `backend/service_entry.py` - Added the same patching block immediately after the module docstring, before `import os`/`subprocess`/`sys`
- `CLAUDE.md` - Updated the "Single eventlet worker" paragraph to describe `service_entry.py`'s native `socketio.run()` hosting and the explicit monkey-patching now in place
- `.planning/phases/04-process-supervision-reliability-hardening/04-DATA-03-VERIFICATION.md` (new) - DATA-03 verification: constraint, gap, fix, grep-audit, deferred runtime confirmation note

## Decisions Made
- Preserved `service_entry.py`'s module docstring as the file's literal first statement and inserted the patching block right after it, rather than before — Python only recognizes a leading string literal as `__doc__` if it is the very first statement in the module.
- No new dependency installs were required — both `eventlet==0.36.1` and `psycopg2-binary==2.9.9` were already pinned in `backend/requirements.txt`, exactly as the plan's `<interfaces>` section anticipated.

## Deviations from Plan

None - plan executed exactly as written. The grep-audit for raw `threading.Thread(` came back clean (zero matches), matching the plan's expectation that `socketio.start_background_task` was already the only spawning mechanism in the codebase — no additional fix was required for that part of Task 1.

## Issues Encountered

None. The `<worktree_branch_check>` setup step required a `git reset --hard` to correct the worktree's base commit before execution began (merge-base mismatch against the expected phase-4 commit `5d158087`); this is a normal part of the worktree-agent startup protocol, not a plan-execution issue.

## User Setup Required

None - no external service configuration required. This is a code-only fix; live runtime confirmation on Windows/eventlet is explicitly deferred to Plan 04-04, which has an actual staging machine to test against (this execution environment has none).

## Next Phase Readiness

- Both native entrypoints (`backend/wsgi.py`, `backend/service_entry.py`) are ready for staging deployment in Plan 04-04, where the eventlet hub's runtime responsiveness under concurrent load (Socket.IO broadcast correctness, non-serialized DB calls) can actually be exercised on real Windows/eventlet hardware.
- `.planning/phases/04-process-supervision-reliability-hardening/04-DATA-03-VERIFICATION.md` is available as the DATA-03 evidence artifact for phase completion / requirements traceability.
- No blockers identified for downstream plans in this phase.

---
*Phase: 04-process-supervision-reliability-hardening*
*Completed: 2026-08-09*

---
phase: 04-process-supervision-reliability-hardening
plan: 04
subsystem: infra
tags: [staging-validation, eventlet, sqlalchemy, nssm, windows-services, postgres, print-agent, telegram-bot]

# Dependency graph
requires:
  - phase: 04-process-supervision-reliability-hardening
    provides: "Plans 04-01 (deepened health check, print-agent warn check, ghost-ticket triggers), 04-02 (eventlet/psycopg2 monkey-patching), 04-03 (check-health.ps1, configure-postgres-failure-recovery.ps1) — all deployed and exercised live here for the first time"
provides:
  - "Real staging-machine evidence (not just static code review) for NET-02, SUP-04, DATA-02, DATA-03, and partial SUP-01"
  - "BilliardBarPrintAgent installed and Running on staging for the first time"
  - "Postgres native crash-restart policy applied and confirmed on staging"
  - "Two real, previously-undetected bugs found via live execution and fixed: a false-positive print-agent-unreachable warning (eventlet localhost DNS resolution), and a deterministic 500 on ticket creation (legacy SQLAlchemy Query.get()+with_for_update() under real eventlet request dispatch)"
  - "TelegramBot's crash-loop root-caused as a shared-TELEGRAM_TOKEN Conflict with a live poller (almost certainly production) — documented, left Stopped, not a code bug"
affects: [04-05-live-crash-reboot-tests, phase-5-cutover]

tech-stack:
  added: []
  patterns:
    - "db.session.get(Model, id, with_for_update=True) instead of legacy Query.get()+with_for_update() for row-locked lookups under eventlet-hosted request dispatch"
    - "IP literals (127.0.0.1) instead of 'localhost' for intra-host HTTP calls made from eventlet-monkey-patched Python code on Windows"

key-files:
  created:
    - .planning/phases/04-process-supervision-reliability-hardening/04-VALIDATION.md
  modified:
    - backend/app/api/tickets.py
    - backend/app/api/waiting_list.py
    - backend/app/services/inventory_svc.py
    - backend/app/__init__.py
    - backend/app/api/queue.py
    - .env.example
    - scripts/install-nssm-backend.ps1
    - scripts/reconfigure-secrets.ps1

key-decisions:
  - "User decision: fix the ticket-creation 500 bug (Finding C) immediately rather than defer — swapped 14 bare Query.get()+with_for_update() call sites to db.session.get(..., with_for_update=True), not the dominant get_or_404() pattern, because every site had custom None-handling logic that get_or_404()'s abort(404) semantics would have silently broken"
  - "User decision: fix the print-agent DNS bug (Finding B) immediately rather than defer — changed PRINT_AGENT_URL default from localhost to 127.0.0.1 everywhere it's hardcoded, including the DPAPI-preserving reconfigure-secrets.ps1 path already deployed on staging"
  - "User decision: leave TelegramBot Stopped and document only — the shared-TELEGRAM_TOKEN Conflict with a live production poller is an environment-separation issue, not a code bug in this repo, and starting it would repeatedly contend with production's real bot"
  - "Both fixes are a scope expansion beyond 04-04-PLAN.md's declared files_modified (which only listed 04-VALIDATION.md, install-nssm-telegram-bot.ps1, telegram-bot/bot.py) — explicitly approved by the user after reviewing the Task 1 checkpoint report"

patterns-established:
  - "When eventlet.monkey_patch() is active, prefer IP literals over 'localhost' for any outbound HTTP call in Python code on Windows — eventlet's greendns can fail to resolve 'localhost' even though the OS's own resolver (and PowerShell/curl) handle it fine"
  - "When adding a new Model.query.with_for_update().get(id) call, use db.session.get(Model, id, with_for_update=True) instead — the legacy Query.get() form is unsafe under eventlet's real request-dispatch path on this stack"

requirements-completed: [NET-02, SUP-04, DATA-02, DATA-03, SUP-01]

# Metrics
duration: ~2h (Task 1 live diagnostics/deployment + 2 found-and-fixed bugs + re-verification + Task 2 documentation)
completed: 2026-08-09
---

# Phase 4 Plan 04: Staging Validation & Live Bug Fixes Summary

**Deployed Plans 04-01/04-02/04-03 to real staging hardware for the first time, found and fixed two live-only bugs (a false-positive print-agent warning caused by eventlet's broken "localhost" DNS resolution, and a deterministic 500 on ticket creation caused by legacy SQLAlchemy Query.get() under real eventlet request dispatch), and root-caused TelegramBot's crash-loop as a shared-token conflict with a live production poller.**

## Performance

- **Duration:** ~2 hours (real SSH-driven diagnostics, two live-bug investigations, fixes, re-verification, documentation)
- **Completed:** 2026-08-09
- **Tasks:** 2 (Task 1: checkpoint:human-action deploy/diagnose, resumed with fix instructions; Task 2: write 04-VALIDATION.md)
- **Files modified:** 8 source/script files (2 commits) + 1 new doc file (1 commit)

## Accomplishments

- All 6 files from Plans 04-01/04-02/04-03 pushed to and exercised on the real staging Windows machine (WIDOWSVAIL) — deepened health endpoint, print-agent warn check, ghost-ticket structural triggers, eventlet/psycopg2 monkey-patching, `check-health.ps1`, and Postgres failure-recovery policy all confirmed working against live Postgres/backend.
- `BilliardBarPrintAgent` installed and confirmed `Running` on staging for the first time.
- Postgres native crash-restart policy (`sc.exe failure`, 3x restart/5000ms, 1hr reset window) applied and confirmed via `sc.exe qfailure`.
- Found and fixed a real, deterministic bug: `Model.query.with_for_update().get(id)` throws `sqlalchemy.exc.InvalidRequestError` under the real eventlet-hosted request path — broke ticket creation (`POST /api/v1/tickets` → 500). Fixed at all 14 affected call sites across `tickets.py`, `waiting_list.py`, `inventory_svc.py`.
- Found and fixed a real bug: eventlet's monkey-patched DNS resolver fails to resolve `"localhost"` on this Windows environment, causing a false-positive print-agent-unreachable warning and would have broken real print dispatch. Fixed by switching the `PRINT_AGENT_URL` default to `127.0.0.1` everywhere it's hardcoded.
- Root-caused TelegramBot's pre-existing crash-loop (previously undiagnosed since before Phase 3) as a Telegram API `Conflict: terminated by other getUpdates request` — staging shares the same `TELEGRAM_TOKEN` as a live production poller. Documented, left `Stopped` per explicit user decision, not a code bug.
- `.planning/phases/04-process-supervision-reliability-hardening/04-VALIDATION.md` records real, staging-sourced PASS/FAIL/PARTIAL evidence for NET-02, SUP-04, DATA-02, DATA-03, and SUP-01 (partial).

## Task Commits

Task 1 (checkpoint:human-action) itself required no repo commit — it was pure SSH deployment/diagnostic work against staging. After the user reviewed the Task 1 checkpoint report and approved fixing the two discovered bugs, those fixes and Task 2 were committed atomically:

1. **Fix Finding C (ticket-creation 500)** — `a3fe34e4` (fix): replaced all 14 bare `Model.query.with_for_update().get(id)` call sites with `db.session.get(Model, id, with_for_update=True)` across `tickets.py`, `waiting_list.py`, `inventory_svc.py`.
2. **Fix Finding B (print-agent DNS)** — `cd86b4d9` (fix): changed `PRINT_AGENT_URL` default from `http://localhost:9191` to `http://127.0.0.1:9191` in `backend/app/__init__.py`, `backend/app/api/queue.py`, `.env.example`, `scripts/install-nssm-backend.ps1`, `scripts/reconfigure-secrets.ps1` (the `tickets.py` portion of this fix was already included in commit `a3fe34e4` — see Deviations below).
3. **Task 2: 04-VALIDATION.md** — `03a502e3` (docs): recorded staging evidence for all 5 requirements.

_Note: this plan is `autonomous: false` with a `checkpoint:human-action` Task 1 — no plan-metadata commit is added separately since Task 2's commit already covers the plan's documented output._

## Files Created/Modified

- `.planning/phases/04-process-supervision-reliability-hardening/04-VALIDATION.md` — real staging evidence for NET-02/SUP-04/DATA-02/DATA-03/SUP-01 (partial)
- `backend/app/api/tickets.py` — 3 `db.session.get(..., with_for_update=True)` fixes (open_ticket, transfer_ticket, reopen_ticket) + `PRINT_AGENT_URL` default fix
- `backend/app/api/waiting_list.py` — 2 `db.session.get(..., with_for_update=True)` fixes (`_cancel_seated_ticket`, `transfer_to_pool`)
- `backend/app/services/inventory_svc.py` — 9 `db.session.get(..., with_for_update=True)` fixes across `_lock_sorted`, `restock_drinks`, `restock_food_portions`, `check_stock_for_item`, `consume_for_line_item`, `reverse_for_line_item`, `record_waste`, `record_count_adjustment`, `manual_adjust`
- `backend/app/__init__.py` — `PRINT_AGENT_URL` default fix (print-agent startup reachability check)
- `backend/app/api/queue.py` — `PRINT_AGENT_URL` default fix (kitchen/bar chit dispatch)
- `.env.example` — `PRINT_AGENT_URL` default fix + explanatory comment
- `scripts/install-nssm-backend.ps1` — `PRINT_AGENT_URL` default fix (fresh-install path)
- `scripts/reconfigure-secrets.ps1` — `PRINT_AGENT_URL` default fix (the DPAPI-sourced path actually live on staging; re-applied there in a targeted, TelegramBot-untouched way, not via a full script re-run)

## Decisions Made

- Fixed both live-discovered bugs immediately (user-approved scope expansion beyond this plan's declared `files_modified`) rather than deferring to a future plan, since both were confirmed, deterministic, and directly relevant to requirements this exact plan validates (DATA-02's smoke test, NET-02's warning check).
- Used `db.session.get(Model, id, with_for_update=True)` (SQLAlchemy 2.0's native API) instead of blindly swapping to the codebase's dominant `.get_or_404()` pattern — every one of the 14 affected call sites has its own custom None-handling (JSON error responses matching this codebase's `{'error': CODE}` convention, `raise ValueError` with a documented `Raises:` contract, or silent skip-continue in an aggregation loop) that `get_or_404()`'s Flask `abort(404)` semantics would have silently changed or broken.
- Did not re-run the full `reconfigure-secrets.ps1` on staging to apply the `PRINT_AGENT_URL` fix, since that would have also restarted `BilliardBarTelegramBot` — directly conflicting with the explicit decision to leave it `Stopped`. Instead applied a targeted, staging-only script (not committed to the repo) that replicates only the Backend-section logic of `reconfigure-secrets.ps1`, preserving all DPAPI-sourced secrets and touching only `BilliardBarBackend`.
- Left TelegramBot `Stopped` and undiagnosed-no-further — the real root cause (shared `TELEGRAM_TOKEN` with a live poller, almost certainly production) is an environment-separation problem, not fixable within this codebase's files.

## Deviations from Plan

### Auto-fixed Issues (user-approved scope expansion)

**1. [User-directed, Rule 1-equivalent] Fixed a deterministic 500 on ticket creation (legacy SQLAlchemy `Query.get()` under eventlet)**
- **Found during:** Task 1's required DATA-02 smoke test (open ticket → close ticket)
- **Issue:** `Model.query.with_for_update().get(id)` throws `sqlalchemy.exc.InvalidRequestError: Incorrect number of values in identifier` when invoked via the real eventlet-hosted `socketio.run()` request path — not reproducible via Flask's `test_client()` or an isolated script. Broke `POST /api/v1/tickets` (500) and would have broken 13 other call sites under live concurrent load.
- **Fix:** Replaced all 14 bare `.with_for_update().get(id)` call sites with `db.session.get(Model, id, with_for_update=True)` across `tickets.py` (3), `waiting_list.py` (2), `inventory_svc.py` (9), preserving each site's original None-handling.
- **Files modified:** `backend/app/api/tickets.py`, `backend/app/api/waiting_list.py`, `backend/app/services/inventory_svc.py`
- **Verification:** Re-ran the smoke test live against staging twice — `POST /api/v1/tickets` → `201`, `POST .../close` → `200`, both times.
- **Committed in:** `a3fe34e4`

**2. [User-directed, Rule 1-equivalent] Fixed a false-positive print-agent-unreachable warning (eventlet `localhost` DNS resolution)**
- **Found during:** Task 1's required print-agent warn/OK log transition check
- **Issue:** `eventlet.monkey_patch()` (Plan 04-02, DATA-03) replaces Python's DNS resolution with eventlet's `greendns`, which raises `socket.gaierror: No address found` for `"localhost"` on this Windows environment while `127.0.0.1` works fine. Caused a false `WARNING app Print agent ... is unreachable` on every backend startup even with the print agent confirmed `Running` and reachable via PowerShell, and would have broken the real print dispatch in `tickets.py`/`queue.py`, which share the same default.
- **Fix:** Changed `PRINT_AGENT_URL`'s hardcoded default from `http://localhost:9191` to `http://127.0.0.1:9191` in `backend/app/__init__.py`, `backend/app/api/tickets.py`, `backend/app/api/queue.py`, `.env.example`, `scripts/install-nssm-backend.ps1`, `scripts/reconfigure-secrets.ps1`.
- **Files modified:** `backend/app/__init__.py`, `backend/app/api/tickets.py`, `backend/app/api/queue.py`, `.env.example`, `scripts/install-nssm-backend.ps1`, `scripts/reconfigure-secrets.ps1`
- **Verification:** Re-applied the fix to staging's already-deployed `BilliardBarBackend` `AppEnvironmentExtra` (targeted, DPAPI-preserving, TelegramBot-untouched) and restarted. `backend_err.log` now shows `INFO app Print agent reachable at http://127.0.0.1:9191`, no warning.
- **Committed in:** `cd86b4d9` (and, for `tickets.py`'s portion specifically, bundled into `a3fe34e4` as a minor commit-packaging artifact — both edits had already landed in that file before the first `git add`)

---

**Total deviations:** 2 user-approved auto-fixes (both scope expansions beyond 04-04-PLAN.md's declared `files_modified`, explicitly approved by the user after reviewing the Task 1 checkpoint report before any fix work began).
**Impact on plan:** Both fixes were essential for correctness — DATA-02's own acceptance criteria requires the smoke test to pass, and NET-02's acceptance criteria requires the print-agent check to genuinely reflect reachability. No unrelated scope creep; both fixes are narrowly targeted at the two exact bugs found.

## Known Non-Fixes (documented, not code bugs)

**TelegramBot crash-loop — root-caused, not fixed.** Real cause: staging's `TELEGRAM_TOKEN` is the same literal value as a live poller (almost certainly the production bar machine's own telegram-bot container), and Telegram's Bot API permits only one active `getUpdates` long-poll connection per token — manifesting as `telegram.error.Conflict`, which plausibly also explains the historical opaque "The parameter is incorrect" NSSM exit code (an unhandled asyncio exception surfacing oddly under `pythonw.exe`'s windowless hosting). This is an environment-separation/credential-isolation issue, not a bug in `bot.py` or `install-nssm-telegram-bot.ps1` — per explicit user decision, left `Stopped` and documented in `04-VALIDATION.md`, not fixed in this task. Resolving it requires a staging-specific Telegram bot token, out of scope here.

**Postgres SCM PID/listener mismatch on staging — documented, not a code defect.** `Stop-Service postgresql-x64-15` is blocked by Windows SCM's dependent-service check (Backend/Nginx/Scheduler are declared dependents), and the SCM-registered PID doesn't match the actual listening postmaster PID. Not a defect in `configure-postgres-failure-recovery.ps1` (which was verified to apply correctly regardless) — flagged in `04-VALIDATION.md` as a follow-up worth investigating before Plan 04-05's live crash/reboot tests.

## Issues Encountered

- Windows SCM refused `Stop-Service postgresql-x64-15` due to a dependent-service chain; worked around by identifying and terminating the actual listening `postgres.exe` process directly (the SCM-registered PID differed from the real listener — see above), to genuinely exercise SUP-04's health-check failure path. Postgres was confirmed running again before proceeding, and this did not leave the database down at any point after the test.
- The full `reconfigure-secrets.ps1` script would have restarted `BilliardBarTelegramBot` as a side effect of reconfiguring all 3 secret-consuming services in one pass — worked around by applying a targeted, staging-only equivalent of just its Backend-section logic (not committed to the repo, since the repo-tracked fix to `reconfigure-secrets.ps1` itself is sufficient for any future full re-run).

## User Setup Required

None — no external service configuration required. (TelegramBot's resolution requires a staging-specific bot token, which is a future decision, not an immediate setup step for this plan.)

## Next Phase Readiness

- Plans 04-01/04-02/04-03's code is now confirmed working on real staging hardware, with two real bugs found and fixed along the way — Plan 04-05's live crash/reboot tests can build on a genuinely working deployed state, not just unexecuted code.
- Postgres's SCM PID/listener mismatch and blocked `Stop-Service` behavior (documented above) should be accounted for when Plan 04-05 designs its Postgres kill-isolation test.
- TelegramBot remains `Stopped` on staging and will need its own resolution path (staging-specific token) before SUP-01's full 6-service kill-isolation matrix in Plan 04-05 can meaningfully include it — otherwise it will only ever show "Stopped" / not applicable for that specific service.

---
*Phase: 04-process-supervision-reliability-hardening*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: `.planning/phases/04-process-supervision-reliability-hardening/04-VALIDATION.md`
- FOUND: `.planning/phases/04-process-supervision-reliability-hardening/04-04-SUMMARY.md`
- FOUND: commit `a3fe34e4` (SQLAlchemy `db.session.get()` fix)
- FOUND: commit `cd86b4d9` (PRINT_AGENT_URL DNS fix)
- FOUND: commit `03a502e3` (04-VALIDATION.md)
- FOUND: all 8 modified source/script files on disk
- CONFIRMED: zero remaining bare `Model.query.with_for_update().get(` occurrences in `backend/`

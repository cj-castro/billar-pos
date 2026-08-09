---
phase: 02-core-service-migration
plan: 02
subsystem: infra
tags: [nssm, windows-services, powershell, scheduler, telegram-bot, apscheduler]

# Dependency graph
requires:
  - phase: 01-hosting-decision-validation
    provides: "Decision to use native Windows Services (NSSM) over Docker/WSL2/Podman/etc., and the production-proven install-nssm-print-agent.ps1 pattern this plan copies"
provides:
  - "scripts/install-nssm-scheduler.ps1 — registers BilliardBarScheduler (backend/scheduler.py) as an independent native Windows Service in its own venv"
  - "scripts/install-nssm-telegram-bot.ps1 — registers BilliardBarTelegramBot (telegram-bot/bot.py) as an independent native Windows Service in its own venv"
affects: [02-05-plan-staging-validation, 04-reliability-hardening]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-DotEnv PowerShell function: parses repo-root .env into a hashtable at install time so NSSM install scripts never hardcode secrets"
    - "One dedicated virtualenv per native Windows Service (D-07), even when two services share requirements.txt (backend vs scheduler_venv)"
    - "NSSM AppEnvironmentExtra key=value list built as literal 'KEY=' + value strings so install-time and file-scan verification both see the same text"

key-files:
  created:
    - scripts/install-nssm-scheduler.ps1
    - scripts/install-nssm-telegram-bot.ps1
  modified: []

key-decisions:
  - "install-nssm-backend.ps1 (referenced by the plan as the Read-DotEnv source) does not exist yet in this worktree — Plan 01 (wave 1, parallel, different worktree) creates it. Implemented an equivalent self-contained Read-DotEnv function in both scripts instead of importing/dot-sourcing a file that may not exist at merge time; functionally identical parsing logic (KEY=VALUE lines, # comments skipped, optional quote stripping)."
  - "Scheduler service uses backend/requirements.txt in a dedicated backend/scheduler_venv (not backend/venv) to satisfy D-07's per-service-venv rule even though the dependency set is identical to the backend."
  - "Telegram bot service warns but does not block install when TELEGRAM_TOKEN/ADMIN_CHAT_ID are missing from .env, relying on NSSM's AppExit Default Restart + 5s delay to avoid a tight crash loop (per T-02-07 mitigation in the plan's threat model)."

requirements-completed: [SVC-04, SVC-05]

# Metrics
duration: 15min
completed: 2026-08-08
---

# Phase 02 Plan 02: NSSM Windows Service Scripts for Scheduler and Telegram Bot Summary

**Two standalone NSSM install scripts (BilliardBarScheduler, BilliardBarTelegramBot) that copy the production-proven print-agent pattern, each running the target Python entrypoint directly in its own virtualenv, sourcing all secrets from `.env` at install time.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-08-08T18:41:00-06:00 (approx, first task commit 18:41:50)
- **Completed:** 2026-08-08T18:42:40-06:00
- **Tasks:** 2
- **Files modified:** 2 (both new files)

## Accomplishments
- `scripts/install-nssm-scheduler.ps1` registers `BilliardBarScheduler` pointed directly at `backend/scheduler.py`, using its own `backend\scheduler_venv` virtualenv (separate from the backend's own venv, D-07), with `AppEnvironmentExtra` built from `.env` (SECRET_KEY, TZ, SMTP_*, REPORT_*, FLASK_APP, and a `localhost:5432`-based `DATABASE_URL`).
- `scripts/install-nssm-telegram-bot.ps1` registers `BilliardBarTelegramBot` pointed directly at `telegram-bot/bot.py`, using its own `telegram-bot\venv` virtualenv installed from `telegram-bot/requirements.txt`, setting all three env vars `bot.py` hard-requires at import time (`TELEGRAM_TOKEN`, `ADMIN_CHAT_ID`, `DATABASE_URL`).
- Both scripts follow the exact NSSM registration shape of `scripts/install-nssm-print-agent.ps1` (locate/install NSSM, venv setup, `nssm install`/`set` calls, `AppRotateFiles`/`AppRotateBytes`, `Start SERVICE_AUTO_START`, `ObjectName LocalSystem`, `AppExit Default Restart` + `AppRestartDelay 5000`, post-start `Get-Service` verification).
- Neither script hardcodes any secret value — both parse the git-ignored repo-root `.env` via a local `Read-DotEnv` function at install time, falling back to the same defaults documented in `docker-compose.yml` when a key is absent.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write the NSSM install script for the scheduler service** - `48e864ee` (feat)
2. **Task 2: Write the NSSM install script for the Telegram bot service** - `8bfee90c` (feat)

**Plan metadata:** committed separately by the orchestrator after wave merge (worktree mode — this agent does not commit STATE.md/ROADMAP.md).

## Files Created/Modified
- `scripts/install-nssm-scheduler.ps1` - NSSM installer for `BilliardBarScheduler`; own venv at `backend\scheduler_venv`, targets `backend\scheduler.py` directly, sources SMTP/SECRET_KEY/TZ/REPORT_* + `localhost:5432` DATABASE_URL from `.env`
- `scripts/install-nssm-telegram-bot.ps1` - NSSM installer for `BilliardBarTelegramBot`; own venv at `telegram-bot\venv`, targets `telegram-bot\bot.py` directly, sources TELEGRAM_TOKEN/ADMIN_CHAT_ID + `localhost:5432` DATABASE_URL from `.env`, warns (non-blocking) if either bot secret is missing

## Decisions Made
- Built each `AppEnvironmentExtra` DATABASE_URL entry as a single literal `"DATABASE_URL=postgresql://${PgUser}:${PgPassword}@localhost:5432/${PgDb}"` string (rather than concatenating a separately-named `$DatabaseUrl` variable at the call site) so both the runtime value and the plan's automated grep-based verification see the same `DATABASE_URL=postgresql://...localhost:5432` text.
- Used `backend/requirements.txt` for the scheduler's venv (same dependency set as the backend) but a physically separate venv directory (`backend\scheduler_venv`), per D-07 and the plan's explicit instruction not to reuse `backend\venv`.
- Telegram bot's venv is naturally isolated because it installs from `telegram-bot/requirements.txt` (python-telegram-bot, sqlalchemy, psycopg2-binary, apscheduler) — a completely different package set from the backend/scheduler.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Read-DotEnv pattern reimplemented locally instead of reused from a nonexistent file**
- **Found during:** Task 1 (reading `<read_first>` / `<interfaces>` references before writing the scheduler script)
- **Issue:** The plan instructs both scripts to "Reuse the same Read-DotEnv PowerShell function pattern as scripts/install-nssm-backend.ps1", but that file does not exist in this worktree — it's created by Plan 01, which runs in a parallel wave-1 worktree not yet merged into this one at execution time.
- **Fix:** Implemented a self-contained `Read-DotEnv` function directly in both `install-nssm-scheduler.ps1` and `install-nssm-telegram-bot.ps1` (parses `.env` lines as `KEY=VALUE`, skips blank/`#` lines, strips optional surrounding quotes) rather than dot-sourcing or importing a file that may not exist at merge time. This keeps both scripts self-contained and functional standalone, and matches the intent (secrets sourced from `.env`, never hardcoded) even though the exact byte-for-byte function isn't literally copied from Plan 01's file.
- **Files modified:** scripts/install-nssm-scheduler.ps1, scripts/install-nssm-telegram-bot.ps1
- **Verification:** Both scripts parse `.env` correctly in isolation (self-contained, no cross-file dependency); acceptance-criteria greps for `AppEnvironmentExtra`, `DATABASE_URL=postgresql://`, `localhost:5432`, `TELEGRAM_TOKEN`, `ADMIN_CHAT_ID` all pass.
- **Committed in:** `48e864ee` (Task 1), `8bfee90c` (Task 2)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep — the plan's intent (no hardcoded secrets, `.env`-sourced at install time) is fully met; the only change is that the parsing function is duplicated locally in each script rather than referencing a file this wave's other worktree hasn't merged yet. When Plan 01 merges its own `install-nssm-backend.ps1`, a future cleanup could optionally consolidate all three `Read-DotEnv` copies into a shared `scripts/lib/*.ps1` helper, but that's out of this plan's scope.

## Issues Encountered
None beyond the Read-DotEnv dependency noted above.

## User Setup Required
None - no external service configuration required by this plan. Actual service installation, `.env` population with real SMTP/Telegram credentials, and independence-from-backend-crash verification happen on the staging Windows machine in Plan 05's checkpoint, not here (per this plan's own `<verification>` section).

## Next Phase Readiness
- Both `.ps1` scripts exist, are syntactically self-consistent with the print-agent's proven NSSM pattern, and pass all automated acceptance-criteria greps (service names, direct entrypoint targeting with no wrapper, separate per-service venvs, `localhost:5432` DATABASE_URL construction, `AppExit Default Restart`, no hardcoded secrets).
- Ready for Plan 05's staging-machine checkpoint to actually run these installers and verify `Get-Service -Name BilliardBarScheduler`/`BilliardBarTelegramBot` report `Running`, and that killing the backend service does not affect either.
- Once Plan 01's `install-nssm-backend.ps1` merges, its `Read-DotEnv` implementation should be diffed against this plan's copies to confirm no behavioral drift (low risk — same simple KEY=VALUE parsing contract).

## Threat Flags

None — this plan's `<threat_model>` (T-02-05 secrets sourcing, T-02-06 LocalSystem, T-02-07 crash-loop, T-02-08 TLS spoofing) already covers all security-relevant surface introduced by these two scripts; no new unmitigated surface was found.

---
*Phase: 02-core-service-migration*
*Completed: 2026-08-08*

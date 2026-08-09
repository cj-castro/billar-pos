---
phase: 03-centralized-logging-secrets
plan: 02
subsystem: infra
tags: [flask, config, secrets, dotenv, app-factory]

# Dependency graph
requires:
  - phase: 02-core-service-migration
    provides: native Windows Services (NSSM-wrapped backend/scheduler/bot/nginx + print agent) that call create_app() at startup
provides:
  - _check_default_secrets(app) warn-only insecure-default-secret detector wired into backend/app/__init__.py's create_app()
  - .env.example documenting every non-secret config value and pointing every SEC-01-scoped secret at Credential Manager
affects: [03-03-secrets-migration, 03-04, phase-05-live-cutover]

# Tech tracking
tech-stack:
  added: []
  patterns: [warn-only startup validation (no sys.exit) for insecure-default detection]

key-files:
  created: [.env.example]
  modified: [backend/app/__init__.py]

key-decisions:
  - "Followed D-11/D-12 exactly: detector lives in one place (backend/app/__init__.py create_app()), runs for every entrypoint, never exits — only logs + prints a banner"
  - "SMTP_USER/SMTP_PASSWORD intentionally excluded from the check per plan interfaces block — empty is an expected non-warning state for opt-in email reporting"
  - ".env.example placeholders for secrets use commented-out `KEY=` lines with a Credential Manager pointer comment, never a real-looking value, to satisfy T-03-07's mitigation"

patterns-established:
  - "Warn-only startup checks: build a warnings list, log via app.logger.warning + a print() banner, never sys.exit/raise inside the check function"

requirements-completed: [SEC-02]

# Metrics
duration: 20min
completed: 2026-08-09
---

# Phase 3 Plan 2: Insecure-Default-Secret Detector + .env.example Summary

**Warn-only `_check_default_secrets()` in the Flask app factory catches 11 known-insecure secret defaults (SECRET_KEY, JWT_REFRESH_SECRET_KEY, POSTGRES_PASSWORD-in-DATABASE_URL, 8 role passwords/PINs) without ever blocking startup, plus the repo's first `.env.example` documenting all non-secret config and pointing every SEC-01-scoped secret at Credential Manager.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-09T19:35:00Z (approx.)
- **Completed:** 2026-08-09T19:55:08Z
- **Tasks:** 2/2 completed
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- Added `_check_default_secrets(app)` to `backend/app/__init__.py`, called once inside `create_app()` right after `logging.basicConfig(...)` and before `db.init_app(app)` — runs for every process that builds the app (service_entry.py, scheduler.py, `flask` CLI), satisfying D-12's single-implementation requirement.
- The detector checks: `SECRET_KEY` against both known Docker/config.py defaults, `JWT_REFRESH_SECRET_KEY` against both known defaults, `SQLALCHEMY_DATABASE_URI` for the `billiard_secret` substring or the exact config.py literal default, and all 8 role passwords/PINs (`ADMIN_PASSWORD`/`ADMIN_PIN`/`MANAGER_PASSWORD`/`MANAGER_PIN`/`WAITER1_PASSWORD`/`WAITER2_PASSWORD`/`KITCHEN_PASSWORD`/`BARSTAFF_PASSWORD`) read directly from `os.environ` (matching how `seed.py` reads them, not via `app.config`).
- When any check trips, one multi-line warning is logged via `app.logger.warning(...)` and also `print()`-ed inside a `"="*70` banner so it cannot be missed even before the consolidated log file (Plan 03-01) is flushed. The function contains no `sys.exit`/`exit(`/bare `raise` — service keeps starting even with every secret at its default, per D-11.
- Created `.env.example` at the repo root (never existed before) — documents all 17 non-secret env vars (`POSTGRES_DB`, `POSTGRES_USER`, `BILLING_MODE`, `POOL_RATE_CENTS`, `HAPPY_HOUR_START/END`, `HAPPY_HOUR_DISCOUNT_PCT`, `CURRENCY`, `TZ`, `LOG_LEVEL`, `JWT_ACCESS_HOURS`, `RATELIMIT_STORAGE_URI`, `FLASK_ENV`, `PRINT_AGENT_URL`, `FRONTEND_PORT`, `REPORT_FROM`, `REPORT_TO`, `ADMIN_CHAT_ID`) with the same default/placeholder values `config.py`/`docker-compose.yml` use, plus a clearly separated bottom section listing all 16 SEC-01-scoped secrets (D-07) as commented-out lines pointing to Credential Manager / `scripts/migrate-secrets-to-dpapi.ps1`, with zero real-looking values anywhere in the file.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add `_check_default_secrets()` warn-only check to the app factory** - `24496be3` (feat)
2. **Task 2: Create `.env.example`** - `a74a3287` (docs)

_No plan-metadata commit — orchestrator owns STATE.md/ROADMAP.md updates for this parallel wave._

## Files Created/Modified
- `backend/app/__init__.py` - Added `import os`, defined `_check_default_secrets(app)` after `create_app()`, wired a single call to it inside `create_app()` right after `logging.basicConfig(...)`.
- `.env.example` - New file: non-secret config template + Credential Manager pointers for all in-scope secrets.

## Decisions Made
- Followed the plan's `<interfaces>` block precisely over the (slightly looser) `03-PATTERNS.md` reference implementation where they diverged: excluded `SMTP_USER`/`SMTP_PASSWORD` from the check entirely (plan says don't check them at all; PATTERNS.md's sketch checked them against `'default'`/`'CHANGE_ME'`), and added the `SQLALCHEMY_DATABASE_URI` substring/exact-literal check that PATTERNS.md's sketch omitted. The PLAN.md acceptance criteria are the authoritative spec for this plan.
- Read role secrets via `os.environ.get(key)` directly (not `app.config.get(key)`) since `backend/seed.py` reads them the same way and they are not defined on the `Config` class at all.

## Deviations from Plan

None - plan executed exactly as written. Both tasks' automated `<verify>` blocks and acceptance criteria pass as specified.

## Issues Encountered
- The plan's own verification regex (`'exit(' not in fn.group(0)`) is a naive substring check that would have flagged doc-comment text like "never call sys.exit/raise/exit(1)" even though no actual exit call exists in the function body. Worked around by rephrasing the docstring/inline comments to avoid the literal substrings `exit(` and `sys.exit` while still describing the D-11 constraint in prose. Not a deviation from the plan's intent — the function still contains zero actual exit/raise statements, confirmed by both `ast.parse` and manual review.

## User Setup Required

None - no external service configuration required. `.env.example` documents what a future `cp .env.example .env` + manual fill-in will need for local Docker development; no action required for this plan itself.

## Next Phase Readiness
- Plan 03-03 (secrets migration to DPAPI/Credential Manager) can proceed independently — this plan's detector will immediately start warning if 03-03's migration script ever leaves a secret at its Docker-default placeholder value on a real machine, which is its intended safety-net role per the phase objective.
- No blockers for other Phase 3 plans (03-01 log consolidation, 03-03 secrets migration, 03-04) — this plan touched only `backend/app/__init__.py` and the new `.env.example`, both disjoint from the other parallel plans' files.

---
*Phase: 03-centralized-logging-secrets*
*Completed: 2026-08-09*

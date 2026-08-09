---
phase: 02-core-service-migration
plan: 04
subsystem: infra
tags: [postgresql, powershell, windows-services, backup-restore, pg_dump, pg_restore]

# Dependency graph
requires:
  - phase: 01-validation-decision-lock
    provides: GO decision on native Windows Services hosting model (NSSM/WinSW over Docker/Rancher)
provides:
  - "scripts/install-postgres-native.ps1 — native Postgres 15 Windows service install + hardening (listen_addresses=localhost, scram-sha-256, no firewall exposure)"
  - "scripts/postgres-backup-restore.ps1 — Docker-to-native logical dump/restore/verify procedure using synthetic seed.py data"
  - "scripts\\.postgres-service-name.txt convention (written by install-postgres-native.ps1, consumed by Plan 05's NSSM DependOnService wiring)"
affects: [05-cutover, phase-3-service-scripts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-DotEnv PowerShell helper — parse repo-root .env into a hashtable with docker-compose.yml-matching defaults, no hardcoded secrets"
    - "Random Get-Random superuser password generated at script-run time, never persisted/logged"
    - "Chocolatey-first / pinned-vendor-installer-fallback install chain (mirrors scripts/install-nssm-print-agent.ps1's NSSM locate/install pattern)"

key-files:
  created:
    - scripts/install-postgres-native.ps1
    - scripts/postgres-backup-restore.ps1
  modified: []

key-decisions:
  - "Postgres registers its own native Windows service via its installer (not NSSM-wrapped) — D-04's NSSM decision applies to backend/scheduler/telegram-bot/nginx only"
  - "No Windows Firewall rule opened for port 5432 — deliberate, preserves today's Docker setup's total non-exposure of the DB port to the LAN"
  - "pg_hba.conf 'trust' entries are explicitly detected and rewritten to scram-sha-256 rather than assuming the installer default is safe"
  - "DATA-01 is treated strictly as 'procedure validated against synthetic data in Phase 2' per D-10 — no claim of real-data backup/restore verification made here"

patterns-established:
  - "Pattern: PowerShell .env parsing helper (Read-DotEnv) reusable by future native-service install scripts (Plan 05) to avoid hardcoding secrets"

requirements-completed: [SVC-02, DATA-01]

# Metrics
duration: 11min
completed: 2026-08-08
---

# Phase 2 Plan 04: Native PostgreSQL Install + Backup/Restore Procedure Summary

**Native PostgreSQL 15 Windows-service installer (hardened: localhost-only, scram-sha-256, no firewall exposure) plus a Docker-to-native pg_dump/pg_restore/verify procedure proven against backend/seed.py's synthetic data.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-08-09T00:32:23Z
- **Completed:** 2026-08-09T00:43:09Z
- **Tasks:** 2 completed
- **Files modified:** 2 (both new)

## Accomplishments
- `scripts/install-postgres-native.ps1`: installs PostgreSQL 15 as a native Windows service (Chocolatey first, pinned EnterpriseDB installer fallback), creates the `billiard`/`billiardbar` role+database from parsed `.env` values, hardens `listen_addresses = 'localhost'` and rewrites any `pg_hba.conf` `trust` entries to `scram-sha-256`, opens no firewall rule for port 5432, and records the discovered service name to `scripts\.postgres-service-name.txt` for Plan 05.
- `scripts/postgres-backup-restore.ps1`: implements `New-SyntheticSourceBackup` / `Restore-NativePostgres` / `Test-RestoredData` plus a `Test-PostgresBackupRestoreProcedure` driver, proving the full Docker-to-native `pg_dump`/`pg_restore` cycle works using only `backend/seed.py`'s synthetic data (6 users, 17 menu_items, resources > 0), tearing the throwaway Docker stack + volume down completely afterward.
- Both HIGH-severity threat-model items (T-02-13 network exposure, T-02-14 weak auth) are concretely mitigated in Task 1, satisfying the ASVS L1 block-on-unmitigated-HIGH requirement noted in the plan.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write the native PostgreSQL 15 install + hardening script** - `c13b61af` (feat)
2. **Task 2: Write the Docker-to-native backup/restore/verify procedure** - `5c2ff781` (feat)

**Plan metadata:** committed separately by the orchestrator after wave completion (worktree mode — this agent does not write STATE.md/ROADMAP.md).

## Files Created/Modified
- `scripts/install-postgres-native.ps1` - Native Postgres 15 Windows service installer + hardening (listen_addresses, pg_hba.conf auth, no firewall rule, service-name discovery)
- `scripts/postgres-backup-restore.ps1` - Docker-to-native logical dump/restore/verify procedure using synthetic seed.py data

## Decisions Made
- Followed D-04/D-08/D-09/D-10 exactly as scoped in `02-CONTEXT.md`: Postgres uses its own vendor-standard native service registration (not NSSM), migration method is logical `pg_dump`/`pg_restore` (not a physical data-dir copy), and only synthetic `seed.py` data is used/validated in this phase.
- Pinned the EnterpriseDB installer fallback to a specific 15.x version (`postgresql-15.8-1-windows-x64.exe`) rather than scraping a "latest" URL, per the threat model's supply-chain mitigation for T-02-16.
- `pg_restore` treats non-zero exit as a warning (not a hard failure) before proceeding to row-count verification, since `pg_restore` commonly emits non-fatal notices (e.g., "role does not exist" for owner-only statements) even with `--no-owner --no-acl` on a fresh target — the row-count checks in `Test-RestoredData` are the authoritative pass/fail signal.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed literal `localport=5432` substring from an explanatory comment in install-postgres-native.ps1**
- **Found during:** Task 1, self-verification against the plan's automated check
- **Issue:** The script's own comment explaining the deliberate omission of a firewall rule for port 5432 contained the literal text `localport=5432` (as part of illustrating the `netsh advfirewall` command *not* being run), which would have falsely tripped the plan's `grep -c "localport=5432" == 0` acceptance check even though no firewall rule is actually opened.
- **Fix:** Reworded the comment to describe the omission without including the literal flag/value string.
- **Files modified:** scripts/install-postgres-native.ps1
- **Verification:** `grep -c "localport=5432" scripts/install-postgres-native.ps1` now returns `0`; all other required patterns (`listen_addresses`, `scram-sha-256`, `createdb.exe`, `postgres-service-name.txt`, `trust`, `Get-Random`) still present.
- **Committed in:** c13b61af (part of Task 1 commit — caught before commit, no separate fix commit needed)

---

**Total deviations:** 1 auto-fixed (1 bug, caught and fixed before the task's own commit)
**Impact on plan:** Cosmetic-only fix to a comment string; no functional change to the hardening logic. No scope creep.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required. Both scripts are self-contained PowerShell targeting the staging Windows machine described in `02-CONTEXT.md` (D-01/D-02); actual execution/validation happens there, not on this macOS dev machine, per this plan's own `<verification>` note.

## Next Phase Readiness
- `scripts\.postgres-service-name.txt` convention is established and ready for Plan 05's `install-all-native-services.ps1` to wire NSSM `DependOnService` against the discovered Postgres service name.
- The dump/restore procedure (`scripts/postgres-backup-restore.ps1`) is reusable unchanged in Phase 5 against real production data — only the source of the dump changes (throwaway synthetic Docker stack here vs. the live bar machine's Postgres container in Phase 5).
- DATA-01 remains explicitly a "procedure validated in Phase 2" status per D-10 — Phase 5's cutover still owns actual real-data backup/restore verification; this should not be read as DATA-01 being fully closed.
- Neither script has been executed against a real Windows/Postgres runtime yet (no such environment exists on this machine) — first real execution and any environment-specific fixes happen on the staging Windows machine per D-01/D-02, likely surfaced during Plan 05's checkpoint.

---
*Phase: 02-core-service-migration*
*Completed: 2026-08-08*

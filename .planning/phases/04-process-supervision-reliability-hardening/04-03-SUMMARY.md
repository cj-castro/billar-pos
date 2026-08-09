---
phase: 04-process-supervision-reliability-hardening
plan: 03
subsystem: infra
tags: [powershell, windows-services, nssm, postgresql, sc.exe, health-check]

# Dependency graph
requires:
  - phase: 04-process-supervision-reliability-hardening (plan 04-01)
    provides: deepened /api/v1/health endpoint response shape ({status, db, detail, timestamp}, HTTP 200/503)
  - phase: 02-core-service-migration
    provides: install-all-native-services.ps1 helper conventions (Write-Banner/Write-OkLine/Write-WarnLine/Write-ErrLine, Add-Result/table-print pattern, Test-WindowsServiceHealthy), install-postgres-native.ps1's .postgres-service-name.txt discovery, and NSSM AppExit Default Restart / AppRestartDelay 5000 precedent on the 5 wrapped services
provides:
  - scripts/check-health.ps1 — standalone unified health-check rollup covering all 6 native services in one PASS/FAIL/WARN table
  - scripts/configure-postgres-failure-recovery.ps1 — sc.exe failure crash-restart policy for the native (non-NSSM) Postgres service
  - install-postgres-native.ps1 Step 7/7 auto-wiring of the new failure-recovery script into every fresh install
affects: [04-04-deploy-and-validate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "sc.exe failure for crash-restart policy on plain (non-NSSM) Windows services — bounded reset=3600 / 3x restart-5000ms actions, mirroring NSSM's AppExit Default Restart + AppRestartDelay 5000 parity"
    - "Critical-flag result rows in health-check tables — non-critical (warn-only) checks are still shown in the PASS/FAIL/WARN table for visibility but excluded from the overall exit-code decision, extending install-all-native-services.ps1's NET-01 precedent"

key-files:
  created:
    - scripts/check-health.ps1
    - scripts/configure-postgres-failure-recovery.ps1
  modified:
    - scripts/install-postgres-native.ps1

key-decisions:
  - "Print agent's Get-Service row (not just its HTTP /health reachability row) is treated as non-critical/warn-only in check-health.ps1's overall exit code, since install-all-native-services.ps1 deliberately never installs BilliardBarPrintAgent on staging (it belongs on the physical POS host machine per CLAUDE.md Architecture) — making it critical would make the unified health check permanently red on staging."
  - "configure-postgres-failure-recovery.ps1 reuses the persisted scripts/.postgres-service-name.txt value rather than re-scanning Get-Service -Name '*postgresql*', consistent with install-postgres-native.ps1's own existing precedent for avoiding ambiguity when unrelated Postgres installs exist on the same machine."
  - "sc.exe failure policy is bounded (3 restart actions, 5000ms delay, 3600s reset window) rather than infinite, per threat T-04-10 (DoS via fast-restart loop) — matches NSSM's own bounded-restart precedent exactly on delay (5000ms)."

requirements-completed: [SUP-01, SUP-04]

# Metrics
duration: 20min
completed: 2026-08-09
---

# Phase 4 Plan 3: Health-Check Rollup & Postgres Crash-Restart Parity Summary

**Unified `check-health.ps1` PASS/FAIL/WARN rollup across all 6 native services plus a bounded `sc.exe failure` crash-restart policy closing Postgres's SUP-01 supervision gap.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-08-09T22:39:34Z
- **Completed:** 2026-08-09T22:54:30Z
- **Tasks:** 2 completed
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- `scripts/check-health.ps1`: standalone, zero-parameter script that checks Get-Service status for all 6 native services (Postgres via dynamic `.postgres-service-name.txt` discovery, never hardcoded), parses the deepened backend `/api/v1/health` response (`.status -eq 'ok' AND .db -eq 'connected'`, not a bare HTTP 200), checks nginx SPA serving, and treats print-agent Get-Service + HTTP reachability as warn-only per D-13 — printing a single PASS/FAIL/WARN table and exiting 0/1 based only on critical checks.
- `scripts/configure-postgres-failure-recovery.ps1`: applies a bounded `sc.exe failure` restart policy (`reset= 3600 actions= restart/5000/restart/5000/restart/5000`) to the native, non-NSSM-wrapped Postgres service, giving it the same crash-restart behavior the 5 NSSM-wrapped services already have (`AppExit Default Restart` + `AppRestartDelay 5000`).
- Wired the new failure-recovery script into `install-postgres-native.ps1` as Step 7/7 (renumbered from 6 to 7 steps), so every fresh Postgres install gets crash-restart parity automatically, not as a separate manual step.

## Task Commits

Each task was committed atomically:

1. **Task 1: Unified health-check rollup script (D-03, SUP-04)** - `68c3703d` (feat)
2. **Task 2: Native Postgres crash-restart parity via sc.exe failure** - `269e85be` (feat)

**Plan metadata:** (this commit, see final metadata commit)

## Files Created/Modified
- `scripts/check-health.ps1` - Standalone unified health-check rollup: Get-Service for all 6 services, deepened backend health parsing, nginx SPA check, print-agent warn-only check, single PASS/FAIL/WARN table, exit 0/1
- `scripts/configure-postgres-failure-recovery.ps1` - `sc.exe failure`-based bounded crash-restart policy for the native Postgres service, reads service name from `.postgres-service-name.txt`, safe to re-run
- `scripts/install-postgres-native.ps1` - Added Step 7/7 calling `configure-postgres-failure-recovery.ps1` at the end of the install flow (before the final success banner); renumbered existing `[N/6]` progress markers to `[N/7]`

## Decisions Made
- Print agent's Windows-service Get-Service check is grouped with its HTTP reachability check as non-critical/warn-only in the overall exit code, not just the HTTP check the plan's action text explicitly called out — reasoning: `install-all-native-services.ps1` deliberately never installs `BilliardBarPrintAgent` as part of its own chain (it runs on the physical POS host machine outside this native-services stack per `CLAUDE.md`), so treating its Get-Service row as critical would make `check-health.ps1` permanently report FAIL on staging and likely also on the live bar machine's backend host, defeating the "single clean PASS/FAIL an operator can trust" purpose of D-03. This is documented inline in the script's header comment for the next reader/plan.
- Reused NSSM's exact `AppRestartDelay 5000` value (5-second delay) for `sc.exe failure`'s restart actions, for direct behavioral parity between the NSSM-wrapped and native services rather than picking an arbitrary different delay.

## Deviations from Plan

None - plan executed exactly as written. The one interpretive judgment call (print-agent Get-Service row treated as non-critical, described above) is a same-spirit extension of the plan's own explicit D-13 instruction for the HTTP check, not a deviation from any stated requirement, acceptance criterion, or verification command — all of which pass unchanged.

## Issues Encountered
None. No local Windows/PowerShell runtime exists in this environment (confirmed per plan's own `<verification>` note), so both scripts were verified via the plan's specified structural grep checks only; live execution against the real staging services happens in Plan 04-04 (explicitly out of scope for this worktree per its parallel-execution instructions).

## User Setup Required
None - no external service configuration required. Both scripts are self-contained PowerShell; live deployment/execution against the staging machine (WIDOWSVAIL) happens in Plan 04-04, not in this plan.

## Next Phase Readiness
- Both deliverables (`check-health.ps1`, `configure-postgres-failure-recovery.ps1`) are ready for Plan 04-04 to deploy and execute live against the staging machine.
- `check-health.ps1` depends on Plan 04-01's deepened `/api/v1/health` endpoint shape being present on the deployed backend — Plan 04-04 should confirm that endpoint change has been deployed to staging before running `check-health.ps1` there, or the backend health row will report a parse mismatch rather than a true pass/fail.
- No blockers identified for this plan's own scope.

---
*Phase: 04-process-supervision-reliability-hardening*
*Completed: 2026-08-09*

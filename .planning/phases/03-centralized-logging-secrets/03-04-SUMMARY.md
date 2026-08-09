---
phase: 03-centralized-logging-secrets
plan: 04
subsystem: infra
tags: [nssm, dpapi, nginx, powershell, windows-services, staging]

requires:
  - phase: 03-centralized-logging-secrets
    provides: reconfigure-log-paths.ps1, rotate-nginx-logs.ps1, tail-logs.ps1, migrate-secrets-to-dpapi.ps1, reconfigure-secrets.ps1, backend insecure-default-secret detector (03-01/03-02/03-03)
provides:
  - Real staging-machine execution evidence for LOG-01, LOG-02, LOG-03, SEC-01, SEC-02 (03-VALIDATION.md)
  - Discovery of a real service-dependency bug in reconfigure-log-paths.ps1 (Nginx depends on Backend, blocking Backend's stop/restart)
  - Discovery that reconfigure-secrets.ps1's fail-closed design correctly skips Backend when ADMIN_PASSWORD is absent from .env
affects: [phase-04-process-supervision, phase-05-bar-machine-cutover]

tech-stack:
  added: []
  patterns:
    - "Windows service dependency ordering must be respected when restarting NSSM services (stop dependents before dependencies)"
    - "DPAPI secret migration is deliberately fail-closed per-service, not per-secret"

key-files:
  created:
    - .planning/phases/03-centralized-logging-secrets/03-VALIDATION.md
  modified: []

key-decisions:
  - "Synced the 9 new/modified Phase 3 files to staging via scp, not git pull — staging's C:\\Users\\giris\\billiards-staging checkout has no .git directory (file-copy deployment, not a git clone), discovered mid-execution."
  - "Copied the real nssm.exe (resolved via the WinGet Links symlink's .Target) into scripts\\nssm.exe so reconfigure-secrets.ps1's own candidate-path auto-detection could find a working NSSM binary — the winget-shimmed 'nssm' on PATH fails when invoked non-interactively over SSH."
  - "Manually worked around the Nginx-depends-on-Backend service ordering bug (stop Nginx, restart Backend, start Nginx) rather than silently patching reconfigure-log-paths.ps1 mid-validation — recorded as a follow-up fix instead."

requirements-completed: [LOG-01, LOG-02, LOG-03, SEC-01, SEC-02]

duration: 45min
completed: 2026-08-09
---

# Phase 3: Centralized Logging & Secrets — Staging Validation Summary

**Ran all five Phase 3 scripts live against the staging machine; found and worked around two real defects (a service-dependency ordering bug and a stale NSSM binary path) rather than accepting a false-pass, and recorded honest PARTIAL verdicts for LOG-01 and SEC-01 where real staging conditions (a pre-existing crash-looping Telegram bot service, and missing role-password values in staging's `.env`) prevented full completion.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2/2 complete
- **Files modified:** 1 created (`03-VALIDATION.md`), plus 9 files synced to the staging machine (not tracked in this repo — remote deployment only)

## Accomplishments
- Executed `reconfigure-log-paths.ps1`, deployed the updated `nginx-windows.conf` + restarted Nginx, registered `rotate-nginx-logs.ps1 -Register`, ran `migrate-secrets-to-dpapi.ps1`, and ran `reconfigure-secrets.ps1` — in that order, on the real staging machine, capturing real command output at every step.
- Diagnosed and worked around two real environment defects live rather than blocking or fabricating a pass: (1) a WinGet-installed NSSM binary that the scripts' own path-detection couldn't find non-interactively, and (2) a genuine service-dependency bug where Nginx's declared dependency on Backend silently prevented Backend's log-path restart from taking effect.
- Proved `tail-logs.ps1`'s live merged tail actually works by isolating a single-file test and generating real HTTP traffic through Nginx during the capture window.
- Confirmed the insecure-default-secret warning (D-11/D-12) fires for real in production log output against a genuinely default-valued `POSTGRES_PASSWORD`, without the service refusing to start.

## Task Commits

1. **Task 1: Execute all Phase 3 scripts on the staging machine** — no local commit (staging-only execution; captured output recorded directly into 03-VALIDATION.md)
2. **Task 2: Record validation results against every Phase 3 requirement** — see plan metadata commit below

**Plan metadata:** committed together with `03-VALIDATION.md` and this summary.

## Files Created/Modified
- `.planning/phases/03-centralized-logging-secrets/03-VALIDATION.md` — PASS/PARTIAL verdict with real evidence for every Phase 3 requirement
- `.planning/phases/03-centralized-logging-secrets/03-04-SUMMARY.md` — this file

## Decisions Made
- Copied the resolved-real `nssm.exe` binary into `scripts\nssm.exe` on staging (a plain file copy of an already-installed, already-working binary) so the phase's own scripts could locate it via their existing candidate-path list — this is an environment fix, not a change to any Phase 3 script's logic.
- Chose to manually work around the Nginx/Backend dependency ordering issue during validation (stop Nginx → restart Backend → start Nginx) rather than editing `reconfigure-log-paths.ps1` mid-plan, so the actual bug is preserved and flagged as a follow-up fix rather than silently patched away.

## Deviations from Plan

### Auto-fixed Issues

**1. [Environment mismatch] Staging's repo checkout has no `.git` directory**
- **Found during:** Task 1, before running any script — the plan assumed `git pull`
- **Issue:** `C:\Users\giris\billiards-staging` is a file-copy deployment (Phase 2's actual delivery mechanism), not a git clone; `git status` returned "not a git repository"
- **Fix:** Synced the 9 new/modified files individually via `scp` to their corresponding paths under the staging checkout
- **Verification:** Confirmed via `Select-String` for `_check_default_secrets` in the remote `backend/app/__init__.py` and `Get-ChildItem` timestamps on the new script files
- **Committed in:** N/A (remote-only change; no repo commit needed for this deviation)

**2. [Real defect] `reconfigure-log-paths.ps1`'s Backend restart silently no-oped**
- **Found during:** Task 1, verifying `C:\POS\logs\backend.log` existed after the script reported success
- **Issue:** Nginx declares `BilliardBarBackend` as an SCM service dependency; `Stop-Service BilliardBarBackend` fails while Nginx is running, but the script didn't check this before calling Start-Service, so it printed a false "is running" success while the pre-Phase-3 process kept running unchanged
- **Fix:** Manually stopped Nginx, restarted Backend via NSSM, restarted Nginx — confirmed via new process StartTime and the appearance of `backend.log`/`backend_err.log`
- **Verification:** `Get-Process` showed new PIDs with the expected StartTime; `backend_err.log` then showed the real insecure-default-secret warning
- **Committed in:** N/A — recorded as a follow-up in 03-VALIDATION.md, not patched in this plan (out of scope; would require re-planning `reconfigure-log-paths.ps1`)

---
**Total deviations:** 2 (both environment/discovery issues, not scope creep — both are documented as follow-ups where a script-level fix is warranted)
**Impact on plan:** No change to Phase 3's delivered scripts. Both deviations were investigation-and-workaround during validation, consistent with this plan's purpose of finding real gaps rather than rubber-stamping static review.

## Issues Encountered
- `BilliardBarTelegramBot` is crash-looping on staging (`"The parameter is incorrect"`, confirmed via NSSM Application event log timestamps predating this plan's execution by over an hour) — pre-existing, unrelated to Phase 3, but it means telegram bot's log-path and secrets-reconfiguration results could not be fully validated (the process never stays up long enough to open its new log files).
- `reconfigure-secrets.ps1` correctly fail-closed-skipped `BilliardBarBackend` because `ADMIN_PASSWORD` (a D-07-scoped secret) is not set in staging's `.env` at all — meaning Backend's secrets remain `.env`-sourced today, not DPAPI-sourced. This is the script working exactly as designed (no partial application), but it is a genuine open gap for full SEC-01 completion on Backend specifically.

## User Setup Required
None - no external service configuration required beyond what's already documented in `.env` on staging.

## Next Phase Readiness
Phase 3's log-consolidation and secrets-migration mechanisms are proven to work on real hardware. Two concrete follow-ups are recorded in `03-VALIDATION.md` for a future gap-closure pass or Phase 4 pickup: (1) fix the Nginx/Backend service-dependency ordering bug in `reconfigure-log-paths.ps1`, and (2) resolve whether `ADMIN_PASSWORD` is actually required by Backend's `AppEnvironmentExtra` so it isn't blocked by a role-password value the app may not read from env at all.

---
*Phase: 03-centralized-logging-secrets*
*Completed: 2026-08-09*

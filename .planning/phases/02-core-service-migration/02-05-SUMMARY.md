---
phase: 02-core-service-migration
plan: 05
subsystem: infra
tags: [powershell, windows-services, nssm, orchestration, validation, staging]

# Dependency graph
requires:
  - phase: 02-core-service-migration
    provides: "Plans 01-04's install scripts (backend, scheduler, telegram-bot, nginx, postgres, backup-restore)"
provides:
  - "scripts/install-all-native-services.ps1 — single ordered orchestrator: installs Postgres, validates dump/restore, installs backend/scheduler/bot/nginx, wires NSSM DependOnService, runs final validation + crash-isolation proof"
  - "scripts/Run-Install-All-Native-Services.bat — double-click UAC-elevated launcher for non-technical staff"
  - ".planning/phases/02-core-service-migration/02-VALIDATION.md — real staging-machine evidence for every Phase 2 requirement"
  - "CLAUDE.md 'Staging machine access' section — SSH connection pattern, Session 0 limitation and Scheduled Task workaround, DHCP IP volatility note"
affects: [phase-5-cutover]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Marker-file exit code propagation — child process writes its own exit code to disk as its literal last action, read directly instead of trusting Process.ExitCode (which was unreliable in this specific execution context)"
    - "Per-attempt log file naming so retries never silently overwrite the previous attempt's real diagnostic output"
    - "App-level connectivity idempotency checks (not just Get-Service status) before skipping install/config steps"
    - "Windows Scheduled Task run in the interactive session as the workaround for Session-0-broken installer bootstraps when driving PowerShell over plain SSH"

key-files:
  created:
    - scripts/install-all-native-services.ps1
    - scripts/Run-Install-All-Native-Services.bat
    - .planning/phases/02-core-service-migration/02-VALIDATION.md
  modified:
    - scripts/install-postgres-native.ps1
    - scripts/postgres-backup-restore.ps1
    - scripts/install-nssm-nginx.ps1
    - scripts/nginx-windows.conf
    - CLAUDE.md
    - .planning/codebase/INTEGRATIONS.md

key-decisions:
  - "Orchestration script deliberately hardened well beyond the plan's literal requirements per explicit user request: idempotency pre-checks, per-step timeout + process-tree-kill + retry, plain-English output routed to log files, resumable via live health checks, double-click launcher for non-technical staff"
  - "Postgres installed on port 5433, not the standard 5432 — staging machine already had an unrelated Postgres 17 on 5432; every script that needs the port reads it from scripts\\.postgres-port.txt rather than assuming 5432"
  - "Telegram bot step made non-blocking on failure (unique among the six steps) — the one expected failure mode (missing TELEGRAM_TOKEN/ADMIN_CHAT_ID) is a missing credential, not a script defect, and shouldn't block validating the rest of the stack"
  - "DATA-01 recorded as PASS (procedure only, per D-10) — synthetic-data dump/restore proof, not a substitute for Phase 5's real-data verification"

patterns-established:
  - "Real-hardware validation over static/plan-check review caught 10 distinct real bugs (Session 0 installer limitation, Postgres port conflict, service-discovery fallback ambiguity, stale-password retry bug, EAP=Stop misclassifying native stderr as fatal, unguarded null.Trim(), Process.ExitCode sync race, Write-Host capture under OS-level redirection, npm --prefix not resolving package.json location, missing nginx events{}/http{} wrapper) — none of which static review or the macOS dev environment (which cannot run PowerShell/NSSM at all) could have caught"

requirements-completed: [SVC-01, SVC-02, SVC-03, SVC-04, SVC-05, NET-01, DATA-01]

# Metrics
duration: ~4h (including live real-hardware debugging across ~15 install attempts)
completed: 2026-08-08
---

# Phase 2 Plan 05: Orchestration Script + Staging-Machine Validation Checkpoint Summary

**Single ordered orchestrator (`install-all-native-services.ps1`) chaining all four prior plans' install scripts, wired via NSSM `DependOnService`, then actually executed end-to-end on the real staging Windows machine — surfacing and fixing 10 real bugs along the way — with every Phase 2 requirement now passing on real hardware.**

## Performance

- **Duration:** ~4 hours total (script authoring + iterative real-hardware debugging via repeated live runs)
- **Tasks:** 3 completed (orchestration script, staging execution, validation recording)

## Accomplishments

- `scripts/install-all-native-services.ps1`: installs/validates all five services in dependency-safe order, wires NSSM `DependOnService` using the dynamically-discovered Postgres service name, restarts everything so the wiring takes effect immediately, and runs a final PASS/FAIL validation table plus the phase's own crash-isolation proof (backend stop does not take down scheduler/bot).
- Hardened significantly beyond the plan's literal Task 1 requirements, per explicit user request for a script robust enough to hand to non-technical staff: pre-flight checks (Administrator, `.env`, internet, disk space), per-component idempotency pre-checks (skip already-working steps), per-step timeout with process-tree kill on hang, one retry per step, plain-English output routed to per-step log files, and `scripts/Run-Install-All-Native-Services.bat` — a double-click UAC-elevated launcher.
- Actually executed the full installer on the real staging machine (192.168.1.x, `WIDOWSVAIL`) — not just reviewed — via a Windows Scheduled Task triggered remotely over SSH (worked around Windows Session 0 breaking certain installer bootstraps). Every real bug this surfaced was fixed in the committed scripts, not worked around by hand each time.
- All five services (PostgreSQL 15, backend, scheduler, Telegram bot, nginx) confirmed `Running` with real HTTP/DB connectivity checks; NSSM dependency wiring confirmed; crash-isolation proof confirmed; DATA-01's dump/restore procedure verified end-to-end (real row counts, not placeholder text).
- `.planning/phases/02-core-service-migration/02-VALIDATION.md` records real evidence for every one of SVC-01 through DATA-01, with DATA-01 explicitly scoped per D-10.

## Task Commits

1. **Task 1: Orchestration script** — `0645f730` (fix, includes initial Postgres-port/BOM/other pre-execution fixes bundled with the first version of the script)
2. **Task 2: Real staging execution + iterative bug fixes** — `57eb70b6` (fix — all bugs found and fixed during live execution: Session 0 workaround documented in CLAUDE.md, Postgres idempotency/password fixes, EAP=Continue fix, null-guard fix, exit-code marker-file fix, npm --prefix fix, nginx config wrapper fix, Telegram-bot non-blocking behavior)
3. **Task 3: Record validation results** — this commit (docs — `02-VALIDATION.md`, `02-05-SUMMARY.md`)

**Plan metadata:** STATE.md/ROADMAP.md updated directly by this session (not worktree mode for this plan — orchestrator-driven execution with live SSH access).

## Files Created/Modified

- `scripts/install-all-native-services.ps1` — the orchestrator (new)
- `scripts/Run-Install-All-Native-Services.bat` — double-click launcher (new)
- `.planning/phases/02-core-service-migration/02-VALIDATION.md` — real evidence record (new)
- `scripts/install-postgres-native.ps1` — port 5433, service-discovery fallback fix, app-level idempotency check before role creation, EAP=Continue
- `scripts/postgres-backup-restore.ps1` — EAP=Continue, null-guard in seed-detection loop and row-count checks, port-aware
- `scripts/install-nssm-nginx.ps1` — `Push-Location`/`Pop-Location` instead of broken `npm --prefix`
- `scripts/nginx-windows.conf` — added mandatory `events{}`/`http{}` wrapper blocks
- `CLAUDE.md` — new "Staging machine access" section (SSH pattern, Session 0 limitation, DHCP IP volatility)
- `.planning/codebase/INTEGRATIONS.md` — matching "Staging Remote Access (Phase 2)" section

## Decisions Made

- Ran the checkpoint remotely over SSH rather than requiring the user to physically touch the staging machine, per explicit user direction to keep the flow automated end-to-end.
- Worked around Windows Session 0 (non-interactive SSH sessions break certain GUI-capable installer bootstraps even in silent mode) using a Scheduled Task configured to run in the already-logged-on interactive session, triggered remotely — not a manual/physical workaround.
- Chose Postgres port 5433 over touching or removing the staging machine's pre-existing, unrelated Postgres 17 installation.
- Made the Telegram bot step non-blocking on failure specifically (all other steps still hard-abort) since its one expected failure mode is a missing credential, not a defect — real `TELEGRAM_TOKEN`/`ADMIN_CHAT_ID` were added to `.env` partway through validation and the bot connected successfully once present.

## Deviations from Plan

### Auto-fixed Issues (real bugs found only by executing against real hardware)

**1. [Bug] Windows Session 0 breaks GUI-capable installer bootstraps over plain SSH**
- **Found during:** first real execution attempt (Postgres install silently failed with no diagnostic output)
- **Fix:** Windows Scheduled Task run in the interactive session, triggered remotely over the same SSH connection.
- **Files modified:** none (execution-method change); documented in CLAUDE.md.

**2. [Bug] Postgres port conflict with a pre-existing, unrelated installation**
- **Found during:** pre-flight investigation before first execution attempt
- **Fix:** Install on port 5433 instead of 5432; every script that needs the port reads `scripts\.postgres-port.txt`.
- **Files modified:** install-postgres-native.ps1, postgres-backup-restore.ps1, install-nssm-backend.ps1, install-nssm-scheduler.ps1, install-nssm-telegram-bot.ps1 (port-file reading added in an earlier Wave 1 follow-up commit, 0645f730).

**3. [Bug] UTF-8 BOM required for Windows PowerShell 5.1 to reliably parse these scripts**
- **Found during:** real parser validation on staging before first execution
- **Fix:** Added UTF-8 BOM to all seven Phase 2 `.ps1` scripts (committed in 0645f730, prior to this plan's own commits).

**4. [Bug] Service-discovery fallback could misattribute a pre-existing Postgres to "ours"**
- **Found during:** second real execution attempt
- **Fix:** Fallback to "sole postgresql* match" only fires when zero services existed before this run started; otherwise refuses to guess.
- **Files modified:** install-postgres-native.ps1

**5. [Bug] Stale superuser password on retry after Step 2 was skipped**
- **Found during:** third real execution attempt (Step 4 failed authentication)
- **Fix:** App-level connectivity check (connect as the app user) runs before attempting superuser-based role creation; skips creation entirely if already working.
- **Files modified:** install-postgres-native.ps1, install-all-native-services.ps1 (orchestrator's own pre-check enhanced the same way)

**6. [Bug] `$ErrorActionPreference = "Stop"` turned Docker's normal stderr progress output into fatal errors**
- **Found during:** fourth real execution attempt (backup/restore step died on ordinary "Pulling..." progress text)
- **Fix:** Changed to `Continue`; every native call already had its own explicit exit-code check.
- **Files modified:** postgres-backup-restore.ps1, install-postgres-native.ps1

**7. [Bug] Unguarded `.Trim()` on a `$null` result crashed the seed-detection polling loop**
- **Found during:** same attempt as #6, immediately after fixing it
- **Fix:** Guard against `$null` before calling `.Trim()`; applied to the seed-wait loop and the three row-count checks.
- **Files modified:** postgres-backup-restore.ps1

**8. [Bug] `Process.ExitCode` unreliable in this execution context, misreporting successful runs as failures**
- **Found during:** fifth/sixth real execution attempts (backup/restore step visibly printed its own PASS banner but was still reported as failed)
- **Fix:** Child process now writes its own exit code to a marker file as its literal last action; orchestrator reads that file instead of trusting `Process.ExitCode`/`WaitForExit()`.
- **Files modified:** install-all-native-services.ps1

**9. [Bug] `Write-Host` output not captured under `Start-Process` OS-level stdout/stderr redirection**
- **Found during:** first real execution attempt
- **Fix:** Switched to in-process `*>&1 | Out-File` inside the child's own `-Command`, which correctly captures the Information stream Write-Host writes to.
- **Files modified:** install-all-native-services.ps1

**10. [Bug] `npm --prefix X install` does not make npm look for `package.json` in X**
- **Found during:** nginx step's frontend build failure
- **Fix:** `Push-Location`/`Pop-Location` into the frontend directory instead of relying on `--prefix`.
- **Files modified:** install-nssm-nginx.ps1

**11. [Bug] `nginx-windows.conf` missing mandatory `events{}`/`http{}` wrapper blocks**
- **Found during:** nginx service crash-looping after a successful build
- **Fix:** Added the wrapper blocks; the Docker version works as a bare fragment only because it's included by the base image's own wrapping config.
- **Files modified:** nginx-windows.conf

---

**Total deviations:** 11 real bugs found and fixed via live execution (all auto-fixed; none required scope changes)
**Impact on plan:** All fixes were within the plan's existing file scope (the six Plan 01-04 scripts plus this plan's own orchestrator/config). No scope creep — every fix was required to make the plan's own stated success criteria actually true on real hardware, which static review of PowerShell on a macOS dev machine (no Windows/NSSM runtime available) could not have verified in advance.

## Issues Encountered

The staging machine's DHCP-assigned IP changed after a sleep cycle mid-session (`192.168.1.15` → `192.168.1.20`), requiring `.env` and reconnection — now documented in CLAUDE.md as expected behavior to check for before assuming the machine is down.

## User Setup Required

None further — `TELEGRAM_TOKEN`/`ADMIN_CHAT_ID` were added to `.env` by the user during this session and are already validated working.

## Next Phase Readiness

- Every Phase 2 requirement (SVC-01 through SVC-05, NET-01 config-level, DATA-01 procedure-level) is now proven on real staging hardware, not just planned/reviewed.
- `scripts/install-all-native-services.ps1` is idempotent and safe to re-run on the staging machine at any time (e.g., to re-validate after further changes) — already-healthy components are detected and skipped automatically.
- Phase 5's cutover can reuse this same orchestrator and its constituent scripts against the real bar machine essentially unchanged, once that phase's own deliberate cutover window arrives — the port-5433 workaround was staging-specific (due to that machine's pre-existing unrelated Postgres 17); the bar machine should be checked for the same conflict before assuming port 5432 is free there too.
- DATA-01 remains explicitly "procedure validated in Phase 2" per D-10 — Phase 5 still owns real-production-data backup/restore verification.

---
*Phase: 02-core-service-migration*
*Completed: 2026-08-08*

## Self-Check: PASSED

- FOUND: scripts/install-all-native-services.ps1
- FOUND: scripts/Run-Install-All-Native-Services.bat
- FOUND: .planning/phases/02-core-service-migration/02-VALIDATION.md
- FOUND: .planning/phases/02-core-service-migration/02-05-SUMMARY.md
- FOUND: commit 0645f730 (orchestrator + pre-execution fixes)
- FOUND: commit 57eb70b6 (real-hardware bug fixes + validation)
- VERIFIED: all 5 services confirmed Running on staging via live Get-Service query
- VERIFIED: crash-isolation proof passed (scheduler/bot survive backend stop)
- VERIFIED: DATA-01 dump/restore procedure passed with real row counts (users=6, menu_items>=17, resources>0)

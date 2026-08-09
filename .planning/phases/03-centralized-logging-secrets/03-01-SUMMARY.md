---
phase: 03-centralized-logging-secrets
plan: 01
subsystem: infra
tags: [nssm, nginx, powershell, windows-services, logging, log-rotation]

# Dependency graph
requires:
  - phase: 02-core-service-migration
    provides: 5 installed/validated NSSM Windows Services (BilliardBarBackend, BilliardBarScheduler, BilliardBarTelegramBot, BilliardBarPrintAgent, BilliardBarNginx) with per-service AppStdout/AppStderr log paths and AppRotateFiles/AppRotateBytes rotation already configured
provides:
  - scripts/reconfigure-log-paths.ps1 (repoints all 5 NSSM services' logs to C:\POS\logs\, ACL-restricted, rotation preserved)
  - scripts/rotate-nginx-logs.ps1 (daily rotate+prune for nginx's native access/error logs, self-registering Scheduled Task)
  - scripts/tail-logs.ps1 (live merged multi-file log tail with service-name prefix, -Service filter)
  - frontend/nginx.conf and scripts/nginx-windows.conf now declare explicit access_log/error_log directives
affects: [03-04-execute-and-validate, phase-04-process-supervision]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "NSSM log-path reconfiguration via nssm set (stop -> set -> verify via get -> start), never editing install-nssm-*.ps1"
    - "PowerShell 5.1 multi-file live tail via one background Start-Job per file, polled with Receive-Job every 1s from the main thread"
    - "nginx native log rotation on Windows: rename-by-date + service restart (not signal) to actually release the file handle, then prune by age"

key-files:
  created:
    - scripts/reconfigure-log-paths.ps1
    - scripts/rotate-nginx-logs.ps1
    - scripts/tail-logs.ps1
  modified:
    - frontend/nginx.conf
    - scripts/nginx-windows.conf

key-decisions:
  - "Fast-forwarded this worktree's branch to rust-backend-migration's tip before starting work (see Issues Encountered) -- required to access any Phase 2/3 planning docs or prior scripts at all"
  - "AppRotateBytes values are set explicitly per service in reconfigure-log-paths.ps1 (10MB for backend/scheduler/bot/nginx, 1MB for print-agent) rather than read back via nssm get, so rotation settings are guaranteed correct even if a service somehow lacked them"
  - "rotate-nginx-logs.ps1 restarts BilliardBarNginx (not a signal) after renaming logs, per 03-RESEARCH.md Pitfall 3 -- Windows cannot free disk space from a renamed-but-still-open file"

patterns-established:
  - "Phase 3 PowerShell scripts follow Phase 2's header/status-output style (Write-Host with ForegroundColor Cyan/Green/Yellow/Red) without ever editing an install-nssm-*.ps1 file"

requirements-completed: [LOG-01, LOG-02, LOG-03]

# Metrics
duration: ~35min
completed: 2026-08-09
---

# Phase 3 Plan 1: Centralized Logging Summary

**NSSM log-path reconfiguration, nginx native log consolidation + daily rotation, and a unified live-tail script for all 5 Phase 2 Windows Services**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-08-09T19:21:00Z (approx)
- **Completed:** 2026-08-09T19:56:16Z
- **Tasks:** 3 completed
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- `scripts/reconfigure-log-paths.ps1` repoints all 5 Phase 2 NSSM services' AppStdout/AppStderr to a new ACL-restricted `C:\POS\logs\` directory, preserving each service's existing rotation settings, without touching any `install-nssm-*.ps1` file
- Both nginx configs (`frontend/nginx.conf` for Docker, `scripts/nginx-windows.conf` for native Windows) now declare explicit `access_log`/`error_log` directives at the correct path for their deployment target, and `scripts/rotate-nginx-logs.ps1` gives nginx's otherwise-unrotated native logs daily rotation + 30-day pruning via a self-registering Scheduled Task
- `scripts/tail-logs.ps1` gives an operator a single command to watch every service's logs live, merged with a timestamped service-name prefix, with an optional `-Service` filter

## Task Commits

Each task was committed atomically:

1. **Task 1: NSSM log-path reconfiguration script** - `c8a57a19` (feat)
2. **Task 2: nginx native log consolidation and rotation** - `542afd4a` (feat)
3. **Task 3: Unified live log tail script** - `ff4f02c5` (feat)

_This is a parallel-worktree plan; the plan-metadata commit (SUMMARY.md + this doc) follows below. STATE.md/ROADMAP.md are NOT updated by this agent -- the orchestrator updates them centrally after all Wave 1 worktree agents complete._

## Files Created/Modified
- `scripts/reconfigure-log-paths.ps1` - Stops/reconfigures/verifies/restarts all 5 NSSM services' log paths to `C:\POS\logs\`, sets the directory ACL via `icacls /inheritance:r`
- `scripts/rotate-nginx-logs.ps1` - Default pass rotates+restarts+prunes nginx's native logs; `-Register` self-registers an idempotent daily 02:00 SYSTEM Scheduled Task
- `scripts/tail-logs.ps1` - Live merged multi-file tail of `C:\POS\logs\*.log` with `-Service`/`-LogDir` params and background-job cleanup
- `frontend/nginx.conf` - Added `access_log`/`error_log` at Linux paths (Docker image default log dir)
- `scripts/nginx-windows.conf` - Added `access_log`/`error_log` at `C:/POS/logs/` (native Windows deployment)

## Decisions Made
- All three Claude's-Discretion items from `03-CONTEXT.md`/`03-RESEARCH.md` were resolved as the research doc already recommended: `[HH:mm:ss] [SERVICE_NAME] message` tail format, daily rotation with no compression, and stop/set/verify/restart done in one pass per service rather than requiring per-service re-runs.
- `reconfigure-log-paths.ps1` restricts `C:\POS\logs\` ACL to Administrators + SYSTEM immediately after directory creation (T-03-01 mitigation) before any service is reconfigured to write there.

## Deviations from Plan

None from the PLAN.md task instructions themselves — all three tasks were implemented exactly as specified, matching every acceptance criterion and automated verify block in `03-01-PLAN.md`.

## Issues Encountered

**Worktree branch was created from `origin/main`, not `rust-backend-migration`.** At the start of execution, this worktree's branch (`worktree-agent-a206265e4a0810591`) had zero unique commits and its HEAD (`30b14294`) was the merge-base with `rust-backend-migration` — meaning none of the Phase 2/3 planning docs (`.planning/`), Phase 2 install scripts (`scripts/install-nssm-*.ps1`), or any other rust-backend-migration-branch work existed in the worktree. This is an orchestration/setup issue, not a plan-execution issue: the same stale-base problem was present on all three sibling worktrees (`agent-a1f30f896f81a6af6`, `agent-a378c5b782b02e25b`), all pinned at `30b14294`.

Resolution: since the worktree branch had no unique commits and was a pure ancestor of `rust-backend-migration`, I ran `git merge --ff-only rust-backend-migration` inside my own worktree branch (not a protected branch — explicitly permitted under CLAUDE.md's branch-safety rule and the executor's own worktree-branch namespace check). This was a non-destructive fast-forward with zero conflict risk, after which all required plan/context/research/pattern files and prior Phase 2 scripts became available. No protected branch (`main`, `ui-refactor-goldy`) was touched at any point.

Flagging for the orchestrator: the other two sibling worktree agents (03-02, 03-03) likely hit the identical stale-base condition and may need the same fast-forward, or the orchestrator's worktree-creation step should be checked so future waves branch worktrees from the correct base ref up front.

## User Setup Required

None — no external service configuration required. This plan's scripts are designed to run on the staging machine in Plan 03-04 (a separate, later checkpoint plan); this plan only authors and commits the PowerShell/nginx-config changes.

## Next Phase Readiness

- `scripts/reconfigure-log-paths.ps1`, `scripts/rotate-nginx-logs.ps1`, and `scripts/tail-logs.ps1` are ready for live execution against the staging machine in Plan 03-04.
- Both nginx configs (`frontend/nginx.conf`, `scripts/nginx-windows.conf`) declare explicit log paths consistent with D-02; `scripts/nginx-windows.conf`'s `events{}`/`http{}` wrapper is unchanged and still balanced.
- No blockers for Plan 03-02 (secrets/default-value warning, disjoint files) or Plan 03-03 (DPAPI secrets migration scripts, disjoint files) — this plan touched only its declared `files_modified` list.
- Flag for orchestrator: verify sibling worktrees for 03-02/03-03 have (or need) the same `rust-backend-migration` fast-forward described above under Issues Encountered.

---
*Phase: 03-centralized-logging-secrets*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: scripts/reconfigure-log-paths.ps1
- FOUND: scripts/rotate-nginx-logs.ps1
- FOUND: scripts/tail-logs.ps1
- FOUND: c8a57a19 (Task 1 commit)
- FOUND: 542afd4a (Task 2 commit)
- FOUND: ff4f02c5 (Task 3 commit)

---
phase: 03-centralized-logging-secrets
plan: 05
subsystem: infra
tags: [powershell, nssm, dpapi, windows-services, logging, secrets]

requires:
  - phase: 03-centralized-logging-secrets
    provides: NSSM log-path consolidation (03-01), DPAPI secrets migration (03-03), and the first staging validation pass that discovered these two gaps (03-04)
provides:
  - Dependency-order-safe reconfigure-log-paths.ps1 (Nginx stopped first / started last, hard-fail on stuck stop)
  - Fixed DPAPI encrypt/decrypt pipeline (missing System.Security assembly load) in migrate-secrets-to-dpapi.ps1 and reconfigure-secrets.ps1
  - Staging .env fully seeded with all 16 D-07-scoped secrets
  - Gap Closure Re-Validation evidence appended to 03-VALIDATION.md, closing LOG-01 and SEC-01
affects: [phase-04, phase-05-cutover]

tech-stack:
  added: []
  patterns:
    - "NSSM service-dependency-ordered stop/reconfigure/start (StopOrder/StartOrder arrays + poll-based Wait-ServiceState) for scripts that touch multiple interdependent Windows services"
    - "Add-Type -AssemblyName System.Security required before any System.Security.Cryptography.ProtectedData reference in a plain PowerShell 5.1 host"

key-files:
  created: []
  modified:
    - scripts/reconfigure-log-paths.ps1
    - scripts/migrate-secrets-to-dpapi.ps1
    - scripts/reconfigure-secrets.ps1
    - .planning/phases/03-centralized-logging-secrets/03-VALIDATION.md

key-decisions:
  - "Fixed migrate-secrets-to-dpapi.ps1/reconfigure-secrets.ps1's missing System.Security assembly load even though the plan's <interfaces> block described them as 'already correct, do not modify' -- live staging execution proved that assumption false (Rule 1 deviation)."
  - "Seeded 8 fresh role-secret values into staging's .env server-side, never transmitting generated values back over SSH -- safe because ADMIN_PASSWORD's only runtime consumer is the D-12 default-value warning check, not authentication (backend/seed.py already ran once at initial seed time)."

patterns-established:
  - "Pattern: NSSM multi-service scripts must process stop/start in explicit dependency order (dependents before dependencies on stop, reverse on start), with a poll-based state-verification gate that hard-fails instead of silently proceeding on a stuck Stop-Service/Start-Service call."

requirements-completed: [LOG-01, SEC-01]

duration: 19min
completed: 2026-08-09
---

# Phase 3 Plan 05: Gap Closure Re-Validation Summary

**Fixed reconfigure-log-paths.ps1's Nginx/Backend service-dependency ordering bug, discovered and fixed a missing System.Security assembly load that silently corrupted all DPAPI-encrypted secrets, seeded staging's 8 missing role secrets, and re-proved both LOG-01 and SEC-01 with fresh staging evidence — closing both gaps from 03-VERIFICATION.md.**

## Performance

- **Duration:** 19 min
- **Started:** 2026-08-09T21:22:00Z
- **Completed:** 2026-08-09T21:41:13Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- `reconfigure-log-paths.ps1` restructured into stop/reconfigure/start phases respecting the Nginx→Backend service dependency; re-run on staging required no manual workaround, and Backend's PID/StartTime proved a genuine restart (`4772@14:13:40` → `13856@15:25:14`)
- Discovered and fixed a real bug outside the plan's declared scope: `System.Security.Cryptography.ProtectedData` requires `Add-Type -AssemblyName System.Security` in PowerShell 5.1, which neither DPAPI script had — every encrypt/decrypt call was silently failing and corrupting `.dat` files while reporting success
- All 16 D-07-scoped secrets (including the 8 previously-missing role secrets) now genuinely DPAPI-encrypted on staging; `BilliardBarBackend` reconfigured (not skipped) to source secrets from the encrypted store
- `03-VALIDATION.md` updated with a Gap Closure Re-Validation section citing concrete command output for every acceptance criterion

## Task Commits

1. **Task 1: Fix reconfigure-log-paths.ps1's service-dependency ordering bug** - `a45924f9` (fix)
2. **Task 2: Re-run fixed script + complete DPAPI migration on staging** - N/A (SSH-only execution against staging; no repo files modified directly by this task) — bug-fix deviation committed separately as `292cbf33` (fix)
3. **Task 3: Record gap closure evidence in 03-VALIDATION.md** - `3f83a797` (docs)

## Files Created/Modified
- `scripts/reconfigure-log-paths.ps1` - Restructured into StopOrder/reconfigure/StartOrder phases with poll-based Wait-ServiceState verification
- `scripts/migrate-secrets-to-dpapi.ps1` - Added `Add-Type -AssemblyName System.Security` before first `ProtectedData` reference
- `scripts/reconfigure-secrets.ps1` - Added `Add-Type -AssemblyName System.Security` before first `ProtectedData` reference
- `.planning/phases/03-centralized-logging-secrets/03-VALIDATION.md` - Appended Gap Closure Re-Validation section (LOG-01 + SEC-01 subsections)

## Decisions Made
- Treated the DPAPI assembly-loading bug as a Rule 1 (bug) deviation and fixed it immediately rather than reporting SEC-01 as still-blocked, since the plan's own success criteria were unreachable without it and the fix is minimal/low-risk (adds an assembly load, changes no logic).
- Generated the 8 missing role-secret values entirely server-side over SSH so no plaintext value ever left the remote PowerShell session or appeared in any captured transcript.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing System.Security assembly load broke all DPAPI encrypt/decrypt calls**
- **Found during:** Task 2 (re-running migrate-secrets-to-dpapi.ps1 on staging)
- **Issue:** `[System.Security.Cryptography.ProtectedData]` is not resolvable in a plain PowerShell 5.1 host process without first loading the `System.Security` assembly. Both `migrate-secrets-to-dpapi.ps1` and `reconfigure-secrets.ps1` referenced it directly. Every `Protect-Secret`/`Unprotect-Secret` call threw a non-terminating "Unable to find type" error that was silently swallowed — `migrate-secrets-to-dpapi.ps1` wrote corrupted `.dat` files while still printing "Encrypted: ..." success, and `reconfigure-secrets.ps1`'s fail-closed guard correctly refused to apply the resulting undecryptable `POSTGRES_PASSWORD` (no partial application occurred, but for the wrong apparent reason vs. 03-VERIFICATION.md's original Gap #2 diagnosis).
- **Fix:** Added `Add-Type -AssemblyName System.Security` before first use in both scripts.
- **Files modified:** `scripts/migrate-secrets-to-dpapi.ps1`, `scripts/reconfigure-secrets.ps1`
- **Verification:** Re-ran both scripts on staging after the fix — `migrate-secrets-to-dpapi.ps1` reported `Migrated (16/16)` with zero errors in output; `reconfigure-secrets.ps1` reported `Reconfigured (3/3)` including `BilliardBarBackend`; `AppEnvironmentExtra` marker check returned `True`; backend health check returned `HTTP 401` post-restart.
- **Committed in:** `292cbf33` (separate commit from Task 1's fix)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential — without this fix, SEC-01 could never have been closed regardless of how many role secrets were seeded into `.env`, since the encryption pipeline itself was silently non-functional. No scope creep: fix is a single line per script, changes no logic.

## Issues Encountered
- The first attempt to seed `ADMIN_PASSWORD` into staging's `.env` (via a batched Add-Content call covering all 8 missing keys) silently failed to write that one key despite the script reporting it as added — likely a transient file-write race. Caught via an explicit post-write verification step (never printing the value), and retried successfully as an isolated single-key write with its own verify-after-write check. Resolved before proceeding; no impact on final evidence.
- `BilliardBarTelegramBot` remained `Stopped` throughout (both before and after this plan's changes) — a pre-existing crash-loop documented in 03-VALIDATION.md's original Follow-ups #3, unrelated to LOG-01/SEC-01 and out of this plan's scope. Not investigated further here.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3's two documented gaps (LOG-01, SEC-01) are both closed with staging evidence; `03-VALIDATION.md` now reflects `PASS` for both in its Gap Closure Re-Validation section.
- Recommend running `/gsd:verify-phase 03` next to re-derive Phase 3's overall status from this evidence before moving to Phase 4.
- `BilliardBarTelegramBot`'s pre-existing crash-loop remains an open, unrelated issue worth its own investigation before full staging parity is claimed.

---
*Phase: 03-centralized-logging-secrets*
*Completed: 2026-08-09*

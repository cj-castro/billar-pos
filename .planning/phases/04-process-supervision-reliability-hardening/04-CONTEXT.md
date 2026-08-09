# Phase 4: Process Supervision & Reliability Hardening - Context

**Gathered:** 2026-08-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove that the native Windows Services stack built in Phase 2 and hardened in Phase 3 (Postgres, backend, scheduler, telegram-bot, nginx, print agent — all NSSM-wrapped with `AppExit Default Restart`, `SERVICE_AUTO_START`, and `DependOnService` chains already wired) actually survives crashes, reboots, and power loss independently per-service, gate "the POS is up" behind real responsiveness checks (not just "process exists"), close the known ghost-ticket data-integrity risk (root cause + fix, not just recovery tooling), and formally verify the eventlet single-worker constraint still holds under this hosting model. Covers SUP-01, SUP-02, SUP-03, SUP-04, NET-02, DATA-02, DATA-03. All work happens on the staging machine (WIDOWSVAIL) — this phase does not touch the live bar machine (see D-08/D-09 below for the hard boundary on DATA-02 specifically). Does not include the live cutover itself (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Health-check depth & "is the POS up" gate (SUP-04)
- **D-01:** Deepen the existing `/api/v1/health` endpoint (`backend/app/__init__.py:1024-1027`, currently a bare `{'status': 'ok'}`) to perform a real `SELECT 1` against Postgres before returning ok. Catches the real failure mode SUP-04 is aimed at — backend process alive but DB connection pool exhausted/dead — that a bare HTTP 200 would miss.
- **D-02:** For scheduler and telegram-bot (no HTTP listener — `BlockingScheduler` has no port, confirmed in `scripts/install-nssm-scheduler.ps1`'s existing comment citing 02-RESEARCH.md Pattern 5), Windows service status (`Get-Service` → `Running`, no active crash-restart loop) is the accepted responsiveness signal. Do not add a fake HTTP listener or heartbeat file just to force a uniform check shape across all 6 services.
- **D-03:** Build one unified health-check rollup script (e.g. `scripts/check-health.ps1`) that polls: backend `/api/v1/health` (now DB-checked per D-01), nginx root, print-agent `/health`, and `Get-Service` status for scheduler/telegram-bot/Postgres — then prints a single clear PASS/FAIL summary. This is the actual "is the POS up" deliverable an operator would run, not just scattered per-service checks left over from Phase 2/3 install scripts.

### Ghost-ticket root cause (DATA-02)
- **D-04:** Investigate and attempt a real fix, not just documentation. Trace the actual code path(s) where a crash/restart/network-drop mid-transaction can leave ticket/resource/timer-session state inconsistent (existing symptoms per `.planning/codebase/CONCERNS.md` and `RECOVERY.md:196-217`: open ticket on an already-`AVAILABLE` resource, orphaned timer sessions, duplicate open tickets per resource). Fix what's structurally feasible (e.g. a DB-level constraint/trigger, or wrapping the multi-table ticket-open/resource-update sequence in one atomic transaction) and explicitly document what remains a residual risk, per DATA-02's own "fixed if feasible... otherwise explicitly flagged" allowance.
- **D-05:** `backend/app/api/tickets.py:1344-1410`'s `clean_ghost_tickets()` already has a partial guard (`was_reopened` check, referred to in an inline comment as "the F-1 fix") — read this code and its surrounding comments carefully before proposing a new fix; understand what's already been tried and why, don't duplicate or regress it.
- **D-06 (HARD CONSTRAINT — do not violate in this phase or any future phase):** No GSD plan, in this phase or any later phase (including Phase 5), may include an automated or scheduled step that runs `clean-ghosts`, `force-close`, or any other write/cleanup action against the **live bar machine's production database**. DATA-02 is satisfied entirely by: (1) root-cause investigation, (2) a fix built and validated on the staging machine only, (3) confirming the existing recovery tooling works correctly on staging. Actually running that tooling against production is a manual, user-initiated action the user performs themselves, at a time of their own choosing, outside of any GSD-authored plan or script. If a future phase's planner is tempted to add a "run clean-ghosts on the bar machine" step (e.g. as part of Phase 5 cutover prep), it must NOT — flag it as a manual runbook step for the user instead, never an automated task.
- **D-07:** Read-only diagnostic queries against the live bar machine (e.g. counting current ghost tickets to gauge severity) are a separate question from cleanup and are out of this phase's scope entirely — not needed to satisfy DATA-02, which only requires the fix + validated tooling to exist.

### Validation environment & method (SUP-01/02/03)
- **D-08:** All Phase 4 validation work happens on the staging machine (WIDOWSVAIL) only — same precedent as Phase 2 (D-01) and Phase 3. The live bar machine is not touched in this phase.
- **D-09:** SUP-03 (auto-start after reboot/power loss) is validated with an **actual reboot** — `Restart-Computer` on the staging machine via SSH, then confirm all 6 services (Postgres, backend, scheduler, telegram-bot, nginx, print agent) come up automatically in correct dependency order afterward. A simulated stop/start sequence does not exercise real Windows boot-time service-startup timing/ordering and is not sufficient proof.
- **D-10:** SUP-01 (independent crash-restart) is validated by forcibly killing each service's process (`Stop-Process -Force` on the PID — not a graceful `nssm stop`) one at a time, then confirming: (a) NSSM/Windows auto-restarts that one service within its configured `AppRestartDelay`, and (b) the other 5 services are completely unaffected. This is the actual failure mode SUP-01 exists to fix versus today's Docker all-or-nothing blast radius — a live kill-and-observe test proves it, a config review alone does not.
- **D-11:** SUP-02 (correct dependency order at boot) is proven by the same D-09 reboot test — `install-all-native-services.ps1` already wires `DependOnService` (Postgres → Backend/Scheduler/TelegramBot → Nginx, confirmed at `scripts/install-all-native-services.ps1:561-566`); this phase validates that wiring actually produces correct real-world startup ordering, it doesn't need to re-wire it from scratch.

### NET-02 startup health-check placement
- **D-12:** Add the print-agent reachability check to the Python backend's startup code (`backend/app/__init__.py`'s `create_app()`, near the existing `_check_default_secrets` warn-only pattern from Phase 3 — see `backend/app/__init__.py:1031+`). This makes it run on every actual backend start (service restart, reboot, everything) — not just the one-time PowerShell install-time check that `install-all-native-services.ps1:636-642` already does today, which only fires during initial installation.
- **D-13:** Warn and continue — never block or delay backend startup waiting for the print agent. Matches Phase 3's D-11 established philosophy exactly (warn loudly to the centralized log, never fail/block for a live bar), and matches the existing architecture where printing is already fire-and-forget and never blocks ticket operations elsewhere in the app (see `CLAUDE.md` Architecture section).

### Claude's Discretion
- Exact PowerShell/Python implementation details of the unified health-check script (D-03) — output formatting, exit codes, whether it's callable standalone or wraps into `install-all-native-services.ps1`'s existing verification step.
- Exact mechanism for the ghost-ticket fix (D-04) — DB constraint vs. trigger vs. application-level transaction wrapping — pick whichever is most surgical given what the investigation finds.
- Whether Postgres's native Windows service (installed via the EDB installer, not NSSM-wrapped) needs explicit `sc.exe failure` recovery configuration for SUP-01 parity with the NSSM-wrapped services — confirmed during codebase scout that `scripts/install-postgres-native.ps1` currently has no such config; investigate and add if it's a real gap.
- Exact wording/format of the DATA-03 (eventlet single-worker constraint) verification — a grep-based audit for raw `threading.Thread` usage plus confirmation `wsgi.py` runs single-process under the native hosting model, written up as a short verification note.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 2/3 outputs this phase builds on and validates
- `.planning/phases/02-core-service-migration/02-CONTEXT.md` — D-05 explicitly flags DATA-03 ("preserves the eventlet single-worker constraint... verified in Phase 4") as this phase's responsibility; D-04 (NSSM), D-07 (per-service venvs) this phase's changes must remain compatible with
- `.planning/phases/03-centralized-logging-secrets/03-CONTEXT.md` — D-11/D-12 warn-never-block philosophy that D-13 above extends to NET-02; centralized log directory (`C:\POS\logs\`) that all new warnings/checks in this phase should write to
- `scripts/install-all-native-services.ps1:561-566` — existing `DependOnService` wiring (Postgres → Backend/Scheduler/TelegramBot → Nginx) that SUP-02 validates, not re-implements
- `scripts/install-nssm-backend.ps1:192,199-200`, `scripts/install-nssm-nginx.ps1:160,162`, `scripts/install-nssm-telegram-bot.ps1:155,196`, `scripts/install-nssm-print-agent.ps1:130,138`, `scripts/install-nssm-scheduler.ps1:157,204` — existing `SERVICE_AUTO_START` / `AppExit Default Restart` config per service that SUP-01/SUP-03 validate
- `scripts/install-postgres-native.ps1` — native Postgres service install; currently no explicit failure-recovery config (see Claude's Discretion above)

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — SUP-01..04, NET-02, DATA-02, DATA-03 definitions
- `.planning/ROADMAP.md` §"Phase 4: Process Supervision & Reliability Hardening" — goal and success criteria

### Ghost-ticket / data-integrity references
- `RECOVERY.md:190-219` — existing DB integrity check queries (ghost tickets, orphaned timers, duplicate open sessions) and manual crash-recovery procedures this phase's fix must remain compatible with
- `backend/app/api/tickets.py:1276` (`open-all`), `:1299` (force-close), `:1344-1410` (`clean_ghost_tickets`) — existing recovery tooling and the partial `was_reopened` guard ("F-1 fix") already landed
- `.planning/codebase/CONCERNS.md` §"Recurring 'ghost ticket' / stuck resource data corruption" — documented symptoms, trigger, and file references

### Health-check / print-agent references
- `backend/app/__init__.py:1024-1027` — existing bare `/api/v1/health` endpoint to be deepened per D-01
- `backend/app/__init__.py:1031+` — `_check_default_secrets` warn-only pattern (Phase 3) that D-12's new print-agent check should follow structurally
- `scripts/install-all-native-services.ps1:627-642` — existing one-time install-verification checks (nginx root, print-agent `/health`) this phase's unified script (D-03) supersedes/wraps
- `CLAUDE.md` §"Architecture" — "printing is fire-and-forget and never blocks ticket operations" — the existing precedent D-13 extends to startup

### Production access boundary (CRITICAL)
- `CLAUDE.md` §"Branch safety" and §"Production access (bar machine)" — existing hard rule that any action touching the live bar machine requires explicit user confirmation; D-06 above is this phase's specific application of that rule to DATA-02

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `backend/app/__init__.py`'s `_check_default_secrets` function (Phase 3) — the exact warn-only-never-block pattern to follow for the new print-agent reachability check (D-12/D-13)
- `scripts/install-all-native-services.ps1`'s existing per-service verification checks (lines 627-642) — reusable logic to consolidate into the unified health-check script (D-03), not reimplement from scratch
- `RECOVERY.md`'s existing integrity-check SQL queries — directly reusable/extendable for the ghost-ticket root-cause investigation (D-04)

### Established Patterns
- NSSM `AppExit Default Restart` + `SERVICE_AUTO_START` already applied uniformly across backend/scheduler/telegram-bot/nginx/print-agent install scripts — SUP-01/SUP-03 validate this existing pattern rather than introducing a new one
- `DependOnService` chain already wired in `install-all-native-services.ps1` step 7 — SUP-02 validates this, doesn't redesign it
- Warn-loudly-never-block for live-bar operational safety — established in Phase 3 (D-11/D-12) for secrets, extended in this phase (D-13) to print-agent reachability

### Integration Points
- `backend/app/__init__.py`'s `create_app()` factory is the single place both the Phase 3 secrets check and this phase's new print-agent check attach — one consistent startup-warning integration point
- `Ticket`/`Resource`/`PoolTimerSession` models (`backend/app/models/`) are the tables involved in ghost-ticket state desync — the atomic-transaction or constraint fix (D-04) needs to span whichever of these tables the root-cause trace implicates

</code_context>

<specifics>
## Specific Ideas

No UI/format requirements (infrastructure phase). The user was firm and explicit that production database safety is non-negotiable: no automated plan, in this phase or any future phase, may write to or clean up the live bar machine's database — that action stays entirely manual and user-initiated (D-06). This is the single most important constraint captured in this discussion and must be respected by every downstream agent (researcher, planner, executor) for this phase and beyond.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. Read-only production diagnostics (D-07) were explicitly scoped out as unnecessary for satisfying DATA-02, not deferred to a future phase — they're simply not needed.

</deferred>

---

*Phase: 4-Process Supervision & Reliability Hardening*
*Context gathered: 2026-08-09*

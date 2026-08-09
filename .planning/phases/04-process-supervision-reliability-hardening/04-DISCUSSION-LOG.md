# Phase 4: Process Supervision & Reliability Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-09
**Phase:** 4-Process Supervision & Reliability Hardening
**Areas discussed:** Health-check depth & "POS is up" gate, Ghost-ticket root cause (DATA-02), Validation environment & method for SUP-01/02/03, NET-02 startup health-check placement

---

## Health-check depth & "POS is up" gate

| Question | Option | Description | Selected |
|---|--------|-------------|----------|
| Deepen `/api/v1/health`? | Deepen to check DB | SELECT 1 against Postgres before returning ok — catches process-alive-but-DB-dead | ✓ |
| | Keep it shallow | HTTP 200 only, no DB check | |
| Scheduler/bot responsiveness signal? | Windows service status | Get-Service Running + no crash-restart-loop is enough | ✓ |
| | Heartbeat file/log check | Timestamped heartbeat per work cycle | |
| Unified rollup vs per-service? | One unified health-check script | Single scripts/check-health.ps1, PASS/FAIL summary across all 6 services | ✓ |
| | Per-service checks only | Rely on existing scattered install-script checks | |

**User's choice:** All three recommended options accepted as-is.
**Notes:** None.

---

## Ghost-ticket root cause (DATA-02)

| Question | Option | Description | Selected |
|---|--------|-------------|----------|
| Production DB scope | Defer live cleanup to Phase 5 | Matches DATA-01 precedent (D-10) | (superseded — see below) |
| | Clean live bar DB now, in Phase 4 | Production write action | (rejected) |
| Fix depth | Investigate + attempt a real fix | Trace crash-mid-transaction code path, fix what's feasible, document residual risk | ✓ |
| | Document root cause only | No code fix, rely on existing recovery tooling | |

**User's choice:** User strongly rejected the framing of the first question ("What is this about you can not touch live bar machine and fucking clean any DB. tell me more what is this host ticket") — required clarification on what a ghost ticket even is before answering. After explanation, user then explicitly hardened the scope beyond either original option: **no phase, ever, may automate or schedule production DB cleanup** — not even in Phase 5. This is stronger than the originally-offered "defer to Phase 5" option.

**Notes:** Captured as CONTEXT.md D-06 (hard constraint, binding on all future phases, not just this one). Ghost-ticket concept was explained inline: an `OPEN` ticket lingering on a table whose `Resource` is already marked `AVAILABLE`, caused by a crash/restart/network-drop mid-transaction leaving a multi-step update half-applied. Recovery tooling (`clean-ghosts`, `force-close`) and `RECOVERY.md` integrity queries already exist; this phase is about the root cause, not building new recovery tooling.

---

## Validation environment & method for SUP-01/02/03

| Question | Option | Description | Selected |
|---|--------|-------------|----------|
| Environment | Staging only | Matches Phase 2/3 precedent | ✓ |
| | Something else | | |
| SUP-03 reboot test | Actual Restart-Computer on staging | Real OS reboot via SSH, confirm dependency-ordered auto-start | ✓ |
| | Simulated stop/start sequence | No real reboot | |
| SUP-01 crash test | Kill each service's process and observe | Stop-Process -Force per service, confirm isolated auto-restart | ✓ |
| | Config review only, no live test | | |

**User's choice:** All three recommended options accepted as-is.
**Notes:** None.

---

## NET-02 startup health-check placement

| Question | Option | Description | Selected |
|---|--------|-------------|----------|
| Check location | Python backend startup code | Runs on every actual backend start, near Phase 3's `_check_default_secrets` pattern | ✓ |
| | PowerShell only, on-demand | Keep existing install-time-only check | |
| Block or warn | Warn and continue | Matches Phase 3 D-11 philosophy, matches fire-and-forget printing | ✓ |
| | Block startup until reachable | | |

**User's choice:** Both recommended options accepted as-is.
**Notes:** None.

---

## Claude's Discretion

- Exact implementation details of the unified health-check script (output formatting, exit codes, standalone vs. wrapped into `install-all-native-services.ps1`)
- Exact ghost-ticket fix mechanism (DB constraint vs. trigger vs. application-level transaction wrapping) — depends on investigation findings
- Whether Postgres's native Windows service needs explicit `sc.exe failure` recovery config for SUP-01 parity (confirmed gap during codebase scout — no such config exists today)
- Exact format of the DATA-03 eventlet single-worker verification writeup

## Deferred Ideas

None — discussion stayed within phase scope. Read-only production diagnostics were explicitly scoped out as unnecessary (not deferred — simply not needed to satisfy DATA-02).

---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Docker/Rancher Hosting Replacement
status: executing
stopped_at: Phase 4 context gathered
last_updated: "2026-08-09T22:39:34.804Z"
last_activity: 2026-08-09 -- Phase 04 planning complete
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 15
  completed_plans: 10
  percent: 40
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-08)

**Core value:** Staff can open a table, run the pool timer, add food/drink orders, and close out a ticket with correct billing — without the system losing track of what's open, what's been ordered, or what's been paid.
**Current focus:** Phase 03 — centralized-logging-secrets

## Current Position

Phase: 03 (centralized-logging-secrets) — EXECUTING
Plan: 2 of 4
Status: Ready to execute
Last activity: 2026-08-09 -- Phase 04 planning complete

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 0 | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Milestone v1.0: Chose native Windows Services (NSSM/WinSW) over Docker Engine in WSL2, Supervisor, Podman, PM2, Rust rewrite, and Electron (see `.planning/research/SUMMARY.md`)
- Roadmap: Phase 1 is a hands-on validation gate (measured RAM/CPU on real hardware) before committing to full migration — research itself is already complete
- Roadmap: DATA-01 (verified Postgres backup/restore) placed in Phase 2, sequenced before the Postgres native-service cutover (SVC-02)
- Roadmap: CUT-03 (Docker/Rancher uninstall) placed last in Phase 5, gated on a stable post-cutover period
- Production access established (2026-08-08): live bar machine reachable via ngrok SSH tunnel, credentials in root `.env` (git-ignored) — see `CLAUDE.md` "Production access" section and `.planning/codebase/INTEGRATIONS.md` "Production Remote Access" for method and confirmed-working account. Confirmed the live runtime is Rancher Desktop/k3s, not plain `docker compose`.
- A real production Postgres dump was pulled ahead of schedule via `docker exec pg_dump` over that tunnel (saved to `backups/*.dump`, git-ignored, 34MB DB / ~4s pull, zero container disruption confirmed). **This is outside Phase 2's declared scope** — `02-CONTEXT.md` D-01/D-03/D-09/D-10 say Phase 2 doesn't touch the live bar machine or real production data, and defers real-data backup verification to Phase 5. Done as a one-off at explicit user request; does not change Phase 2's plan/scope, but the artifact exists and may inform Phase 5's real-data cutover.

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

- `BAR_MACHINE_USERNAME1` (`bola8poolclub`) SSH login fails against the bar machine's ngrok tunnel — needs password check/rotation before it can be relied on (`BAR_MACHINE_USERNAME2` works fine).
- `billiards-scheduler-1` container on the live bar machine is reporting **unhealthy** (observed 2026-08-08) — pre-existing, unrelated to migration work, not yet investigated.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| v2 | OPX-01: tray/status UI for service up/down + manual restart | Deferred to v2 | Milestone v1.0 scoping |
| v2 | OPX-02: automated scheduled Postgres backups + monthly restore verification | Deferred to v2 | Milestone v1.0 scoping |
| v2 | PERF-01: evaluate Rust backend rewrite for further resource reduction | Deferred to v2 | Milestone v1.0 scoping |

## Session Continuity

Last session: 2026-08-09T21:57:59.152Z
Stopped at: Phase 4 context gathered
Resume file: .planning/phases/04-process-supervision-reliability-hardening/04-CONTEXT.md

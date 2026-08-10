# Phase 5: Cutover & Rollback - Context

**Gathered:** 2026-08-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Get the live bar machine fully operating on the native Windows Services stack (built and staging-validated in Phases 2-4), via a staged, entirely user-executed cutover, with a proven rollback path back to the currently-running Rancher Desktop/k3s Docker stack, and only uninstall Docker/Rancher after the user is personally confident the native setup is stable. Covers CUT-01, CUT-02, CUT-03. This is the first phase that touches the live bar machine at all — every prior phase (Phase 1-4) deliberately stayed on the staging machine (WIDOWSVAIL) only, per CLAUDE.md's branch-safety/production-access rules and each prior phase's own D-01/D-08-style staging-only boundary.

**Deliverable shape:** Not an automated GSD-executed migration. The deliverable is a bilingual (English + Spanish) runbook/guide plus the supporting scripts, written for the user to read and execute themselves, step by step, on the live bar machine. Claude/GSD does not SSH into the bar machine and run cutover steps during this phase — this extends Phase 4's D-06 hard constraint (no automated writes to the live production DB) to the entire cutover procedure, not just DB cleanup.

</domain>

<decisions>
## Implementation Decisions

### Execution model (applies to everything below)
- **D-01 (HARD CONSTRAINT):** The user executes the entire cutover manually on the live bar machine themselves, using scripts and documentation Claude produces. Claude does not execute any live-machine cutover step via the SSH tunnel during this phase. The deliverable is a **bilingual runbook (English and Spanish)** plus supporting scripts/checklists — not an automated migration plan. This generalizes Phase 4's D-06 (no automated writes to prod DB) to the full cutover, consistent with CLAUDE.md's "Production access (bar machine)" and "Branch safety" sections.
- **D-02:** `scripts/install-all-native-services.ps1` (built in Phase 2, proven on staging) already performs the complete native install — Postgres 15, NSSM-wrapped backend/scheduler/bot/nginx. Nothing new needs to be built for the install step itself; it has simply never been *run* on the live bar machine yet, because Phase 2-4 work stayed on staging by design. The runbook's Stage 0 is running that same orchestrator script on the live machine (pointed at a local/placeholder DB until Stage C below brings in the real data).

### Cutover procedure (CUT-02) — staged, not a single flip-the-switch
This is the actual production sequence, run on the live bar machine, not a staging dry-run (staging never had the Rancher POS stack running — it only ever used synthetic seed data per Phase 2's D-09).

- **D-03 (Stage 0 — Install):** Run `install-all-native-services.ps1` on the live bar machine to stand up native Postgres 15 + NSSM-wrapped backend/scheduler/bot/nginx, without yet serving real traffic.
- **D-04 (Stage A — Cross-connect):** Point the native backend/frontend/scheduler/bot at the **still-running Rancher-hosted Postgres** (Docker/k3s `billiards-postgres-1` container, DB untouched) instead of the local native Postgres. Validate native services work correctly against the live Rancher DB before touching anything else.
- **D-05 (Stage B — Shift traffic):** Once Stage A is validated, shut down Rancher's **frontend + backend** containers only (leave the `billiards-postgres-1` DB container running in Rancher). Native services are now doing all real work; Rancher's only remaining job is hosting Postgres.
- **D-06 (Stage C — DB migration):** Once Stage B is validated stable, migrate the Postgres data from Rancher's DB container into the locally-installed native Postgres 15, reusing Phase 2's already-proven `scripts/postgres-backup-restore.ps1` dump/restore procedure (previously only exercised against synthetic data per Phase 2 D-09/D-10 — this is where it runs against real production data for the first time).
- **D-07 (Stage D — Full cutover):** Point native backend at the native Postgres, validate, then shut down Rancher entirely (DB container included). Docker Desktop/Rancher Desktop itself stays **installed** (not uninstalled) as the rollback fallback — CUT-03 uninstall is a separate, later, deliberate step (see Stability below).
- **D-08:** Each stage transition is gated on the checklist in D-11/D-12 passing before proceeding to the next stage — this is a deliberate multi-checkpoint migration, not one big-bang cutover.

### Rollback trigger & procedure (CUT-01)
- **D-09:** Rollback trigger is strict, not a grace-period/wait-and-see policy: **any break in core ticket flow** — can't open a table, can't print a chit, can't take payment, or the floor map stops updating live — triggers an immediate rollback decision. Favors getting back to a known-good state fast over live troubleshooting on a running bar.
- **D-10:** What "rollback" means depends on which stage the break happens in:
  - **Before Stage C (DB migration) completes:** Rancher's Postgres is still the source of truth (Stage A/B) or untouched (Stage 0) — rollback is simply restarting whichever Rancher containers were stopped. No data migration needed since the DB was never moved.
  - **After Stage C/D (DB already migrated to native Postgres):** rollback must **not** silently lose data. Dump whatever the native Postgres has at that point (including any new writes/tickets/orders created since the migration) and restore that dump into Rancher's Postgres before bringing Rancher's frontend/backend back up — so no ticket/order data from the cutover window is lost. This is more involved than a plain "restore the pre-cutover backup," and the runbook must spell out this exact reverse dump/restore procedure, not just a generic "run backup-restore in reverse" note.
- **D-11:** Docker/Rancher is left fully installed and untouched (beyond the containers explicitly stopped in Stage B/D) throughout the entire cutover, specifically so rollback is always possible without a reinstall.

### Timing (CUT-02)
- **D-12:** No fixed calendar date/time is baked into the runbook. Document the recommendation as "run during closed hours / the lowest-traffic window you choose" — the user picks the actual date/time themselves when ready to execute.

### Production secrets
- **D-13 (deviates from Phase 3's own flag — explicit user decision):** Keep the live bar machine's existing secrets (DB password, JWT secrets, role PINs) as-is — do **not** freshly generate/rotate them for cutover. Phase 3's 03-CONTEXT.md D-09 had flagged that production secrets "must be freshly generated/rotated, not carried over verbatim from staging's test values" — the user has now explicitly overridden that for Phase 5: reuse whatever's currently live, just relocate them into Windows Credential Manager via Phase 3's existing migration script (`scripts/migrate-secrets-to-dpapi.ps1` / `scripts/reconfigure-secrets.ps1`). Flag this explicitly for the planner as a deliberate deviation, not an oversight.

### Validation checklist (CUT-02, gates every stage transition)
- **D-14:** At every stage transition (Stage 0→A→B→C→D), the checklist is: (1) `scripts/check-health.ps1` returns a clean PASS across all services, **and** (2) a manual smoke test — physically open a table, add an order, print a physical chit, close the ticket out — performed by the user themselves before moving to the next stage. Automated health-check output alone is not sufficient to advance a stage; the manual walkthrough is required every time.

### Stability period & Docker/Rancher uninstall (CUT-03)
- **D-15:** No fixed number of days is baked into the runbook as a hard gate. Document what "stable" means to look for (no rollback triggered, no crash-restart loops visible in `C:\POS\logs\`, `check-health.ps1` staying clean over multiple checks) but leave the actual go/no-go timing decision to the user's own judgment — they decide personally when they're ready to uninstall.
- **D-16:** Uninstalling Docker Desktop/Rancher Desktop (CUT-03) is a manual step the user performs themselves, at a time of their choosing, after Stage D has been running cleanly — same manual-execution boundary as D-01. The runbook documents the uninstall steps; it is never an automated/scheduled action.

### Claude's Discretion
- Exact commands/config for Stage A's cross-connect (D-04) — how the native backend's `DATABASE_URL`/connection config points at Rancher's `billiards-postgres-1` container given it doesn't publish port 5432 to the host today (per CLAUDE.md — pg_dump currently reaches it only via `docker exec` over SSH). The runbook needs a concrete, safe way to expose/reach that port temporarily (e.g., a compose port-mapping override) for Stage A/B to work, and must document exactly what changes and how to revert it.
- Exact reverse dump/restore commands for post-migration rollback (D-10) — build directly on `scripts/postgres-backup-restore.ps1`'s already-proven dump/restore mechanics, just reversing source/target.
- Whether the bilingual runbook is one document with parallel EN/ES sections, or two separate files — pick whichever is clearer to follow live, at the bar, potentially under stress.
- Exact wording/structure of the manual smoke-test checklist items (D-14) beyond the four listed actions (open table, add order, print chit, close ticket) — may add 1-2 more if something important is missing (e.g., a promotion/discount application) to give real confidence, but don't bloat it into a long QA script.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Production access & safety boundary (CRITICAL)
- `CLAUDE.md` §"Branch safety — read before any git operation" and §"Production access (bar machine)" — the hard rule this phase's entire execution model (D-01) is built around; live bar machine details (ngrok tunnel, confirmed-working `BAR_MACHINE_USERNAME2`, non-publishing Postgres port, Rancher Desktop/k3s runtime) live here
- `.planning/phases/04-process-supervision-reliability-hardening/04-CONTEXT.md` D-06 — the hard constraint (no automated writes to live prod DB) that D-01 above extends to the full cutover procedure

### Prior phase decisions this phase builds on
- `.planning/phases/02-core-service-migration/02-CONTEXT.md` D-08/D-09/D-10 — proven pg_dump/pg_restore procedure (`scripts/postgres-backup-restore.ps1`), explicitly deferred real-production-data execution to Phase 5 (this phase)
- `.planning/phases/03-centralized-logging-secrets/03-CONTEXT.md` D-06/D-09 — Credential Manager secrets storage and migration script; D-09's "freshly generate for production" recommendation is explicitly overridden by this phase's D-13
- `.planning/phases/04-process-supervision-reliability-hardening/04-CONTEXT.md` D-01–D-03 — deepened `/api/v1/health` + `scripts/check-health.ps1` unified health-check rollup, reused as this phase's stage-gate checklist (D-14)

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` §"Cutover & Rollback" — CUT-01, CUT-02, CUT-03 definitions
- `.planning/ROADMAP.md` §"Phase 5: Cutover & Rollback" — goal and success criteria

### Existing scripts this phase reuses (do not rebuild)
- `scripts/install-all-native-services.ps1` — full native-stack orchestrator (Stage 0)
- `scripts/postgres-backup-restore.ps1` — proven dump/restore mechanics (Stage C, and reversed for post-migration rollback per D-10)
- `scripts/check-health.ps1` — unified health-check rollup (stage-gate checklist, D-14)
- `scripts/migrate-secrets-to-dpapi.ps1`, `scripts/reconfigure-secrets.ps1` — secrets relocation into Credential Manager (D-13)
- `RECOVERY.md` — existing Docker-based crash-recovery commands, useful reference for what "restart Rancher" looks like today

### Production environment facts
- `.planning/codebase/INTEGRATIONS.md` — confirms live containers (`billiards-postgres-1`, `billiards-backend-1`, `billiards-frontend-1`, `billiards-telegram-bot-1`, `billiards-scheduler-1` — the last one pre-existing "unhealthy", unrelated to migration) and that the runtime is Rancher Desktop/k3s, not plain `docker compose`
- `backups/billiardbar_prod_20260808_180519.dump` — a real production Postgres dump already pulled once (2026-08-08, outside Phase 2's declared scope, per STATE.md) — may be useful as a reference/rehearsal artifact but Stage C's actual migration dump must be freshly taken at cutover time, not this stale one

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/install-all-native-services.ps1` — complete, staging-proven native install orchestrator; runs as-is on the live machine for Stage 0
- `scripts/postgres-backup-restore.ps1` — dump/restore mechanics proven against synthetic data in Phase 2; this phase is the first real-data run, and also the basis for the reverse (native→Rancher) rollback dump
- `scripts/check-health.ps1` — already designed to run "on either the staging machine or the live bar machine" per its own header comment; directly reusable as the stage-gate check

### Established Patterns
- Warn-loudly-never-block philosophy (Phase 3 D-11/D-12, Phase 4 D-13) — should extend to any new startup/connectivity warnings this phase's Stage A cross-connect introduces
- Idempotent, `IF NOT EXISTS`-guarded DB setup (`flask init-db`) — relevant if Stage A/Stage 0 sequencing ever re-runs schema setup against the Rancher DB or native DB

### Integration Points
- Native backend's DB connection config (env var / Credential Manager-sourced `POSTGRES_*` values) is the single point that changes between Stage A (pointed at Rancher) and Stage D (pointed at native Postgres) — no code changes needed, just config/connection-string changes per stage
- Rancher's `billiards-postgres-1` container currently does not publish port 5432 to the host (CLAUDE.md) — Stage A's cross-connect is the one new piece of plumbing this phase requires that no prior phase needed, since prior phases never needed the native machine to reach a live Docker-hosted Postgres

</code_context>

<specifics>
## Specific Ideas

The user was explicit and firm on two points that must be respected by every downstream agent (researcher, planner, executor) for this phase:

1. **Everything is manual.** The user runs every cutover command themselves on the live bar machine. Claude's job is to produce a complete, clear, bilingual (English + Spanish) runbook and the scripts it references — never to execute cutover steps against the live machine itself.
2. **The staged sequence is specific and deliberate**, not a generic "stop Docker, start native" cutover: keep Rancher's Postgres as the source of truth while cross-connecting native services to it first (Stage A), shift traffic by stopping only Rancher's app containers (Stage B), migrate the DB only once that's proven stable (Stage C), and only then fully retire Rancher (Stage D). This minimizes risk by never touching the database until the native application layer has already proven itself against live data via Rancher's DB, and Docker/Rancher stays installed as a live fallback the entire time.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 5-Cutover & Rollback*
*Context gathered: 2026-08-09*

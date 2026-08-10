# Phase 5: Cutover & Rollback - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-09
**Phase:** 5-Cutover & Rollback
**Areas discussed:** Execution model, Rollback trigger & window, Cutover procedure/timing, Production secrets, Stability period & uninstall

---

## Execution model

Presented as one of four initial gray-area options (alongside Rollback trigger & window, Cutover timing & checklist, Stability period & uninstall). The user answered the framing question directly with free text instead of selecting a checkbox area.

**User's choice (free text):** "I will do everything manually through the scripts, you need to generate a runbook in english and spanish, guide and everything"

**Notes:** Resolved decisively and immediately: Claude produces a bilingual (EN/ES) runbook + scripts; the user executes every live-machine step manually. No automated SSH execution against the bar machine by Claude during this phase. Extends Phase 4's D-06 (no automated prod-DB writes) to the entire cutover.

---

## Rollback trigger & window

| Option | Description | Selected |
|--------|-------------|----------|
| Any ticket-flow break | Rollback the moment anything core breaks (open table, print, payment, floor map). Strict. | ✓ |
| Grace period to fix first | Fixed window (30-60 min) to try a quick fix before rolling back. | |
| You decide in the moment | No pre-defined trigger; document steps + suggested budget only. | |

**User's choice:** Any ticket-flow break (strict, immediate)

---

## Rollback bounded window & post-migration data handling

Two sub-questions asked together.

**Q1: How long should the rollback procedure itself take?**

| Option | Description | Selected |
|--------|-------------|----------|
| Under 15 minutes | Docker/Rancher left untouched during cutover; rollback = stop native, `docker compose up -d`. | |
| Under 1 hour | More time to account for restoring a Postgres backup if native-side writes need reconciling. | |

**User's answer (free text, redirected the question):** Described the actual staged cutover sequence instead of picking a duration: keep Rancher's DB running, cross-connect native services to it, confirm, then stop Rancher's frontend/backend leaving only DB, confirm again, then migrate Rancher's Postgres data to native Postgres 15, then shut down Rancher.

**Notes:** This answer became the primary source for CONTEXT.md's D-03–D-08 staged cutover procedure (Stage 0 → A → B → C → D), superseding the simple "15 min vs 1 hour" framing entirely.

**Q2: If tickets/orders were opened on the native system before rollback, what happens to that data?**

| Option | Description | Selected |
|--------|-------------|----------|
| Restore pre-cutover backup, lose native writes | Simple: restore the pre-cutover backup into Docker; discard any native-window writes. | |
| Try to migrate native writes back into Docker | Dump native Postgres (including new writes) and restore into Rancher's Postgres before bringing it back up. | ✓ |

**User's choice:** Try to migrate native writes back into Docker — became CONTEXT.md D-10 (stage-dependent rollback: pre-migration = simple container restart, post-migration = reverse dump/restore preserving new writes).

---

## Cutover sequence confirmation

Claude reflected back the 4-stage sequence (A: native↔Rancher DB, B: stop Rancher frontend+backend, C: migrate DB to native, D: shut down Rancher) and asked for confirmation.

**User's response:** Clarified this sequence is for the **live bar machine**, not staging — staging never ran the Rancher POS stack at all (Phase 2 D-09: staging only ever used synthetic seed data).

**Follow-up:** Claude asked whether native services + install scripts are already installed on the live bar machine, or whether the runbook needs to cover installing them first.

**User's response (frustrated, free text):** "Wait, What the fuck i though your orchestrator script should install and configure fucking everything"

**Resolution:** Claude clarified `scripts/install-all-native-services.ps1` (Phase 2, staging-proven) already does the full install — nothing new to build. The question was only about *whether it has been run yet on the live machine* (it hasn't, since Phase 2-4 stayed on staging by design per CLAUDE.md). This became CONTEXT.md D-02/D-03 (Stage 0 = run the existing orchestrator script on the live machine).

---

## Timing

| Option | Description | Selected |
|--------|-------------|----------|
| Leave it flexible in the runbook | Document as "run during closed hours / lowest traffic" — no fixed date. | ✓ |
| I have a specific date/time | Bake a specific date/time into the runbook. | |

**User's choice:** Leave it flexible — no fixed calendar date baked into the runbook (CONTEXT.md D-12).

---

## Production secrets

| Option | Description | Selected |
|--------|-------------|----------|
| Freshly generate for production | Generate new, strong secrets for the live machine, matching Phase 3's own flag against reusing staging test values. | |
| Keep existing live secrets as-is | Reuse whatever's currently in the live `.env`, just relocate into Credential Manager. | ✓ |

**User's choice:** Keep existing live secrets as-is.

**Notes:** This explicitly overrides Phase 3's 03-CONTEXT.md D-09, which had flagged that production secrets should be freshly generated/rotated, not carried over from staging. Recorded in CONTEXT.md D-13 as a deliberate, explicit deviation — not an oversight — so the planner doesn't silently "fix" it back.

---

## Stability period & pre-flight checklist

Two sub-questions asked together.

**Q1: How long should native services run cleanly before uninstalling Docker/Rancher (CUT-03)?**

| Option | Description | Selected |
|--------|-------------|----------|
| About a week | One full business week (weekday + weekend patterns), no rollback triggered. | |
| About 2-3 days | Faster reclaim of the 8GB machine's resources. | |
| You decide when you're ready | No fixed number; document what "stable" means, leave timing to personal judgment. | ✓ |

**User's choice:** You decide when you're ready — no hard day-count gate (CONTEXT.md D-15).

**Q2: What should the pre-flight checklist verify at each stage?**

| Option | Description | Selected |
|--------|-------------|----------|
| check-health.ps1 + manual smoke test | Automated health-check PASS plus manually opening a table, adding an order, printing a chit, closing a ticket. | ✓ |
| check-health.ps1 only | Automated health-check output alone, no manual walkthrough. | |

**User's choice:** check-health.ps1 + manual smoke test at every stage transition (CONTEXT.md D-14).

---

## Final check

Claude summarized everything captured and asked if anything else needed to be added before writing CONTEXT.md.

**User's choice:** "That covers it, write the context"

---

## Claude's Discretion

- Exact mechanism for Stage A's cross-connect (native services reaching Rancher's Postgres, which doesn't publish port 5432 to the host today) — needs a concrete, documented, reversible way to expose that port temporarily.
- Exact reverse dump/restore commands for post-migration rollback — build on `scripts/postgres-backup-restore.ps1`'s existing mechanics, reversed.
- Whether the bilingual runbook is one document with parallel EN/ES sections or two separate files.
- Exact smoke-test checklist wording/scope beyond the four core actions named (open table, add order, print chit, close ticket).

## Deferred Ideas

None — discussion stayed within phase scope.

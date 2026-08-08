# Phase 1: Validation & Decision Lock - Context

**Gathered:** 2026-08-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Lock in the hosting-migration decision before Phase 2+ engineering effort begins. Concretely:

- HOST-01 (ranked comparison of 5+ hosting alternatives) — already satisfied by existing research artifacts in `.planning/research/`.
- HOST-02 (go/no-go decision on native Windows Services) — satisfied by writing a short, explicit decision record, **not** by live RAM/CPU measurement on hardware.

No code changes, no service migration, no NSSM/WinSW installation happens in this phase — that's Phase 2 (Core Service Migration). Phase 1 produces a decision document only.

</domain>

<decisions>
## Implementation Decisions

### Measurement approach
- **D-01:** No live RAM/CPU measurement will be performed — not on the bar machine, a spare/equivalent machine, or a VM. The user has direct operational knowledge of the current Docker/Rancher footprint and is satisfied by the existing research numbers (Docker/Rancher ~3–4GB idle vs. NSSM/WinSW <500MB idle, per `.planning/research/STACK.md`).
- **D-02:** No NSSM/WinSW service-wrapping proof-of-concept is built in this phase for measurement purposes. Real service wrapping is Phase 2 scope (SVC-01..05).

### Go/no-go decision record
- **D-03:** Phase 1's only deliverable is a short decision document (one paragraph is sufficient) stating: the decision is GO on native Windows Services (NSSM/WinSW), citing the existing research comparison as justification, and explicitly noting that no live measurement was performed — this is a documented judgment call, not an empirically measured one.
- **D-04:** No formal caveats/trigger-conditions section is required in the decision doc — user declined the more structured "decision + citation + caveats" format in favor of the minimal version.

### Success criteria deviation (flag for planner/verifier)
- **D-05:** ROADMAP.md Phase 1 success criterion #2 currently reads *"Actual RAM/CPU usage of the stack running without Docker/Rancher is measured on the real bar machine... and compared against the current Docker/Rancher baseline."* This will **not** be literally satisfied — it is being satisfied instead by a documented decision citing existing research, per D-01–D-03. Plans and verification should treat this criterion as met by the decision record, not by adding a measurement task. The user was informed of this deviation and explicitly confirmed proceeding this way. ROADMAP.md wording has not been edited (out of scope for this discussion) — a future `/gsd:phase --edit 1` pass could tighten the wording if desired, but is not required to plan or execute this phase.

### Claude's Discretion
- Exact filename/location of the decision record within the phase directory (e.g. `01-DECISION.md` or embedded directly in the phase's SUMMARY.md) — planner/executor may choose whichever fits the existing plan output conventions.
- Exact prose/wording of the decision paragraph, as long as it states the GO decision and cites the research source.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Hosting decision research (satisfies HOST-01)
- `.planning/research/SUMMARY.md` — executive summary, ranked verdict table for all 8 alternatives, decision already made (native Windows Services)
- `.planning/research/STACK.md` — resource-footprint numbers per alternative (Docker/Rancher ~3–4GB idle vs. NSSM/WinSW <500MB idle) — the citation source for the decision record
- `.planning/research/ARCHITECTURE.md` — integration paths per hosting option
- `.planning/research/PITFALLS.md` — 8 critical pitfalls that apply regardless of chosen path (relevant context for the decision record's caveats, if any are added)

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — HOST-01 and HOST-02 definitions, milestone context
- `.planning/ROADMAP.md` — Phase 1 goal and success criteria (see D-05 above for the noted deviation)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — this phase produces a decision document only, no code changes.

### Established Patterns
- N/A for this phase.

### Integration Points
- N/A for this phase. `docker-compose.yml` (current baseline: postgres, backend, frontend, scheduler, telegram-bot services) is reference-only context for the decision record, not something modified here.

</code_context>

<specifics>
## Specific Ideas

No specific format requirements beyond "short, one paragraph, cites the research, states the decision explicitly." User explicitly rejected building any measurement tooling or proof-of-concept for this phase.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (User did consider removing Phase 1 entirely but chose to keep it, shrunk to the decision-record-only scope captured above.)

</deferred>

---

*Phase: 1-Validation & Decision Lock*
*Context gathered: 2026-08-08*

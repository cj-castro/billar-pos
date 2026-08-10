# Print Path Hardening — Design

**Date:** 2026-08-09
**Branch:** rust-backend-migration
**Status:** Approved, pending implementation plan

## Background

An audit of the receipt/chit printing path (`scripts/print_agent/print_agent.py`, `backend/app/api/tickets.py`, `backend/app/api/queue.py`, `backend/app/models/print_job.py`, and the frontend retry UX) scored it **4.0/10** across seven dimensions: robustness, scalability, reusability, shock-proof, fail-proof, bulletproof (security), and reliable. Full audit: `https://claude.ai/code/artifact/d474bf2e-cfe6-4539-b812-92a79d8e4695`.

Hardware confirmed during this design pass: two thermal printers on the bar's Windows host — one USB, one ("Cocina Comandas", the kitchen printer) paired over **Bluetooth**, installed as a normal Windows printer object bound to a virtual serial port (**COM3**, confirmed via Windows printer properties → Ports tab). This matters because it means the transport code doesn't need to change — `win32print.OpenPrinter()`/`WritePrinter()` already talks to a Bluetooth-paired printer exactly like a USB one, since Windows' Bluetooth driver abstracts the radio layer behind a normal COM port. The actual risk lives at the OS/radio layer: pairing drops mid-service, printer auto-sleep, and COM port renumbering after a Windows update or reboot — none of which the current code detects, times out on, or recovers from.

This was confirmed live during the design session: a screenshot from production (2026-08-09, ~19:51) showed a floor-staff ticket print attempt fail with a raw toast — `Print agent error (500): {"ok":false}` — the exact failure mode this plan targets, caught in the act.

## Goal

Raise the overall score to **at least 8/10**, using the printers already installed (no new hardware purchase, no new external/cloud service, no protocol change).

## Approach

**Harden the existing agent in place**, rather than adopting QZ Tray or replacing hardware. Rationale: this system runs fully on-site with no internet dependency for core POS operations (see CLAUDE.md); the current architecture already works day-to-day, so the fix is closing specific, identified gaps rather than a rewrite. QZ Tray (certificate-based auth, offloaded printer discovery) remains a valid future option if the send-path itself needs professionalizing later, but isn't required to clear 8/10.

Two items surfaced by the original audit are explicitly **out of scope** for this plan:
- **Option 3 (network printer swap)** — not needed; both printers stay as-is.
- **Option 5 (PrintNode)** — rejected; requires internet per print job, conflicting with the fully-on-site design.
- **Option 2 (QZ Tray)** — deferred; noted above as a future option, not required for the 8/10 target.

## Target scorecard

| Dimension | Current | Target | Primary fix |
|---|---|---|---|
| Robustness | 5 | 8 | #6 human-readable errors, #4 printer health classification |
| Scalability | 3 | 6 | #2 production WSGI + thread pool |
| Reusability | 2 | 9 | #7 delete dead code |
| Shock-proof | 4 | 8 | #2 timeouts + circuit breaker |
| Fail-proof | 6 | 9 | #3 durable state, #5 auto-retry worker |
| Bulletproof (security) | 2 | 8 | #1 shared-secret auth |
| Reliable | 6 | 9 | net effect of all of the above |

Projected overall: **≈8.1/10**.

## Design

### 1. Close the security hole
Add a shared-secret token (`PRINT_AGENT_TOKEN`, env var, generated once) that the backend (`tickets.py`, `queue.py`) sends as a header and the agent (`print_agent.py`) validates on `/print`, `/chit`, and `/printers` — reject with 401 if missing/wrong. Before narrowing the bind address off `0.0.0.0`, verify that Docker Desktop's `host.docker.internal` resolution still reaches the agent (test on staging) — if binding to a specific LAN interface breaks that path, keep `0.0.0.0` and rely on the token as the primary control; note the residual exposure either way in the plan's threat model.

### 2. Make the agent production-grade
Replace `app.run(host='0.0.0.0', port=PORT, debug=False)` with `waitress-serve` (pure-Python, Windows-native, no new system dependency) and a small thread pool, so a slow/stuck write to one printer can't block the other printer's requests. Wrap each `OpenPrinter → WritePrinter` sequence in a bounded timeout (e.g. via a worker thread with a hard deadline). Add a per-printer-name circuit breaker: after N consecutive failures within a window, fail fast with a clear error instead of repeating a call that's likely to hang again; auto-reset after a cool-down or a successful health probe.

### 3. Durable agent state
Move the job-id dedup cache (`_printed_jobs`, currently an in-memory dict, `print_agent.py:42`) to a small local SQLite file next to `print_agent.py`, so an agent restart (crash, NSSM bounce, Windows update) doesn't silently drop in-flight dedup state.

### 4. Real printer health
Extend `/health` to call `win32print.GetPrinter()` and report actual status flags per configured printer — offline / paper-out / busy / error — not just the configured printer name. Distinguish "temporarily unreachable" (safe to retry soon — the Bluetooth-drop case) from "needs a human" (paper out) so the retry worker (#5) doesn't waste attempts hammering a printer that's out of paper.

### 5. Backend auto-retry worker
Add a `socketio.start_background_task` loop (same eventlet-safe pattern as the existing `_spawn_auto_print_chit` in `tickets.py`) that polls `FAILED` `PrintJob` rows younger than ~10 minutes and retries with backoff (e.g. 5s / 30s / 120s), using the health classification from #4 to skip retrying jobs blocked on a human-fixable state. `PrintRetryBanner.tsx` only needs to appear once automatic retries are exhausted.

### 6. Human-readable print errors
Classify failures on the backend (printer offline vs. paper out vs. agent unreachable) and have the frontend show actionable Spanish copy (e.g. "Impresora de cocina desconectada — revisa el Bluetooth") instead of the raw `{"ok":false}` dict currently shown to floor staff (confirmed live in production during this design session). Full technical detail stays in `PrintJob.error_msg` for managers/logs.

### 7. Delete dead code
Three formatter implementations are confirmed unused and safe to delete outright (the two *live* formatters, `format_receipt_escpos` and `format_receipt_html`, already share `_group_line_items`/`_group_modifiers` — no consolidation needed there):
- `format_receipt()` — dead, `print_agent.py:674-879`
- `backend/app/services/printer_service.py` — dead, references a `ticket_data` shape (`grouped_items`, `table`) that doesn't match the current `Ticket` model
- The unused `printReceipt()` export in `frontend/src/utils/printReceipt.ts` (374 lines, never imported)

### 8. Testing / rollout
Extend `scripts/test-print-agent.ps1` to cover: the new auth requirement (expect 401 without token), the new `/health` status fields, and a simulated printer-offline case. Validate on the staging Windows machine (`WIDOWSVAIL`) before touching the bar machine, consistent with how Phase 2/4 changes have been rolled out in this repo so far — this system prints live customer receipts, so no untested change goes directly to the bar machine.

## Non-goals

- No new hardware purchase.
- No change to the receipt layout/content itself — only to error handling, transport resilience, and auth around it.
- No introduction of a message broker (Redis/RabbitMQ) — the existing `PrintJob` table plus a polling worker is sufficient at this scale.

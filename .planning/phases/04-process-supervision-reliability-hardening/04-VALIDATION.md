---
phase: 04-process-supervision-reliability-hardening
plan: 05
validated: 2026-08-10
scope: staging (WIDOWSVAIL, 192.168.1.18 → 192.168.1.19 after Plan 04-05's reboot/DHCP reassignment) only — no bar-machine deployment occurred
---

# Phase 4 Validation (Complete) — Process Supervision & Reliability Hardening

Every file Plans 04-01/04-02/04-03 produced was pushed to the real staging Windows
machine (`C:\Users\giris\billiards-staging`, a file copy per Phase 2/3 precedent — pushed
via `scp`, never `git pull`) and exercised live: `backend/app/__init__.py`, `backend/wsgi.py`,
`backend/service_entry.py`, `scripts/check-health.ps1`,
`scripts/configure-postgres-failure-recovery.ps1`, `scripts/install-postgres-native.ps1`,
plus `scripts/install-nssm-print-agent.ps1`. Live execution surfaced two real, previously
undetected bugs (documented below, both found and fixed during Plan 04-04) and one
genuine environment-separation issue (documented, not fixed — TelegramBot, see SUP-01
(full) below). Plan 04-05 then ran the full live 6-service kill-isolation matrix and an
actual reboot, found and fixed one more real gap (Postgres's crash-restart path), and
completed this document with SUP-01 (full)/SUP-02/SUP-03 and the final Summary table
below. No placeholder text; every PASS/FAIL/PARTIAL below is backed by real staging
command output.

## NET-02 — Backend warns (never blocks) when the print agent is unreachable

**Status: PASS** (after a found-and-fixed bug — see below)

**Original evidence (bug found):** `BilliardBarPrintAgent` was installed on staging for the
first time via `install-nssm-print-agent.ps1` — `Get-Service BilliardBarPrintAgent` →
`Running`, and `Invoke-RestMethod http://localhost:9191/health` (PowerShell, direct) returned
`status: ok`. Despite this, every backend restart still logged:
```
WARNING app Print agent at http://localhost:9191 is unreachable (connection refused/no route)
```
Reproduced deterministically across 2 separate clean restarts. Root-caused via a direct Python
repro on staging: `eventlet.monkey_patch()` (DATA-03, Plan 04-02) replaces Python's DNS
resolution with eventlet's `greendns`, which raises `socket.gaierror: [Errno 11001] No address
found` for the literal hostname `"localhost"` on this Windows environment, while `127.0.0.1`
(an IP literal, no DNS lookup) connects fine. `check-health.ps1`'s own PowerShell-based
`Invoke-RestMethod` check to the same URL PASSed throughout — confirming the break was
specific to the Python/eventlet code path, not the print agent or the network.

This wasn't cosmetic: `backend/app/api/tickets.py`'s real print dispatch (`urllib.request`,
`/print` endpoint) and `backend/app/api/queue.py`'s `/chit` dispatch use the identical
`PRINT_AGENT_URL` default — real print jobs would have failed on this deployment as shipped.

**Fix applied (commit `cd86b4d9`):** changed the `PRINT_AGENT_URL` default from
`http://localhost:9191` to `http://127.0.0.1:9191` in `backend/app/__init__.py`,
`backend/app/api/tickets.py`, `backend/app/api/queue.py`, `.env.example`,
`scripts/install-nssm-backend.ps1`, and `scripts/reconfigure-secrets.ps1`.

**Re-verification (post-fix, live):** staging's already-deployed `BilliardBarBackend`
`AppEnvironmentExtra` was reconfigured with the new default (via a targeted, DPAPI-preserving
re-application of `reconfigure-secrets.ps1`'s Backend logic — deliberately not touching
`BilliardBarScheduler`/`BilliardBarTelegramBot`) and restarted. `backend_err.log` now shows:
```
INFO app Print agent reachable at http://127.0.0.1:9191
```
No warning. `check-health.ps1`'s `[NET-02]`/`[NET-02-http]` rows both PASS.

## SUP-04 — Real DB-backed health check, correct failure/recovery path

**Status: PASS**

`GET /api/v1/health` with Postgres running:
```json
{"db":"connected","status":"ok","timestamp":"2026-08-09T17:01:24.227372-06:00"}
```

With Postgres genuinely unreachable (see SUP-01 (partial) below for how staging's Postgres
service was actually taken down — `Stop-Service` alone was insufficient here):
```
HTTP 503
{"detail":"Database unreachable: OperationalError","status":"error","timestamp":"..."}
```
Generic `type(e).__name__`-based detail only — no raw exception string, connection string, or
`SQLALCHEMY_DATABASE_URI` value leaked in the response body, matching Plan 04-01's ASVS V13
requirement. After `Start-Service postgresql-x64-15`, the health check returned to
`{"db":"connected","status":"ok",...}` (HTTP 200). Postgres was confirmed stopped and then
running again before the task proceeded further — never left down.

`check-health.ps1`'s full run: `[SUP-04-health] PASS — status=ok db=connected`. Overall script
exit code is 1 only because of `[SVC-05] FAIL — Telegram bot` (see SUP-01 (partial) below); every
other row (`SVC-01/02/03/04`, `NET-02`, `NET-02-http`, `SVC-03-http`) PASSes.

## DATA-02 — Ghost-ticket structural invariant (deferred constraint triggers)

**Status: PASS** (smoke test found-and-fixed a real, unrelated bug along the way — see below)

Trigger existence query (`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_%consistency'`)
against staging's live Postgres:
```
 trg_ticket_resource_consistency
 trg_resource_ticket_consistency
```
Exactly 2 rows, as required.

**Smoke test — original run found a real, unrelated bug (Rule 1, fixed):** the plan's
required "open a ticket, then close it" smoke test initially failed at *open* with
`HTTP 500` / `sqlalchemy.exc.InvalidRequestError: Incorrect number of values in identifier to
formulate primary key for session.get()`. Root-caused: `Model.query.with_for_update().get(id)`
(SQLAlchemy's legacy `Query.get()` API) throws this error specifically when invoked via the
real eventlet-hosted `socketio.run()` request path — confirmed **not** reproducible via Flask's
`test_client()` or an isolated script, and confirmed **not** caused by the deferred triggers
themselves (the dominant `Model.query.with_for_update().get_or_404(id)` pattern, used ~15+
times elsewhere in this codebase including `close_ticket`, worked correctly live throughout).
This is unrelated to DATA-02's own trigger logic — a pre-existing latent bug DATA-02's own
smoke-test requirement is exactly what surfaced it.

**Fix applied (commit `a3fe34e4`):** all 14 bare `Model.query.with_for_update().get(id)` call
sites across `backend/app/api/tickets.py` (3), `backend/app/api/waiting_list.py` (2), and
`backend/app/services/inventory_svc.py` (9) were replaced with
`db.session.get(Model, id, with_for_update=True)` — SQLAlchemy 2.0's native equivalent,
confirmed not to exhibit the failure, while preserving each site's original None-handling
(custom JSON error responses, `raise ValueError`, or silent skip-continue — none of these
sites could be blindly swapped to `.get_or_404()`, which would have changed behavior).

**Re-verification (post-fix, live, run twice):** `POST /api/v1/tickets` → `HTTP 201`,
`POST /api/v1/tickets/<id>/close` → `HTTP 200`, both confirmed twice in a row against the
live staging service. The two triggers do not interfere with normal ticket open/close.

## DATA-03 — Eventlet single-worker constraint holds under native hosting

**Status: PASS**

`backend/service_entry.py` (confirmed on staging, live file content) calls
`eventlet.monkey_patch()` and `psycopg2_patcher.make_psycopg_green()` as its first
executable lines, before `import os`/`subprocess`/`sys` — restored parity with what
gunicorn's `EventletWorker` used to do implicitly in Docker. The live backend process ran
correctly under this patching for the full duration of this validation task (multiple
restarts, real HTTP/DB traffic, Socket.IO-hosting WSGI dispatch).

**Important nuance surfaced by this exact live validation:** DATA-02's smoke test (above)
found that eventlet's real request-dispatch path (not reproducible in an isolated script or
Flask's `test_client()`) breaks the legacy `Query.get()`+`with_for_update()` combination —
fixed in commit `a3fe34e4`. This is precisely the class of gap DATA-03's "explicitly verified
... to still hold under the new hosting model" requirement exists to catch: a regression that
was invisible under static code review or in-process testing, and only surfaced under the
real eventlet-hosted request path. With that fix applied, no further correctness issues were
observed. `grep -rn "threading\.Thread(" backend/` (already confirmed zero matches in
`04-DATA-03-VERIFICATION.md`) remains the case — no raw thread usage was introduced during
this plan's fixes either.

## SUP-01 (partial, Plan 04-04) — Postgres failure-recovery, print-agent install, TelegramBot diagnosis

> **Superseded by "SUP-01 (full)" below.** This section is preserved as the historical record of Plan 04-04's Postgres failure-recovery policy application, print-agent install, and TelegramBot diagnosis. Plan 04-05 completed the full 6-service live kill-isolation matrix and found (then closed) a real gap in the Postgres recovery path this section's `sc.exe qfailure` evidence alone did not surface — see "SUP-01 (full)" for the definitive, current status.

**Status: PARTIAL** (as planned — full 6-service kill-isolation matrix continued in Plan 04-05)

**Postgres failure-recovery policy — PASS.** `scripts\configure-postgres-failure-recovery.ps1`
ran against staging's already-installed `postgresql-x64-15` service. `sc.exe qfailure`
confirms:
```
RESET_PERIOD (in seconds)    : 3600
FAILURE_ACTIONS               : RESTART -- Delay = 5000 milliseconds.  (x3)
```

**Diagnostic finding (not a defect in this policy):** taking Postgres down to exercise
SUP-04's failure path required more than `Stop-Service postgresql-x64-15` — Windows SCM
refused (`"Cannot stop service ... because it has dependent services"`, since
Backend/Nginx/Scheduler are all declared SCM dependents of Postgres on this staging install).
Further, staging's SCM-registered PID for `postgresql-x64-15` does not match the actual
listening postmaster PID (`Get-NetTCPConnection -LocalPort 5433` showed a different, separate
`postgres.exe` process actually accepting connections) — killing only the SCM-registered PID
left Postgres still reachable. The real listener had to be identified and terminated directly
to genuinely take the port down for the SUP-04 test. This is a staging service-registration
characteristic worth knowing before anyone bounces Postgres via `Stop-Service`/
`Restart-Service` on this machine — not a defect in `configure-postgres-failure-recovery.ps1`
itself, which was verified to apply and report the correct policy via `sc.exe qfailure`
regardless. Postgres was confirmed running again (via a clean `Start-Service`) before this
task proceeded, and stayed running for the remainder of the validation.

**Print agent install — PASS.** `BilliardBarPrintAgent` installed on staging for the first
time via `install-nssm-print-agent.ps1`. `Get-Service BilliardBarPrintAgent` → `Running`.
Firewall rule for port 9191 added. Reachable via both PowerShell (`check-health.ps1`'s
`[NET-02-http]` row) and, after the NET-02 fix above, via the Python backend itself.

**TelegramBot — documented known issue, deliberately left `Stopped`, no code fix (per explicit
user decision).** Pulled the historical Application Event Log entries first — confirmed the
pre-existing `"The parameter is incorrect."` NSSM crash-loop symptom (`03-VALIDATION.md`'s
original finding) starting well before any Phase 4 work. Then ran `bot.py` directly in the
foreground with the real (non-windowless) `telegram-bot\venv\Scripts\python.exe` and correctly
sourced env vars. The bot started completely cleanly — APScheduler jobs registered, `getMe`/
`deleteWebhook` both returned `HTTP 200` — then failed with a different, real exception:
```
telegram.error.Conflict: Conflict: terminated by other getUpdates request;
make sure that only one bot instance is running
```
No stray `telegram-bot`-venv process exists on staging itself (`Get-Process pythonw`
confirmed no orphaned instance), so another live poller holding the long-poll lock is almost
certainly the **production bar machine's own telegram-bot container** — staging's `.env`
carries the same literal `TELEGRAM_TOKEN` value as production, and Telegram's Bot API permits
only one active `getUpdates` long-poll connection per token. This plausibly also explains the
original "parameter is incorrect" NSSM symptom (an unhandled asyncio `Conflict` exception
during interpreter shutdown under `pythonw.exe`'s windowless hosting surfacing as an opaque
Windows exit code).

Per explicit user decision, this is **recorded as a documented, root-caused known issue, not
fixed in this task** — it is a shared-credential/environment-separation issue between staging
and production, not a bug in `bot.py` or `install-nssm-telegram-bot.ps1`. `BilliardBarTelegramBot`
was left deliberately `Stopped` on staging to avoid repeatedly contending with production's
real bot's polling connection. Resolving this requires a staging-specific Telegram bot token
(or another credential-isolation mechanism) — out of this plan's scope, revisit later.

`Get-Service BilliardBarTelegramBot` final status: `Stopped` (intentional).

## SUP-01 (full, Plan 04-05) — All 6 services individually force-killed, real crash-restart proven

**Status: PASS** (real bug found live, fixed with a Task Scheduler watchdog, and re-verified — see below)

**Methodology correction found live (first cycle):** the naive approach of reading `(Get-CimInstance Win32_Service -Filter "Name='<svc>'").ProcessId` and killing that PID does **not** correctly exercise NSSM's `AppExit Default Restart` for the 5 NSSM-wrapped services — that PID is NSSM's own wrapper process, not the application it supervises. Confirmed by observing `BilliardBarPrintAgent` fail to recover for 35s when its wrapper PID was killed directly (no Windows Recovery is configured for these services; only NSSM's own child-death detection triggers a restart, and killing the wrapper bypasses that entirely). Corrected by using `nssm.exe processes <svc>` to identify each service's actual direct-child PID and re-running every cycle against the correct target.

**Results — 4 NSSM-wrapped services, correct child PID killed:**

| Service | Direct-child PID before | PID after | Recovery time | Other services' PIDs |
|---|---|---|---|---|
| BilliardBarPrintAgent | 17984 | 10096 | 6.6s | Unchanged (confirmed) |
| BilliardBarBackend | 2616 | 21680 | 6.6s | Unchanged (confirmed) |
| BilliardBarScheduler | 18100 | 4568 | 6.6s | Unchanged (confirmed) |
| BilliardBarNginx | 5508 (master) | 22216 | 6.6s | Unchanged (confirmed) |

For every cycle above, all 4 other NSSM services' PIDs were captured before and after and diffed programmatically — all `UNCHANGED`. No service was manually restarted during any cycle; only NSSM's own `AppExit Default Restart` (`AppRestartDelay 5000`) brought each one back, consistently at 6.6s (5s configured delay + ~1.6s process startup).

**PostgreSQL — real gap found, then genuinely fixed:**

`Stop-Process -Force` on the actual postmaster (the real listener on port 5433 — same SCM-registered-PID-vs-real-listener mismatch first documented in Plan 04-04's partial section above, confirmed again here: SCM PID 9844 was `pg_ctl.exe`, the real listener was PID 15816) left `postgresql-x64-15` `Stopped` for 33+ seconds with **no auto-restart**, even after applying `sc.exe failureflag postgresql-x64-15 1` (commit `bd603f22`) in an attempt to fix it. Root cause, confirmed via `sc.exe qfailureflag` and repeated live testing: `pg_ctl.exe runservice` self-reports **exit code 0** when its supervised postmaster dies unexpectedly — a "clean" self-report from pg_ctl's own perspective — and Windows SCM never invokes Recovery actions on a literal `ERROR_SUCCESS` (0) exit, regardless of `FAILURE_ACTIONS_ON_NONCRASH_FAILURES`. No `sc.exe` configuration can close this specific gap.

**User-approved fix:** built and deployed a minimal Task Scheduler watchdog (`scripts/watchdog-postgres.ps1` + `scripts/install-postgres-watchdog-task.ps1`, wired into `install-postgres-native.ps1` Step 8 — commits `d4a394e1`, `df694ce2`). Registered live on staging: `BilliardBarPostgresWatchdog`, triggers `AtStartup` + every 1 minute for 10 years, runs as `SYSTEM`, idempotent (unregister-then-reregister). Logs only when it takes action (never on a healthy check).

**Re-verified live, for real** (this is the definitive SUP-01 evidence for Postgres):
- Killed the real postmaster (PID 7604) at `2026-08-10T01:42:46.75-06:00`, **no manual `Start-Service` performed**.
- `C:\POS\logs\postgres-watchdog.log`:
  ```
  2026-08-10 01:43:33.485 WARNING watchdog-postgres: service 'postgresql-x64-15' was NOT Running (status=Stopped) -- issuing Start-Service.
  2026-08-10 01:43:39.013 INFO watchdog-postgres: Start-Service issued for 'postgresql-x64-15' -- status now Running.
  ```
- Total recovery: **52.8s** (bounded by the watchdog's 1-minute polling interval, not instantaneous like NSSM's 6.6s — an accepted, documented tradeoff of this safety-net approach vs. the sub-10s NSSM path).
- New postmaster PID confirmed listening on port 5433 (7392, distinct from the killed PID); new SCM wrapper PID also distinct (20824), confirming a genuinely fresh service start, not a leftover process.
- All 4 other services' PIDs captured before/after this cycle too — all `UNCHANGED`.
- `check-health.ps1` re-run immediately after: identical clean result to every prior baseline (`status=ok db=connected`, nginx serving SPA, print agent reachable) — the same POS state as before the kill, fully self-healed with zero manual intervention.

**TelegramBot — deliberately excluded from this matrix, per explicit prior user decision (Plan 04-04):** its `TELEGRAM_TOKEN` conflicts with a live production poller; starting it on staging to run a kill cycle would directly contend with the production bar's real bot. Confirmed during the reboot test (SUP-02/SUP-03 below) that its `StartMode` is `Disabled` (not just manually `Stopped`), a deliberate and durable safeguard. This is the one service SUP-01's live matrix does not (and, per that prior decision, should not) cover — documented here plainly rather than silently omitted.

## SUP-02 — Correct dependency-ordered startup at boot

**Status: PASS**

A real `Restart-Computer -Force` was issued on staging (`2026-08-09T23:53:36Z`) — not a simulated stop/start. Startup order reconstructed from `LastBootUpTime` (`2026-08-10T01:31:47` local) plus millisecond-precision NSSM Application-log events and `Get-Process` `StartTime` values (System-log `7036` "service entered running state" events were not emitted for these services on this box — a pre-existing OS logging-verbosity characteristic unrelated to this phase; the NSSM provider's own events supplied full-precision timestamps instead):

| Time (local) | Event |
|---|---|
| 01:32:00.708 | `BilliardBarPrintAgent` received START (no `DependOnService` wiring — starts independently, as designed) |
| ~01:32:00 | Postgres (`postgresql-x64-15`) process start |
| 01:32:01.199 | `BilliardBarBackend` received START control — **after** Postgres |
| 01:32:01.211 | `BilliardBarScheduler` received START control — **after** Postgres |
| 01:32:02.768 | Backend's actual process (`service_entry.py`) started |
| 01:32:02.774 | `BilliardBarNginx` received START control — **after** Backend's process started |
| 01:32:04.304 | Nginx's actual process (`nginx.exe`) started |

This exactly matches the configured `DependOnService` chain (`install-all-native-services.ps1:561-566`: PostgreSQL → Backend/Scheduler/TelegramBot → Nginx). No repeated "received START control" events for any service — a single clean start, no crash-loop during boot. `install-all-native-services.ps1`'s existing wiring is validated as working correctly on a real boot, not re-implemented.

## SUP-03 — All services auto-start after reboot, gated on real responsiveness

**Status: PASS**

Following the same reboot above: all `SERVICE_AUTO_START` services reached `Running` with zero manual intervention (uptime ~150s+ at verification time). `check-health.ps1`, run only once uptime exceeded the required 60s, confirmed real responsiveness (not just process existence): `status=ok db=connected` (SUP-04's DB-backed check), nginx serving the SPA, print agent reachable. This is the same script and the same PASS/FAIL shape used in every other check-health.ps1 capture throughout this plan and Plan 04-04 — a consistent, repeatable "is the POS actually up" signal.

`BilliardBarTelegramBot` correctly did **not** attempt to start at boot (`StartMode: Disabled`, confirmed via `Get-CimInstance Win32_Service`) — this is the deliberate, durable outcome of Plan 04-04's decision to leave it disabled rather than a bug; if it had still been merely `Stopped` (not `Disabled`), Windows would have auto-started it at this reboot and re-triggered the exact production-token contention that decision was meant to avoid.

**Deviation note (DHCP IP change, expected per CLAUDE.md):** staging's IP changed after this reboot (`192.168.1.18` → `.19`), exactly as `CLAUDE.md`'s "Staging machine access" section warns can happen. This did not affect the boot-order evidence above (reconstructed from on-box timestamps, independent of the SSH session) — it only affected when reconnection could be confirmed. The orchestrator/user identified and confirmed the new IP; verification then proceeded normally on `.19`.

## Summary

| Requirement | Status | Key evidence |
|---|---|---|
| NET-02 | PASS | False-positive WARN found live (eventlet `localhost` DNS bug), fixed (commit `cd86b4d9`), re-verified: `INFO app Print agent reachable at http://127.0.0.1:9191` |
| SUP-04 | PASS | Real `SELECT 1` health check: 200/`ok`/`connected` with Postgres up, 503/`error` with it down, back to 200 after restart; `check-health.ps1` confirms; re-confirmed again post-reboot (SUP-03) |
| DATA-02 | PASS | 2 deferred constraint triggers confirmed installed; smoke test found-and-fixed a real live-only bug (commit `a3fe34e4`), re-verified open→201, close→200, twice |
| DATA-03 | PASS | `eventlet.monkey_patch()` + `psycopg2_patcher.make_psycopg_green()` confirmed live and stable across two separate plans' worth of restarts, kills, and a full reboot; the DATA-02 smoke-test bug is exactly the class of live-only regression this requirement exists to catch, and it's now fixed |
| SUP-01 | PASS | All 6 services individually force-killed live. 4 NSSM services: `AppExit Default Restart` confirmed, 6.6s recovery each, other services' PIDs unchanged. Postgres: real gap found (pg_ctl.exe self-reports exit 0, `sc.exe` config alone insufficient), fixed with a Task Scheduler watchdog (commits `bd603f22`, `d4a394e1`, `df694ce2`), re-verified live — 52.8s watchdog-driven recovery, zero manual intervention, other services' PIDs unchanged. TelegramBot deliberately excluded per prior user decision (production-token conflict). |
| SUP-02 | PASS | Real `Restart-Computer -Force`; NSSM event-log timestamps confirm Postgres → Backend/Scheduler → Nginx ordering exactly matches the configured `DependOnService` chain, no crash-loop during boot |
| SUP-03 | PASS | All `SERVICE_AUTO_START` services reached `Running` with zero manual intervention after a real reboot; `check-health.ps1` (run after 60s+ uptime) confirms real DB/HTTP responsiveness, not just process existence; TelegramBot correctly stayed `Disabled` (not re-triggered) |

**Scope confirmation:** All execution across this entire phase (Plans 04-01 through 04-05) happened
on the staging machine (WIDOWSVAIL, `192.168.1.18` → `.19` after the Plan 04-05 reboot's DHCP
reassignment) only. No script was run against, and no service was touched on, the live bar
machine. **D-06 was respected throughout Phase 4** — no automated write or cleanup action ran
against the live bar machine's production database at any point, in this plan or any prior
Phase 4 plan; the only ticket-state changes made anywhere in this phase were the 4 test tickets
Plan 04-04 opened and closed via the normal `/close` API during smoke-test verification (staging
only, not direct DB writes), none left open.

**Follow-up (documented, not blocking):** staging's Postgres SCM-registered PID still does not
match its actual listening postmaster PID (a staging service-registration characteristic, not a
code defect) — the watchdog script correctly works around this by checking `Get-Service` status
rather than depending on a specific PID. The watchdog's ~1-minute detection window (vs. NSSM's
sub-10s `AppExit` path) is an accepted, documented tradeoff — closing it further (e.g.
re-wrapping Postgres under NSSM for true sub-10s parity) is a larger architectural change,
deliberately out of scope for this phase's fix.

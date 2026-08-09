---
phase: 04-process-supervision-reliability-hardening
plan: 04
validated: 2026-08-09
scope: staging (WIDOWSVAIL, 192.168.1.18) only — no bar-machine deployment occurred
---

# Phase 4 Validation (Partial) — Process Supervision & Reliability Hardening

Every file Plans 04-01/04-02/04-03 produced was pushed to the real staging Windows
machine (`C:\Users\giris\billiards-staging`, a file copy per Phase 2/3 precedent — pushed
via `scp`, never `git pull`) and exercised live: `backend/app/__init__.py`, `backend/wsgi.py`,
`backend/service_entry.py`, `scripts/check-health.ps1`,
`scripts/configure-postgres-failure-recovery.ps1`, `scripts/install-postgres-native.ps1`,
plus `scripts/install-nssm-print-agent.ps1`. Live execution surfaced two real, previously
undetected bugs (documented below, both found and fixed during this validation) and one
genuine environment-separation issue (documented, not fixed — see SUP-01 (partial) below).
No placeholder text; every PASS/FAIL/PARTIAL below is backed by real staging command output.

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

## SUP-01 (partial) — Postgres failure-recovery, print-agent install, TelegramBot diagnosis

**Status: PARTIAL** (as planned — full 6-service kill-isolation matrix continues in Plan 04-05)

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

## Summary

| Requirement | Status | Key evidence |
|---|---|---|
| NET-02 | PASS | False-positive WARN found live (eventlet `localhost` DNS bug), fixed (commit `cd86b4d9`), re-verified: `INFO app Print agent reachable at http://127.0.0.1:9191` |
| SUP-04 | PASS | Real `SELECT 1` health check: 200/`ok`/`connected` with Postgres up, 503/`error` with it down, back to 200 after restart; `check-health.ps1` confirms |
| DATA-02 | PASS | 2 deferred constraint triggers confirmed installed; smoke test found-and-fixed a real live-only bug (commit `a3fe34e4`), re-verified open→201, close→200, twice |
| DATA-03 | PASS | `eventlet.monkey_patch()` + `psycopg2_patcher.make_psycopg_green()` confirmed live and stable; the DATA-02 smoke-test bug is exactly the class of live-only regression this requirement exists to catch, and it's now fixed |
| SUP-01 (partial) | PARTIAL | Postgres failure-recovery policy applied and confirmed (`sc.exe qfailure`); print agent installed and Running for the first time; TelegramBot accurately diagnosed (shared-token `Conflict` with production) and documented, left `Stopped` per explicit user decision — full 6-service kill-isolation matrix continues in Plan 04-05 |

**Scope confirmation:** All execution above happened on the staging machine
(`192.168.1.18`, WIDOWSVAIL) only. No script was run against, and no service was touched on,
the live bar machine. D-06 was respected throughout — no automated cleanup ran against any
database anywhere in this phase; the only ticket-state changes made were 4 test tickets this
task itself opened and then closed again via the normal `/close` API (not direct DB writes),
all during smoke-test verification, none left open.

**Deferred to Plan 04-05:** SUP-01 (full 6-service kill-isolation matrix), SUP-02, SUP-03 —
not evaluated in this plan; results here cover only the Postgres failure-recovery policy,
the print-agent install, and the TelegramBot diagnosis, as scoped.

**Follow-up (not blocking, noted for awareness):** staging's Postgres SCM-registered PID does
not match its actual listening postmaster PID, and `Stop-Service postgresql-x64-15` is blocked
by SCM's dependent-service check (Backend/Nginx/Scheduler are all declared dependents) — worth
investigating before Plan 04-05's live crash/reboot tests rely on `Stop-Service`/
`Restart-Service` against Postgres specifically.

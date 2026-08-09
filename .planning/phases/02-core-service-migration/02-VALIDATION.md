# Phase 2 Validation — Core Service Migration

**Date:** 2026-08-08
**Machine:** Staging Windows 11 (`WIDOWSVAIL`, DHCP IP at time of run: `192.168.1.20`) — D-01/D-02: a separate, equivalent-spec test machine (Windows 11, real-world RAM/disk comfortably exceeds the ~8GB bar-machine target). **Not** the live bar machine. No bar-machine deployment occurred (D-03, explicitly deferred to Phase 5's cutover).
**How it was run:** `scripts/install-all-native-services.ps1 -Unattended`, driven remotely over SSH from the planning/execution environment via a Windows Scheduled Task (see "Execution method" note below) — not a human manually double-clicking the installer, though the `.bat` launcher (`scripts/Run-Install-All-Native-Services.bat`) remains available for that path too.
**Postgres service name (discovered, not hardcoded):** `postgresql-x64-15`
**Postgres port (chosen, not the standard 5432):** `5433` — this staging machine already had an unrelated PostgreSQL 17 installation on port 5432; installing on 5433 avoided touching it (see `scripts/.postgres-port.txt`).
**nginx port (frontend):** `8080` (unchanged from plan).

## Execution method note

The plan's own checkpoint assumed a human would run the installer interactively. In practice this was driven remotely over SSH. Plain SSH exec runs in Windows Session 0 (non-interactive), which broke installer bootstraps that need a real window station even in silent mode (PostgreSQL's EDB installer, Node's MSI via Chocolatey) — confirmed on this exact machine. The workaround: a Windows Scheduled Task configured to run in the already-logged-on interactive session (`giris`, Session 1), triggered remotely via `schtasks`/`Start-ScheduledTask` over the same SSH connection. This kept the whole run automated with no physical/manual action at the console, while giving installers the interactive session they need. This is now documented in `CLAUDE.md`'s "Staging machine access" section for future runs.

Several real bugs were found and fixed only by testing against this real hardware (not caught by static review or the macOS dev environment, which cannot run PowerShell/NSSM at all): a Postgres port conflict with the pre-existing instance, a UTF-8 BOM requirement for Windows PowerShell 5.1 to reliably parse these scripts, a `Write-Host` output-capture bug under `Start-Process` OS-level redirection, a stale-superuser-password idempotency bug across retries, an `$ErrorActionPreference` misconfiguration that turned Docker's normal stderr progress output into fatal errors, a null-reference crash in the seed-detection polling loop, a `Process.ExitCode` synchronization race that misreported successful runs as failures, npm's `--prefix` not resolving `package.json` location the way the script assumed, and a missing `events{}`/`http{}` wrapper in `nginx-windows.conf` (the Docker version is a fragment included by a base image's own wrapper; the native version is the *entire* standalone `nginx.conf` and needs the full structure). All fixes are committed to `scripts/*.ps1` and `scripts/nginx-windows.conf` on this branch.

## Requirement-by-requirement results

### SVC-01 — Flask/eventlet backend runs as a native Windows Service
**PASS.** `Get-Service BilliardBarBackend` → `Running`. HTTP check: `Invoke-RestMethod http://localhost:5000/api/v1/auth/me` returns a JSON auth-error body (`Missing Authorization Header`) — a real HTTP response from the running server, which is the defined pass condition (a 401 on an auth-required endpoint confirms the server is up, not that a call succeeded unauthenticated).

### SVC-02 — PostgreSQL 15 runs as a native Windows service
**PASS.** `Get-Service postgresql-x64-15` → `Running`, installed via Chocolatey on port 5433 (see port-conflict note above). App-level connectivity independently verified: `psql -U billiard -d billiardbar -p 5433 -c "SELECT 1"` succeeds (this is also how the orchestrator's own idempotency pre-check confirms the database is genuinely usable, not just that the Windows service exists).

### SVC-03 — React frontend served via lightweight web server/reverse proxy
**PASS.** `Get-Service BilliardBarNginx` → `Running`, serving the built SPA on port 8080. HTTP check: `Invoke-WebRequest http://localhost:8080/` response body contains `<div id="root">`. `/api/` and `/socket.io/` reverse-proxy to `http://localhost:5000` per `scripts/nginx-windows.conf`.

### SVC-04 — Scheduler runs as its own independent native Windows service
**PASS.** `Get-Service BilliardBarScheduler` → `Running`, in its own `backend\scheduler_venv` virtualenv (D-07). Crash-isolation proof (see below) confirms it survives a backend stop.

### SVC-05 — Telegram bot runs as its own independent native Windows service
**PASS.** `Get-Service BilliardBarTelegramBot` → `Running`, in its own `telegram-bot\venv` virtualenv (D-07), connected using real `TELEGRAM_TOKEN`/`ADMIN_CHAT_ID` values added to `.env` partway through this validation run. (Earlier in the same session, before those credentials were added, the bot correctly and clearly reported a crash-loop due to missing credentials — expected, documented behavior, not a defect; the orchestrator was made non-blocking on this specific failure mode so a missing bot token never prevents validating the rest of the stack.) Crash-isolation proof confirms it survives a backend stop.

### NET-01 — Backend reaches the print agent via localhost, no `host.docker.internal`
**PARTIAL / config-only.** `PRINT_AGENT_URL` defaults to `http://localhost:9191` (verified in `scripts/install-nssm-backend.ps1`'s environment block: grep for `host.docker.internal` in `backend/app/api/tickets.py`/`queue.py` returns zero matches — Plan 02-01's own fix, re-confirmed here). The staging machine has no physical print agent running, so `Invoke-RestMethod http://localhost:9191/health` correctly fails with "Unable to connect to the remote server" — this is a networking/config-level check only, not a physical print smoke test, which requires the live bar machine (D-03) and is explicitly out of scope for Phase 2.

### DATA-01 — Verified Postgres backup exists and is restore-tested before migration
**PASS (procedure only, per D-10).** The Docker-to-native dump/restore procedure (`scripts/postgres-backup-restore.ps1`, `Test-PostgresBackupRestoreProcedure`) ran end-to-end against synthetic `backend/seed.py` data on the staging machine: a throwaway `docker compose` postgres+backend stack was spun up, seeded, `pg_dump`'d, the dump copied out, the throwaway stack torn down completely (`docker compose down -v`), and the dump `pg_restore`'d into the native Postgres 15 instance. Final row-count verification: `users == 6` (PASS), `menu_items >= 17` (PASS — 17 on first run, 51 after a later re-run accumulated data across restores, which is expected since restores are additive against a persistent target), `resources > 0` (PASS — 19). **Per D-10, this explicitly validates the *procedure* only** — verification against real production data is deferred to Phase 5's cutover; this is not a substitute for that step.

## Crash-isolation proof (this phase's own explicit success criterion)

`nssm stop BilliardBarBackend`, wait 3s, then check scheduler/bot:
- `Get-Service BilliardBarScheduler` → still `Running` — **PASS**
- `Get-Service BilliardBarTelegramBot` → still `Running` — **PASS**
- `nssm start BilliardBarBackend`, wait 3s, `Get-Service BilliardBarBackend` → `Running` again — **PASS** (normal state restored)

This directly proves the phase's own claim: stopping the backend does not take down the scheduler or Telegram bot, unlike today's Docker all-or-nothing blast radius.

## NSSM service dependency wiring

`nssm set BilliardBarBackend DependOnService postgresql-x64-15`, same for `BilliardBarScheduler`/`BilliardBarTelegramBot`, and `nssm set BilliardBarNginx DependOnService BilliardBarBackend` — wired using the dynamically-discovered Postgres service name, never a hardcoded `postgresql-x64-15` literal in the orchestration logic itself (the literal appears only in this evidence document and in log/state files, not in any conditional service-selection logic). All services were restarted in dependency order after wiring so the settings took effect immediately rather than only on next reboot.

## Scope confirmation

Every step above ran on the staging machine only (D-01/D-02). No bar-machine deployment occurred (D-03) — that is Phase 5's cutover, a separate, deliberate step.

# Phase 3: Centralized Logging & Secrets - Context

**Gathered:** 2026-08-09
**Status:** Ready for planning

<domain>
## Phase Boundary

An operator can observe all service activity (backend, scheduler, telegram-bot, print agent, nginx) from one place, and secrets no longer live in `docker-compose.yml`, install scripts, or any committed file. Builds directly on Phase 2's native Windows Services (NSSM-wrapped backend/scheduler/bot/nginx + print agent), which are already installed and validated on the staging machine. Covers LOG-01, LOG-02, LOG-03, SEC-01, SEC-02. Does not touch process supervision/health-checks (Phase 4) or the live bar machine cutover (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Log consolidation
- **D-01:** Single shared log directory is `C:\POS\logs\` — a new top-level folder sitting alongside the existing per-service install dirs Phase 2 created (BackendDir, BotDir, NginxDir, print-agent dir), not buried inside any one of them.
- **D-02:** nginx's own `access.log`/`error.log` (separate from the NSSM service-wrapper stdout/stderr) also move into `C:\POS\logs\` — add explicit `access_log`/`error_log` directives to `frontend/nginx.conf` pointing at the shared directory, so ALL nginx output is consolidated, not just the NSSM wrapper log.
- **D-03:** Phase 2's install scripts (`scripts/install-nssm-*.ps1`) are NOT edited. Instead, a new Phase 3 script reconfigures already-installed NSSM services in place (`nssm set <service> AppStdout/AppStderr <new path under C:\POS\logs\>`) to redirect existing, staging-validated services without touching the shipped install scripts.
- **Note (log rotation, LOG-02):** Size-based rotation is already configured per-service via NSSM's `AppRotateFiles`/`AppRotateBytes` in each Phase 2 install script (10MB for backend/scheduler/bot, 1MB for print agent, 10MB for nginx's wrapper log). This is NOT being re-decided — the new consolidation script must preserve these existing `AppRotateFiles`/`AppRotateBytes` settings when it repoints the log paths. Only nginx's *native* access/error logs (new in D-02) need their own rotation approach designed, since nginx has no built-in log rotation on Windows (no logrotate).

### Log viewing (LOG-03)
- **D-04:** Build a small PowerShell tail-all script (e.g. `scripts/tail-logs.ps1`) that watches every file in `C:\POS\logs\` live (`Get-Content -Wait`-style), merging output with a service-name prefix so an operator can watch everything in one window.
- **D-05:** The script supports an optional `-Service <name>` filter to narrow to a single service's log; running with no arguments merges all services. This matters for debugging one specific service without noise from the others.

### Secrets storage mechanism (SEC-01)
- **D-06:** Secrets move to Windows Credential Manager / DPAPI, not a hardened version of Phase 2's plaintext `.env` + Read-DotEnv pattern. The security gain is that secrets no longer sit in a long-lived plaintext file; NSSM's `AppEnvironmentExtra` will still receive plaintext values at service-configuration time (this is an accepted limitation — read into memory at config time, not persisted as plaintext at rest).
- **D-07:** Scope of "secrets" for SEC-01 is **all** secret-like values found in `docker-compose.yml`/`backend/app/config.py`, not just the three literally named in REQUIREMENTS.md — includes `POSTGRES_PASSWORD`, `SECRET_KEY`, `JWT_REFRESH_SECRET`, all role passwords/PINs (`ADMIN_PASSWORD`/`ADMIN_PIN`, `MANAGER_PASSWORD`/`MANAGER_PIN`, `WAITER1_PASSWORD`, `WAITER2_PASSWORD`, `KITCHEN_PASSWORD`, `BARSTAFF_PASSWORD`), plus `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`, and any Telegram bot token. Fixing SEC-01 for only the three named categories while leaving SMTP/Telegram credentials in the same insecure state would be an inconsistent half-fix.
- **D-08:** Non-secret config (`BILLING_MODE`, `POOL_RATE_CENTS`, `HAPPY_HOUR_*`, `PRINT_AGENT_URL`, `TZ`, `CURRENCY`, etc.) stays in the existing `.env` / Read-DotEnv pattern from Phase 2 — only true secrets move to Credential Manager. Keeps the blast radius small and routine config easy to inspect/edit without needing Credential Manager tooling.
- **D-09:** Secrets are populated into Credential Manager via a **one-time migration script** that reads the current git-ignored `.env` (already populated on staging from Phase 2 testing) and writes each value into Credential Manager/DPAPI, after which the `.env`-sourced secret values should no longer be relied upon. Flag for planner: real secrets used on the actual bar machine (Phase 5 cutover) must be freshly generated/rotated, not carried over verbatim from staging's test values — this migration script proves the *mechanism*, same precedent as Phase 2's D-09/D-10 staging-vs-production data split.
- **D-10 (SEC-02):** `.env.example` must be created (none exists today) documenting every required *non-secret* env var with placeholder values, plus a pointer/comment noting which values are now sourced from Credential Manager instead of `.env`.

### Fail-fast vs warn on bad secrets
- **D-11:** Services **warn loudly and keep running** if a secret is detected at its known-default value (`billiard_secret`, `dev-secret-key-change-in-production`, `admin123`, `manager123`, etc.) — they do NOT refuse to start. This is a live bar; a hard runtime failure risks blocking POS operation until someone with machine access intervenes. The warning must be highly visible (console + the new consolidated log file) so it's caught in log review, not silently swallowed.
- **D-12:** The default-value validation check lives in the backend app factory (`backend/app/config.py` / `backend/app/__init__.py`, where `SECRET_KEY`/`JWT_REFRESH_SECRET_KEY`/`POSTGRES_PASSWORD` are already read) — one place, runs for every entrypoint that calls `create_app()`. This is check *placement*, not a change to D-11's warn-only behavior — the check still only warns, it does not gate startup.

### Claude's Discretion
- Exact PowerShell implementation of the log-path reconfiguration script (D-03) — whether it stops/reconfigures/restarts each NSSM service in one pass or requires the operator to re-run per service.
- Exact format/coloring scheme for `tail-logs.ps1`'s merged output (D-04).
- Exact DPAPI/Credential Manager cmdlet approach (`cmdkey` vs `System.Security.Cryptography.ProtectedData` vs a PowerShell module) for reading/writing secrets (D-06/D-09) — pick whichever is most reliably scriptable non-interactively over SSH on the staging machine, consistent with how Phase 2's installers were driven non-interactively.
- Nginx native log rotation approach (D-02's follow-on) — e.g. a scheduled task running a simple rotate/prune script, since Windows has no logrotate equivalent.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 2 outputs this phase builds on
- `.planning/phases/02-core-service-migration/02-CONTEXT.md` — D-04 (NSSM), D-05 (wsgi.py entrypoint), D-07 (per-service venvs) that Phase 3's log/secrets changes must remain compatible with
- `scripts/install-nssm-backend.ps1`, `scripts/install-nssm-scheduler.ps1`, `scripts/install-nssm-telegram-bot.ps1`, `scripts/install-nssm-nginx.ps1`, `scripts/install-nssm-print-agent.ps1` — existing, staging-validated NSSM install scripts with current per-service log paths (`AppStdout`/`AppStderr`) and rotation settings (`AppRotateFiles`/`AppRotateBytes`) that D-01/D-03 consolidate without editing
- `scripts/install-all-native-services.ps1` — orchestrates all Phase 2 installers; may need to sequence the new Phase 3 log-consolidation and secrets-migration scripts after it
- `scripts/install-postgres-native.ps1`, `scripts/postgres-backup-restore.ps1` — also contain the `billiard_secret` fallback default pattern in scope for SEC-01 (D-07)

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — LOG-01, LOG-02, LOG-03, SEC-01, SEC-02 definitions
- `.planning/ROADMAP.md` §"Phase 3: Centralized Logging & Secrets" — goal and success criteria

### Known security gaps this phase addresses
- `.planning/codebase/CONCERNS.md` §"Insecure default credentials baked into `docker-compose.yml`" — the exact list of default secrets (`SECRET_KEY=dev-secret-key-change-in-production`, `JWT_REFRESH_SECRET=dev-refresh-secret-change-in-production`, `POSTGRES_PASSWORD=billiard_secret`, all role passwords/PINs) and its recommendation (fail/warn on default-value detection) that directly informs D-11/D-12
- `docker-compose.yml:30-49` — source of truth for every secret's current insecure default value

### Existing logging/config code
- `backend/app/__init__.py:18-21` — existing `logging.basicConfig` call (already timestamped: `'%(asctime)s %(levelname)s %(name)s %(message)s'`) that D-12's validation check will sit near
- `backend/app/config.py:5,12-13` — where `SECRET_KEY`/`JWT_SECRET_KEY`/`JWT_REFRESH_SECRET_KEY` are read with insecure fallback defaults, the concrete site for D-12's check
- `frontend/nginx.conf` — currently has no explicit `access_log`/`error_log` directives (uses nginx defaults); D-02 requires adding them
- `.planning/codebase/STACK.md` §"Configuration" — full env var inventory (DB, auth, billing, SMTP, role passwords/PINs, print agent) needed to scope D-07/D-08's secret-vs-non-secret split

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/install-nssm-print-agent.ps1`'s `Read-DotEnv` helper — the existing pattern for reading the git-ignored `.env`; the one-time migration script (D-09) can reuse this same parsing logic to read `.env` once before writing values into Credential Manager
- NSSM's `AppRotateFiles`/`AppRotateBytes` mechanism already proven working per-service in Phase 2 — the log-consolidation script (D-03) only needs to change `AppStdout`/`AppStderr` paths, not reimplement rotation

### Established Patterns
- Every Phase 2 install script never hardcodes real secret values — it reads them from `.env` at install time and forwards into NSSM's `AppEnvironmentExtra` (documented explicitly in `install-nssm-backend.ps1`'s header comment). Phase 3's Credential Manager migration replaces the *source* of those values (Credential Manager instead of `.env`) without changing this forwarding mechanism.
- Backend logging already uses Python's `logging` module with a timestamped format — no new logging framework needed, just redirecting where stdout/stderr land.

### Integration Points
- `backend/app/config.py`'s `Config` class is the single place all secret env vars are read with `os.environ.get(..., default)` — this is where D-12's default-value warning check attaches for every secret in scope (D-07), not just the three named in REQUIREMENTS.md
- Each `install-nssm-*.ps1` script's `AppEnvironmentExtra` block is the integration point where Credential-Manager-sourced values must still land as plain env vars for the running process (D-06's accepted limitation)

</code_context>

<specifics>
## Specific Ideas

No UI/format requirements (infrastructure phase). The clearest steer from discussion: reuse Phase 2's proven pieces (NSSM rotation settings, Read-DotEnv parsing) rather than reinventing them — this phase relocates *where* logs land and *where* secrets are sourced from, without redesigning the mechanisms Phase 2 already validated on staging.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 3-Centralized Logging & Secrets*
*Context gathered: 2026-08-09*

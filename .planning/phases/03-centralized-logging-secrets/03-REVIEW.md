---
phase: 03-centralized-logging-secrets
reviewed: 2026-08-09T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - .env.example
  - backend/app/__init__.py
  - frontend/nginx.conf
  - scripts/migrate-secrets-to-dpapi.ps1
  - scripts/nginx-windows.conf
  - scripts/reconfigure-log-paths.ps1
  - scripts/reconfigure-secrets.ps1
  - scripts/rotate-nginx-logs.ps1
  - scripts/tail-logs.ps1
findings:
  critical: 2
  warning: 6
  info: 3
  total: 11
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-08-09
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Reviewed the 9 files that implement Phase 3 (centralized logging + DPAPI-backed secrets
migration) for the Rust/Windows-native migration effort. Two real bugs in
`reconfigure-log-paths.ps1` / `reconfigure-secrets.ps1` were already found and documented
during live staging validation (see `03-VALIDATION.md`) and are **not** repeated here per the
task's known-context instructions.

Beyond those two, this pass found a deterministic reliability bug in how
`reconfigure-secrets.ps1` builds `DATABASE_URL` (unescaped password), a control-flow bug in
`reconfigure-log-paths.ps1` that can abandon mid-reconfiguration and leave a live service
stopped, and several secondary robustness/quality gaps: PowerShell-to-nssm argument quoting
risk for secret values, a verification step that only checks for a substring instead of
confirming secrets were actually applied, an ACL restriction (`icacls /grant:r` without `/T`)
that does not retroactively strip pre-existing explicit ACEs on re-runs, and the fact that
DPAPI `LocalMachine` scope is decryptable by *any* local user (not just administrators),
meaning the ACL on `C:\POS\secrets\` is the sole confidentiality boundary — worth calling out
explicitly since the in-code comments describe it as an admin-only guarantee. A handful of
dead/inconsistent configuration values round out the Info findings.

## Critical Issues

### CR-01: DATABASE_URL built from an un-encoded password — breaks for any password with URL-reserved characters

**File:** `scripts/reconfigure-secrets.ps1:154-161`
**Issue:** `$PgPassword` is decrypted from DPAPI and interpolated directly into a
`postgresql://user:password@host:port/db` connection string with no URL-encoding:

```powershell
$DatabaseUrl = "DATABASE_URL=postgresql://${PgUser}:${PgPassword}@localhost:${PgPort}/${PgDb}"
```

Any password containing a URL-reserved character (`@`, `:`, `/`, `#`, `?`, `%`, `[`, `]`, etc.)
will corrupt the resulting URI — e.g. a password containing `@` gets parsed by SQLAlchemy/psycopg
as ending the credentials segment early, producing a bogus host/user, so the backend, scheduler,
and telegram-bot services will all fail to connect to Postgres (or connect with the wrong
credentials) after this script runs. This is deterministic, not a corner case: `.env.example`
doesn't constrain `POSTGRES_PASSWORD` to be alphanumeric, and operators commonly paste
strong, generator-produced passwords that include special characters. This one password
feeds `DatabaseUrl` for *all three* secret-consuming services, so a single bad character
takes down the whole POS backend simultaneously.
**Fix:** URL-encode the password (and, defensively, the user/db) before building the URI:
```powershell
Add-Type -AssemblyName System.Web
$EncodedPassword = [System.Web.HttpUtility]::UrlEncode($PgPassword)
$DatabaseUrl = "DATABASE_URL=postgresql://${PgUser}:${EncodedPassword}@localhost:${PgPort}/${PgDb}"
```

### CR-02: reconfigure-log-paths.ps1 aborts mid-run on verification failure, leaving the just-stopped service down and skipping every remaining service

**File:** `scripts/reconfigure-log-paths.ps1:110-134`
**Issue:** Inside the per-service loop, after stopping the service and applying the new
`AppStdout`/`AppStderr`/rotation settings, the script verifies `AppStdout` and, on mismatch,
calls `exit 1` immediately — **before** ever calling `Start-Service`/`nssm start` for that
service, and before the `foreach` loop reaches any of the remaining services in `$services`:

```powershell
$verifyStdout = & $NssmExe get $serviceName AppStdout
if ($verifyStdout -ne $stdoutPath) {
    Write-Host "    ERROR: AppStdout verification failed! ..." -ForegroundColor Red
    exit 1
}
Write-Host "    Starting service..." -ForegroundColor Yellow
& $NssmExe start $serviceName 2>&1 | Out-Null
```

If verification fails for any reason (a transient `nssm set` hiccup, an already-open file
handle, etc.) on, say, `BilliardBarBackend` (the first entry in `$services`), the script exits
with the backend **stopped** and never even attempts `BilliardBarScheduler`,
`BilliardBarTelegramBot`, `BilliardBarPrintAgent`, or `BilliardBarNginx` — leaving the live POS
down and the remaining services unreconfigured, with only a console message (easy to miss when
run non-interactively/over SSH) indicating why.
**Fix:** On verification failure, attempt to restart the service before returning (so at worst
you're back to the pre-script state) and `continue` to the next service instead of a hard
`exit 1`; track failures in a summary array and report/exit non-zero only after the loop
completes:
```powershell
if ($verifyStdout -ne $stdoutPath) {
    Write-Host "    ERROR: AppStdout verification failed for $serviceName -- restarting with prior config and continuing." -ForegroundColor Red
    & $NssmExe start $serviceName 2>&1 | Out-Null
    $failed += $serviceName
    continue
}
```

## Warnings

### WR-01: Secret values passed to nssm.exe as unescaped PowerShell native-command arguments

**File:** `scripts/reconfigure-secrets.ps1:192-221, 265-276, 312-316`
**Issue:** Each `AppEnvironmentExtra` value (`"SECRET_KEY=$(...)"`, `"ADMIN_PASSWORD=$(...)"`,
`"SMTP_PASSWORD=$(...)"`, `"TELEGRAM_TOKEN=$(...)"`, etc.) is built by naive string
interpolation and passed as an array element to `& $NssmExe set $svcName AppEnvironmentExtra
$envArgs`. Windows PowerShell 5.1's native-command argument marshalling has well-known gaps
around embedded double-quote characters and trailing backslashes when constructing the
underlying Win32 command line for the child process. A secret containing a `"`  (plausible for
an ops-chosen strong password or an SMTP app password) can misalign argument boundaries,
silently truncating or merging adjacent `KEY=VALUE` entries in `AppEnvironmentExtra` — with no
error surfaced (see WR-02, the verification step wouldn't catch this either).
**Fix:** Validate/reject secret values containing characters that are unsafe for native-command
argument passing before use, or pass values through a mechanism NSSM supports for
whitespace/quote-safe input (e.g. a single `AppEnvironmentExtra` blob written via `nssm set
... =` with explicit escaping, or writing `AppEnvironmentExtra` via the registry directly with
`Set-ItemProperty` instead of `nssm set`).

### WR-02: AppEnvironmentExtra verification only checks for the `DATABASE_URL=` substring, not that any actual secret was applied

**File:** `scripts/reconfigure-secrets.ps1:229-234, 284-289, 324-329`
**Issue:** For all three services, verification is:
```powershell
$verify = & $NssmExe get $svcName AppEnvironmentExtra
if ($verify -match 'DATABASE_URL=') {
    Write-Host "       Verified: AppEnvironmentExtra contains DATABASE_URL marker." -ForegroundColor Green
} else {
    Write-Host "       WARNING: AppEnvironmentExtra verification did not find DATABASE_URL marker." -ForegroundColor Yellow
}
```
This never checks that `SECRET_KEY`, `ADMIN_PASSWORD`, `SMTP_PASSWORD`, `TELEGRAM_TOKEN`, etc.
were actually present/correct in the applied value — it only checks the one non-secret,
always-first marker. Combined with WR-01, a quoting failure that corrupts everything *after*
`DATABASE_URL` in the arg list would still print "Verified" and the script would report the
service as successfully `$reconfigured`, giving false confidence.
**Fix:** After `nssm get $svcName AppEnvironmentExtra`, assert the presence of each expected
`KEY=` prefix (not values) for that service, e.g. loop over `$secretKeys + @('DATABASE_URL')`
and confirm each is represented before declaring success.

### WR-03: PRINT_AGENT_URL hardcoded instead of read from `.env` like every other non-secret value

**File:** `scripts/reconfigure-secrets.ps1:217`
**Issue:** Every other non-secret value (`BILLING_MODE`, `TZ`, `REPORT_FROM`, etc.) is read
via `Read-DotEnv` with a documented fallback default. `PRINT_AGENT_URL` instead is hardcoded
literally: `"PRINT_AGENT_URL=http://localhost:9191"`. If an operator sets a different
`PRINT_AGENT_URL` in `.env` (e.g. the print agent bound to a non-default port, or running on a
different host), this script silently discards that override on every reconfiguration.
**Fix:** Read it the same way as the other non-secret values:
```powershell
$PrintAgentUrl = if ($DotEnv.ContainsKey('PRINT_AGENT_URL') -and $DotEnv['PRINT_AGENT_URL']) { $DotEnv['PRINT_AGENT_URL'] } else { 'http://localhost:9191' }
...
"PRINT_AGENT_URL=$PrintAgentUrl",
```

### WR-04: tail-logs.ps1 goes silently stale after rotate-nginx-logs.ps1 renames a watched file

**File:** `scripts/tail-logs.ps1:63-68`
**Issue:** Each background job runs `Get-Content -Path $Path -Wait -Tail 0`, opened once
against a specific file path at job-start time. `rotate-nginx-logs.ps1` (registered to run
daily at 02:00) renames the live `nginx_access.log`/`nginx_error.log` via `Move-Item` and
restarts `BilliardBarNginx` so it reopens fresh files at the original path. A `tail-logs.ps1`
session that was already running across that rotation continues watching the now-archived,
no-longer-written-to file handle; nginx's newly created post-restart file at the original path
is never picked up by the existing job. The operator gets no error — nginx log lines simply
stop appearing in the merged tail with no indication why.
**Fix:** Either document that `tail-logs.ps1` should be restarted after a rotation, or detect
rotation (e.g. periodically compare `Get-Item $Path` identity/creation time and restart the
job if the file was recreated).

### WR-05: `icacls /grant:r` (no `/T`) does not retroactively strip pre-existing explicit ACEs on re-run

**File:** `scripts/migrate-secrets-to-dpapi.ps1:103`, `scripts/reconfigure-log-paths.ps1:44`
**Issue:** Both scripts restrict their target directory with:
```powershell
icacls $SecretsDir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
```
`/inheritance:r` strips *inherited* ACEs and `/grant:r` replaces the named principals' grants,
but neither removes pre-existing **explicit** ACEs for principals other than
Administrators/SYSTEM, and without `/T` this call only touches the directory object itself —
not any files already inside it. On a genuinely first-ever run (directory doesn't exist yet)
this is safe, since `New-Item` creates it with only inherited ACEs, which `/inheritance:r`
then strips. But on a re-run against a directory that was previously created/touched with a
looser explicit grant (e.g. manual troubleshooting, a restore from backup that didn't preserve
ACLs, or a partial run from an earlier version of these scripts), those broader explicit
grants — and any pre-existing files' own ACLs — silently persist, undermining the
"Administrators/SYSTEM only" guarantee the surrounding comments assert. This matters most for
`C:\POS\secrets\`, which holds DPAPI-encrypted copies of every production credential.
**Fix:** Add `/T /C` to recurse into existing children, and/or explicitly `/remove:g` any
unexpected principals, then re-verify with `icacls $SecretsDir` that only
Administrators/SYSTEM/owner are present before proceeding.

### WR-06: DPAPI `LocalMachine` scope is decryptable by any local user, not just administrators — the ACL is the *only* real access boundary

**File:** `scripts/migrate-secrets-to-dpapi.ps1:73-90`, `scripts/reconfigure-secrets.ps1:77-105`
**Issue:** `Protect-Secret`/`Unprotect-Secret` deliberately use
`DataProtectionScope.LocalMachine` (not `CurrentUser`), and the comment at
`migrate-secrets-to-dpapi.ps1:74-78` frames this as letting "ANY local administrator ... run
reconfigure-secrets.ps1 successfully." That's true, but it understates the actual security
model: `LocalMachine`-scoped DPAPI protection is tied to the *machine's* master key, not to any
particular user's credentials, so **any locally-authenticated user account** on that machine —
administrator or not — can call `[ProtectedData]::Unprotect(..., LocalMachine)` and decrypt the
ciphertext, provided they can read the `.dat` file. The entire confidentiality boundary is
therefore the `icacls` restriction on `C:\POS\secrets\` (see WR-05) — DPAPI itself contributes
no additional access control beyond "this specific machine." If that ACL is ever loosened
(accidentally, via a backup/restore that resets permissions, or a future script change), every
production secret (DB password, JWT signing keys, all role passwords/PINs, SMTP credentials,
Telegram bot token) becomes decryptable by any local, unprivileged account with a few lines of
PowerShell — no admin rights required.
**Fix:** No code change strictly required (this is an inherent DPAPI trade-off, and
`CurrentUser` scope has its own documented cross-account decryption problem per
`03-RESEARCH.md` Pitfall 2), but the comments should be corrected to not imply DPAPI itself
enforces "administrators only," and the ACL-as-sole-boundary risk should be called out
explicitly in `03-CONTEXT.md`/operator docs so it isn't rediscovered as a surprise later.

## Info

### IN-01: Dead decoy default-secret values in `_check_default_secrets`

**File:** `backend/app/__init__.py:1049, 1053`
**Issue:** The detector checks `secret_key in ('dev-secret-change-me',
'dev-secret-key-change-in-production')` and `jwt_refresh_secret in ('dev-refresh-secret',
'dev-refresh-secret-change-in-production')`. Only the first value in each tuple actually
matches `backend/app/config.py`'s real fallback defaults (`'dev-secret-change-me'` and
`'dev-refresh-secret'` respectively, confirmed at `config.py:5,13`); the second value in each
tuple never occurs anywhere in the codebase and can never match.
**Fix:** Either remove the dead alternates, or if they're meant to guard against some other
historical default, note where that default comes from in a comment.

### IN-02: `.env.example`'s documented `CURRENCY=MXN` default disagrees with the code fallback default (`USD`)

**File:** `.env.example:35`; `backend/app/config.py:24`
**Issue:** `.env.example` documents `CURRENCY=MXN` as the value to ship, matching business
reality (per `CLAUDE.md`: "Currency is MXN"), but `Config.CURRENCY = os.environ.get('CURRENCY',
'USD')` falls back to `'USD'` if the key is ever absent from a real `.env`. Harmless as long as
`.env.example` is copied verbatim (it explicitly sets the key), but a latent trap if `CURRENCY`
is ever dropped from a deployment's `.env` — the app would silently default to the wrong
currency rather than failing loudly.
**Fix:** Either change the code fallback to `'MXN'` to match documented reality, or add a
comment in `.env.example` flagging that omitting this key silently reverts to USD.

### IN-03: `FLASK_ENV` documented and wired through but never read by the backend

**File:** `.env.example:42`; `scripts/reconfigure-secrets.ps1:216`
**Issue:** `.env.example` documents `FLASK_ENV=production` and `reconfigure-secrets.ps1`
faithfully forwards it into `BilliardBarBackend`'s `AppEnvironmentExtra`
(`"FLASK_ENV=$FlaskEnv"`), but nothing in `backend/` actually reads `FLASK_ENV` (confirmed via
repo-wide search — Flask 2.3+ dropped `FLASK_ENV` support in favor of `FLASK_DEBUG`/explicit
config). This is dead configuration that could mislead an operator into believing it toggles
debug/production behavior.
**Fix:** Remove `FLASK_ENV` from both files, or, if a production/debug toggle is actually
desired, wire it into `config.py` (e.g. `DEBUG = os.environ.get('FLASK_ENV') != 'production'`).

---

_Reviewed: 2026-08-09_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

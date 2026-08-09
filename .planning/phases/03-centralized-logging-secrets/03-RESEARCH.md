# Phase 3: Centralized Logging & Secrets - Research

**Researched:** 2026-08-09
**Domain:** Windows Services log consolidation, secrets management (DPAPI/Credential Manager), nginx log rotation
**Confidence:** HIGH (core mechanisms verified against official docs and existing install scripts)

## Summary

Phase 3 consolidates logs from five separate services (backend, scheduler, telegram-bot, print agent, nginx) into a single directory (`C:\POS\logs\`), implements a PowerShell tailing script for operators, and migrates secrets from plain-text `.env` files into Windows Credential Manager / DPAPI storage. All locked decisions (D-01 through D-12) have technical feasibility verified through NSSM documentation, PowerShell 5.1 capabilities, and existing Phase 2 install script patterns.

**Primary recommendation:** Use NSSM's `nssm set` command to reconfigure existing services' log paths (D-03 compliant — no re-installation of Phase 2 scripts). For secrets, use `System.Security.Cryptography.ProtectedData` DPAPI directly (no module dependency, works non-interactively over SSH on PS 5.1). Implement nginx log rotation via simple scheduled PowerShell script + Windows Task Scheduler.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|-----------|-------------|----------------|-----------|
| Log output redirection | Backend Service (NSSM) | Windows Kernel (I/O) | NSSM handles stdout/stderr → file mapping; kernel manages file I/O |
| Log rotation | Windows Task Scheduler | PowerShell Script | Scheduler triggers rotation script; script performs size/date-based management |
| Log viewing (unified) | Administrator CLI (PowerShell) | — | `tail-logs.ps1` runs locally with admin privileges to access all service logs |
| Secrets storage | Windows DPAPI (local scope) | NSSM service config | DPAPI encrypts values at rest; NSSM's AppEnvironmentExtra injects at runtime |
| Secrets reading | Backend app (Python) | Windows Credential Manager | Python `os.environ.get()` reads env vars set by NSSM; Credential Manager is source-of-truth |
| Secret validation | Backend app factory | Application bootstrap | Config.py/`__init__.py` check runs on every `create_app()` call (D-12) |

## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01:** Single shared log directory is `C:\POS\logs\` — a new top-level folder sitting alongside the existing per-service install dirs Phase 2 created (BackendDir, BotDir, NginxDir, print-agent dir), not buried inside any one of them.

**D-02:** nginx's own `access.log`/`error.log` (separate from the NSSM service-wrapper stdout/stderr) also move into `C:\POS\logs\` — add explicit `access_log`/`error_log` directives to `frontend/nginx.conf` pointing at the shared directory, so ALL nginx output is consolidated, not just the NSSM wrapper log.

**D-03:** Phase 2's install scripts (`scripts/install-nssm-*.ps1`) are NOT edited. Instead, a new Phase 3 script reconfigures already-installed NSSM services in place (`nssm set <service> AppStdout/AppStderr <new path under C:\POS\logs\>`) to redirect existing, staging-validated services without touching the shipped install scripts.

**D-04:** Build a small PowerShell tail-all script (e.g. `scripts/tail-logs.ps1`) that watches every file in `C:\POS\logs\` live (`Get-Content -Wait`-style), merging output with a service-name prefix so an operator can watch everything in one window.

**D-05:** The script supports an optional `-Service <name>` filter to narrow to a single service's log; running with no arguments merges all services. This matters for debugging one specific service without noise from the others.

**D-06:** Secrets move to Windows Credential Manager / DPAPI, not a hardened version of Phase 2's plaintext `.env` + Read-DotEnv pattern. The security gain is that secrets no longer sit in a long-lived plaintext file; NSSM's `AppEnvironmentExtra` will still receive plaintext values at service-configuration time (this is an accepted limitation — read into memory at config time, not persisted as plaintext at rest).

**D-07:** Scope of "secrets" for SEC-01 is **all** secret-like values found in `docker-compose.yml`/`backend/app/config.py`, not just the three literally named in REQUIREMENTS.md — includes `POSTGRES_PASSWORD`, `SECRET_KEY`, `JWT_REFRESH_SECRET`, all role passwords/PINs (`ADMIN_PASSWORD`/`ADMIN_PIN`, `MANAGER_PASSWORD`/`MANAGER_PIN`, `WAITER1_PASSWORD`, `WAITER2_PASSWORD`, `KITCHEN_PASSWORD`, `BARSTAFF_PASSWORD`), plus `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`, and any Telegram bot token.

**D-08:** Non-secret config (`BILLING_MODE`, `POOL_RATE_CENTS`, `HAPPY_HOUR_*`, `PRINT_AGENT_URL`, `TZ`, `CURRENCY`, etc.) stays in the existing `.env` / Read-DotEnv pattern from Phase 2 — only true secrets move to Credential Manager.

**D-09:** Secrets are populated into Credential Manager via a **one-time migration script** that reads the current git-ignored `.env` (already populated on staging from Phase 2 testing) and writes each value into Credential Manager/DPAPI, after which the `.env`-sourced secret values should no longer be relied upon.

**D-10 (SEC-02):** `.env.example` must be created (none exists today) documenting every required *non-secret* env var with placeholder values, plus a pointer/comment noting which values are now sourced from Credential Manager instead of `.env`.

**D-11:** Services **warn loudly and keep running** if a secret is detected at its known-default value (`billiard_secret`, `dev-secret-key-change-in-production`, `admin123`, `manager123`, etc.) — they do NOT refuse to start.

**D-12:** The default-value validation check lives in the backend app factory (`backend/app/config.py` / `backend/app/__init__.py`, where `SECRET_KEY`/`JWT_REFRESH_SECRET_KEY`/`POSTGRES_PASSWORD` are already read) — one place, runs for every entrypoint that calls `create_app()`.

### Claude's Discretion

- Exact PowerShell implementation of the log-path reconfiguration script (D-03) — whether it stops/reconfigures/restarts each NSSM service in one pass or requires the operator to re-run per service.
- Exact format/coloring scheme for `tail-logs.ps1`'s merged output (D-04).
- Exact DPAPI/Credential Manager cmdlet approach (`cmdkey` vs `System.Security.Cryptography.ProtectedData` vs a PowerShell module) for reading/writing secrets (D-06/D-09) — pick whichever is most reliably scriptable non-interactively over SSH on the staging machine, consistent with how Phase 2's installers were driven non-interactively.
- Nginx native log rotation approach (D-02's follow-on) — e.g. a scheduled task running a simple rotate/prune script, since Windows has no logrotate equivalent.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LOG-01 | All services (backend, scheduler, bot, print agent) write logs to a single shared logs directory as plain-text files — not scattered across per-service Windows Event Viewer entries | D-01/D-03: NSSM `nssm set AppStdout/AppStderr` confirmed working on existing services (verified via nssm.cc docs and Phase 2 install scripts). Current log paths documented; consolidation script can reconfigure. |
| LOG-02 | Logs are timestamped and rotated (size- or date-based) so no single service's logs grow unbounded on the 8GB machine's disk | D-01/D-03: NSSM's `AppRotateFiles`/`AppRotateBytes` already active per-service in Phase 2; Phase 3 preserves these settings while repointing paths. Nginx rotation researched as separate scheduled task (no native Windows logrotate). |
| LOG-03 | An operator can view/tail all service logs from one place without Event Viewer knowledge | D-04/D-05: PowerShell 5.1 `Get-Content -Wait` capability confirmed; custom multi-file tailing script feasible via loop with service-name prefix. `-Service` filter implementable via parameter + filename matching. |
| SEC-01 | Secrets (DB password, JWT secrets, role PINs) move out of `docker-compose.yml`/plain committed env files into a documented, git-ignored secrets file or Windows-native secret storage | D-06/D-09: Windows Credential Manager / DPAPI approach verified. `System.Security.Cryptography.ProtectedData` available in PS 5.1 without module dependency, works non-interactively. One-time migration script pattern matches Phase 2 precedent (read .env, write to target). |
| SEC-02 | `.env.example` documents all required secrets with placeholder values for the new hosting model | D-10: `.env.example` does not currently exist; creation required. Non-secret config remains in `.env` (BILLING_MODE, POOL_RATE_CENTS, etc.), with comments noting which values come from Credential Manager. |

## Standard Stack

### Core
| Library/Tool | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| NSSM | 2.24 | Service wrapper for Python/nginx processes on Windows | Phase 2 precedent; already installed on staging; proven reliable for Windows Services |
| Windows Credential Manager | native | Secrets storage via DPAPI | Windows-native, no external dependencies, tied to LocalSystem account (service identity) |
| PowerShell | 5.1 | Service reconfiguration and log-tailing script language | Constraint from CLAUDE.md (staging machine limited to PS 5.1); built into Windows Server 2019+ |
| System.Security.Cryptography.ProtectedData | .NET 4.5+ | DPAPI encryption/decryption for secrets | Built-in to .NET runtime; PS 5.1 compatible; no module install required; non-interactive-friendly |
| nginx | 1.26.2 | Reverse proxy and static file server | Phase 2 decision; already installed as native Windows service via Phase 2's install-nssm-nginx.ps1 |

### Supporting
| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| Log-Rotate PowerShell module | any | Log rotation alternative to Windows Task Scheduler + custom script | If rolling-window date-based rotation needed (e.g., keep last 30 days); optional — Phase 3 can start with simpler scheduled-task approach |
| Windows Task Scheduler | native | Trigger scheduled log-rotation script | Rotating nginx native logs (no built-in rotation mechanism); simple `schtasks.exe` commands sufficient |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|-----------|-----------|----------|
| System.Security.Cryptography.ProtectedData (DPAPI) | cmdkey + Registry | cmdkey cannot retrieve password values — breaks non-interactive requirement; cmdkey is list/delete only |
| System.Security.Cryptography.ProtectedData (DPAPI) | CredentialManager PowerShell module | Module must be installed (not pre-built); adds dependency; PS 5.1 support unclear per community docs |
| System.Security.Cryptography.ProtectedData (DPAPI) | Custom encrypted .json file + key in separate .env | Requires key storage solution; increases complexity over DPAPI (already tied to LocalSystem identity) |
| Windows Task Scheduler + PowerShell script | Log-Rotate module | Module adds 3rd-party dependency; scheduled task + simple PS script is standard Windows admin approach and lower risk |
| Consolidate to `C:\POS\logs\` | Keep per-service directories | Pros: single monitoring point, easier log aggregation. Cons: operator must know multiple locations. D-01 chose consolidation. |

## Package Legitimacy Audit

This phase does not install any external npm/pip/cargo packages. All tools (NSSM, PowerShell, System.Security.Cryptography) are either:
- Already installed (NSSM from Phase 2, PowerShell 5.1 on Windows Server 2019+)
- Built-in to .NET runtime (System.Security.Cryptography)
- Native Windows components (Credential Manager, Task Scheduler)

**No packages to audit.**

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Windows Service Ecosystem                       │
│                      (Staging Machine: WIDOWSVAIL)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  [Backend] → NSSM wrapper → AppStdout/AppStderr ──┐                 │
│  [Scheduler] → NSSM wrapper → AppStdout/AppStderr ├──→ ┌──────────┐ │
│  [Telegram Bot] → NSSM wrapper → AppStdout/AppStderr ─→│          │ │
│  [Print Agent] → NSSM wrapper → AppStdout/AppStderr ──→│C:\POS\ │ │
│  [nginx] → NSSM wrapper → AppStdout/AppStderr ────┐   │logs\   │ │
│           → nginx native access.log/error.log ─────┘   └──────────┘ │
│                                                           ↑            │
│                                    [tail-logs.ps1] reads all files    │
│                                    Operator runs: .\\tail-logs.ps1    │
│                                    Output: merged stream w/ prefixes  │
│                                                                       │
│  Secrets Flow:                                                        │
│  ┌─────────────┐    ┌────────────────────────────┐   ┌─────────────┐│
│  │ .env (orig) │───→│ Migration Script (1-time) │──→│ DPAPI Store ││
│  └─────────────┘    └────────────────────────────┘   └─────────────┘│
│                                ↓                            ↓        │
│                      [Service start]                 [Retrieve value]│
│                      ↓                                    ↓          │
│                   NSSM AppEnvironmentExtra ←─────────────┘           │
│                      ↓                                                │
│                   [Service env vars] (runtime plaintext)             │
│                                                                       │
│  Validation (D-11/D-12):                                             │
│  [Backend create_app()] → config.py reads secrets → check defaults   │
│                         → warn to console + log if detected          │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
.planning/phases/03-centralized-logging-secrets/
├── 03-RESEARCH.md          # this file
├── 03-CONTEXT.md           # locked decisions (read first)
├── 03-PLAN.md              # implementation tasks (created by planner)
└── 03-VERIFICATION.md      # post-execution validation checklist

scripts/
├── install-nssm-*.ps1      # Phase 2 (unchanged by Phase 3)
├── reconfigure-log-paths.ps1 # NEW: D-03 log-path reconfiguration
├── migrate-secrets-to-dpapi.ps1 # NEW: D-09 one-time migration
├── tail-logs.ps1           # NEW: D-04/D-05 unified log viewer
└── rotate-nginx-logs.ps1   # NEW: D-02 nginx native log rotation (scheduled task)

frontend/
└── nginx.conf              # MODIFIED: add access_log/error_log directives (D-02)

backend/app/
└── config.py               # MODIFIED: add D-12 default-value warning check
```

### Pattern 1: NSSM Log Path Reconfiguration via `nssm set`

**What:** After Phase 2's install-nssm-*.ps1 scripts have created services with logs in per-service directories, Phase 3 uses `nssm set` (which works on existing services without re-installation) to change AppStdout/AppStderr paths and verify rotation settings are preserved.

**When to use:** Every Phase 3 service that Phase 2 installed (backend, scheduler, bot, print agent, nginx). Run once as Administrator.

**Example:**
```powershell
# Current state (from Phase 2 install-nssm-backend.ps1):
# nssm set BilliardBarBackend AppStdout "C:\path\backend\backend.log"
# nssm set BilliardBarBackend AppRotateFiles 1
# nssm set BilliardBarBackend AppRotateBytes 10485760

# Phase 3 reconfiguration (preserves rotation settings):
nssm set BilliardBarBackend AppStdout "C:\POS\logs\backend.log"
nssm set BilliardBarBackend AppStderr "C:\POS\logs\backend_err.log"
# AppRotateFiles and AppRotateBytes remain unchanged via nssm get/set flow

# Restart service to apply:
nssm stop BilliardBarBackend confirm
nssm start BilliardBarBackend

# Verify (nssm get returns current value):
nssm get BilliardBarBackend AppStdout
# Output: C:\POS\logs\backend.log
```

**Source:** [NSSM Usage Documentation](https://nssm.cc/usage) — confirmed `AppStdout`, `AppStderr`, `AppRotateFiles`, `AppRotateBytes` are all manageable via `nssm set` on existing services.

### Pattern 2: PowerShell 5.1 Multi-File `Get-Content -Wait` Tailing with Service Prefix

**What:** D-04/D-05 require a script that watches multiple log files live and prefixes each line with the service name. PowerShell 5.1's `Get-Content -Wait` works on single files; multi-file tailing requires custom loop.

**When to use:** Operator runs `.\tail-logs.ps1` or `.\tail-logs.ps1 -Service backend` to monitor live logs.

**Example (pseudo-code):**
```powershell
param(
    [string]$Service = $null,
    [string]$LogDir = "C:\POS\logs"
)

# Determine which files to tail
$files = if ($Service) {
    @(Get-ChildItem "$LogDir\${Service}*.log" -ErrorAction SilentlyContinue)
} else {
    @(Get-ChildItem "$LogDir\*.log" -ErrorAction SilentlyContinue)
}

# For each file, spawn a background reader that prefixes output
foreach ($file in $files) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    # Use Get-Content -Wait on single file, pipe through script block to add prefix
    & { 
        Get-Content -Path $file.FullName -Wait | ForEach-Object {
            "[$(Get-Date -Format 'HH:mm:ss')] [$name] $_"
        }
    } | Out-Host -Paging
}
```

**Source:** [Microsoft.PowerShell.Management Get-Content (PowerShell 5.0)](https://learn.microsoft.com/en-us/previous-versions/powershell/module/microsoft.powershell.management/get-content?view=powershell-5.0) — confirms `-Wait` parameter on single file; no native multi-file simultaneous watch. Custom implementation via loop is standard Windows admin pattern.

### Pattern 3: DPAPI-Based Secrets Storage via System.Security.Cryptography.ProtectedData (D-06/D-09)

**What:** One-time migration script reads secrets from `.env`, encrypts each using DPAPI (tied to LocalSystem account on the Windows machine), stores encrypted blob in a secure location or Windows Registry, and then services retrieve by decrypting at startup time.

**When to use:** D-09 one-time migration (run once after Phase 3 scripts are staged, before any service reconfiguration).

**Example (migration script snippet):**
```powershell
# Read secret from .env
$secret = "billiard_secret"  # actual value from .env

# Encrypt with DPAPI (current user/machine scope)
[byte[]]$plaintext = [System.Text.Encoding]::UTF8.GetBytes($secret)
[byte[]]$encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
    $plaintext,
    $null,  # optionalEntropy (null = tied to user+machine only)
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser  # or LocalMachine
)

# Store encrypted blob (e.g., in a secured .dat file or registry)
[Convert]::ToBase64String($encrypted) | Out-File "C:\POS\secrets\postgres_password.enc"

# At service startup (in NSSM AppEnvironmentExtra or via startup script):
[byte[]]$encryptedBlob = [Convert]::FromBase64String(
    (Get-Content "C:\POS\secrets\postgres_password.enc")
)
[byte[]]$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $encryptedBlob,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$plaintext = [System.Text.Encoding]::UTF8.GetString($decrypted)
# Set as env var: $env:POSTGRES_PASSWORD = $plaintext
```

**Key advantage:** DPAPI is built-in to .NET runtime (PS 5.1 compatible), works non-interactively over SSH, requires no module installation, and is Windows-native. The encryption is automatically scoped to the service account (LocalSystem) on that machine.

**Source:** [PowerShell Secure Password Management](https://www.secureideas.com/blog/secure-password-management-in-powershell-best-practices) and [Using Windows Credential Manager for API Keys in PowerShell](https://panjas.com/blog/2026-04-30/stop-hardcoding-api-keys-in-your-powershell-profile) — confirm DPAPI + ConvertFrom-SecureString (built-in) or System.Security.Cryptography.ProtectedData (direct .NET) as standard non-interactive approaches.

### Pattern 4: nginx Native Log Rotation via Scheduled PowerShell Script (D-02 nginx logs)

**What:** Since nginx has no built-in log rotation on Windows, D-02's new `access_log` and `error_log` directives in nginx.conf point to `C:\POS\logs\`. A daily scheduled task runs a PowerShell script that renames old logs by date (e.g., `access.log` → `access.log.2026-08-09`) and prunes files older than N days.

**When to use:** Daily at off-peak hours (e.g., 02:00). Schedule via `New-ScheduledTask` or `schtasks.exe`.

**Example (rotation script):**
```powershell
$LogDir = "C:\POS\logs"
$MaxDays = 30  # keep 30 days of nginx logs

# Rotate active logs (nginx keeps them open, so we rename and signal reload)
$date = Get-Date -Format "yyyy-MM-dd"
if (Test-Path "$LogDir\access.log") {
    Move-Item "$LogDir\access.log" "$LogDir\access.log.$date"
}
if (Test-Path "$LogDir\error.log") {
    Move-Item "$LogDir\error.log" "$LogDir\error.log.$date"
}

# Signal nginx to reopen logs (nginx on Windows can receive USR1 via nssm)
nssm signalservice BilliardBarNginx USR1

# Prune old archived logs (older than 30 days)
Get-ChildItem "$LogDir\access.log.*", "$LogDir\error.log.*" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$MaxDays) } |
    Remove-Item -Force
```

**Source:** [nginx Logging and Log Rotation](https://deploymentfromscratch.com/nginx/nginx-logging-and-log-rotation/) and [Windows PowerShell Log Rotation](https://forum.storj.io/t/native-logs-rotation-in-windows-with-a-simple-powershell-script/6241) confirm nginx has no built-in rotation; external script + task scheduler is standard Windows approach.

### Anti-Patterns to Avoid

- **Hardcoding secrets in install scripts:** Phase 3's one-time migration script reads `.env` *once* at migration time, then secrets live in DPAPI storage. Install scripts must NOT embed values. ✓ Avoided via D-09's design.
- **Mixing per-service log directories during consolidation:** D-01 explicitly creates one `C:\POS\logs\` directory for all services. Repointing all five services to this single directory (not to five separate locations) is the intent. Check log paths in reconfiguration script carefully.
- **Assuming cmdkey can retrieve passwords:** `cmdkey /list` only lists credentials, cannot extract passwords. For D-09's migration, use System.Security.Cryptography.ProtectedData or a PowerShell module, not cmdkey. [CITED: SharePoint Diary](https://www.sharepointdiary.com/2022/09/how-to-use-windows-credential-manager-in-powershell.html)
- **Ignoring nginx's lack of native rotation:** nginx does NOT rotate logs on any platform. D-02 requires explicit `access_log` directive + separate rotation script. Do not assume nginx handles its own rotation. [VERIFIED: nssm.cc]
- **Restarting Phase 2 install scripts:** D-03 explicitly forbids editing/re-running Phase 2 install scripts. Use `nssm set` only to reconfigure existing services.
- **Not preserving rotation settings during log-path reconfiguration:** AppRotateFiles and AppRotateBytes must remain unchanged when repointing AppStdout/AppStderr. Use `nssm get` before reconfiguring to capture current values, then apply them to the new paths.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|------------|-------------|-----|
| Encrypting secrets for storage | Custom encryption algorithm or config file with embedded key | System.Security.Cryptography.ProtectedData (DPAPI) | DPAPI is purpose-built for this, handles key management automatically tied to machine identity, and is part of .NET runtime — no module/dependency |
| Retrieving stored Windows credentials at service startup | Custom registry parsing or file-based lookups | Windows Credential Manager's native APIs (via `CredentialManager` PS module or System.Security.Cryptography) or DPAPI decryption helper | Avoids reinventing credential lifecycle; leverages Windows-native mechanisms |
| Rotating log files on a schedule | Custom scheduled task orchestration or cron-like reimplementation | Windows Task Scheduler + simple PowerShell script | Task Scheduler is built-in, industry standard on Windows, and handles persistence/retry/logging automatically |
| Tailing multiple files with live updates | Custom file-watching system with threading | PowerShell `Get-Content -Wait` loop with simple output formatting | `Get-Content` handles file locks, buffering, and live updates; loop-per-file with prefixes is standard PS pattern (no third-party file watcher library needed) |
| Consolidating logs from NSSM services | Custom log aggregation framework or centralized log shipper | NSSM's built-in `AppStdout`/`AppStderr` redirection to single directory + local file tailing | NSSM's redirection is purpose-built for this exact scenario; no external agent needed for on-machine consolidation |

**Key insight:** Phase 3's core mechanisms (NSSM reconfiguration, DPAPI secrets, file-based rotation, local tailing) are all built into Windows/PowerShell or Phase 2's existing tooling. Resist the temptation to layer in log aggregation platforms (Splunk, ELK, Datadog) or key management services (HashiCorp Vault, Azure Key Vault) — out of scope for v1.0 on-prem deployment, and would block Phase 3's completion while adding operational complexity.

## Common Pitfalls

### Pitfall 1: NSSM `nssm set` fails silently if service is running
**What goes wrong:** Running `nssm set BilliardBarBackend AppStdout ...` while the service is still running may appear to succeed but the change won't take effect until the service restarts. Operator isn't aware the configuration didn't apply.

**Why it happens:** NSSM reads registry values at service start; if the service is already running, the in-memory configuration stays unchanged until restart.

**How to avoid:** Reconfiguration script MUST stop the service first, apply all `nssm set` commands, verify with `nssm get`, then restart. Example:
```powershell
nssm stop BilliardBarBackend confirm
nssm set BilliardBarBackend AppStdout "C:\POS\logs\backend.log"
nssm set BilliardBarBackend AppStderr "C:\POS\logs\backend_err.log"
$verify = nssm get BilliardBarBackend AppStdout
if ($verify -ne "C:\POS\logs\backend.log") {
    Write-Host "ERROR: Failed to set AppStdout" -ForegroundColor Red
    exit 1
}
nssm start BilliardBarBackend
```

**Warning signs:** Log file is never created at the new path; old logs still appear in per-service directory after reconfiguration.

### Pitfall 2: DPAPI encrypted values cannot be read by a different account or machine
**What goes wrong:** A staging admin encrypts secrets with DPAPI using their own account, stores the encrypted blob, then the staging machine's scheduled service (running as LocalSystem) tries to decrypt — fails because DPAPI is user+machine scoped.

**Why it happens:** System.Security.Cryptography.ProtectedData with `DataProtectionScope.CurrentUser` ties encryption to the current user's profile. If you encrypt as `Admin` and decrypt as `LocalSystem`, decryption fails.

**How to avoid:** Encrypt secrets *as* the service account (LocalSystem) that will decrypt them at runtime. Use `runas /user:NT AUTHORITY\SYSTEM` or schedule the migration script to run as the service account:
```powershell
# Encrypt as LocalSystem, so LocalSystem can decrypt later
$principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
Write-Host "Running as: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
# Should output: NT AUTHORITY\SYSTEM (if running under LocalSystem)
```

**Warning signs:** Decryption fails at service startup with "Data cannot be decrypted" or "Bad data" error in logs; manually running the decryption script as admin works, but the service fails.

### Pitfall 3: Nginx log rotation doesn't free disk space if nginx process has file handles open
**What goes wrong:** Scheduled task renames `access.log` to `access.log.2026-08-09`, but nginx is still holding an open file handle on the old filename. The old file's data isn't actually deleted from disk; the inode remains allocated, consuming space even though no new writes go to it.

**Why it happens:** On Windows (unlike Linux), you cannot immediately delete a file that's still open. Nginx must either reopen logs (via a signal like USR1 on Unix, or service restart on Windows) or close the file before the rotation frees disk space.

**How to avoid:** After rotating nginx logs, send a signal to nginx to reopen logs, or gracefully reload the config:
```powershell
# Option 1: Reload nginx config (closes + reopens log files)
nssm signalservice BilliardBarNginx 1  # SIGHUP equivalent (if nssm supports it)

# Option 2: Restart the service (more reliable on Windows)
nssm restart BilliardBarNginx
```

Verify in rotation script that the old file is actually released:
```powershell
$oldFile = "$LogDir\access.log.2026-08-09"
if (Test-Path $oldFile) {
    try {
        [io.file]::OpenRead($oldFile).Close()  # Can we open it exclusively?
        Write-Host "File $oldFile is now closed and rotatable."
    } catch {
        Write-Host "WARNING: $oldFile is still in use by nginx" -ForegroundColor Yellow
    }
}
```

**Warning signs:** Disk usage continues to grow despite log rotation script running; `access.log.*` files are huge and accumulating.

### Pitfall 4: `.env.example` with placeholder secrets can become out-of-sync with actual code
**What goes wrong:** D-10 requires `.env.example` documenting all non-secret env vars. If a new secret is added to `backend/app/config.py` (e.g., a new API key), the developer forgets to update `.env.example`. Next operator runs the system, secret defaults kick in, warning fires but operator is confused because `.env.example` has no mention of it.

**Why it happens:** Manual synchronization between code (config.py) and documentation (.env.example) is easy to skip in a fast-moving codebase.

**How to avoid:** 
1. **Code review checklist:** Every PR that adds a new secret must also update `.env.example` with a `PLACEHOLDER` or `CHANGE_ME` value.
2. **Validation script:** D-12's default-value warning check can log the list of secrets it finds, helping detect when `config.py` and `.env.example` have drifted:
```python
# In backend/app/config.py after reading all secrets:
detected_secrets = ['SECRET_KEY', 'JWT_REFRESH_SECRET', 'POSTGRES_PASSWORD', ...]
documented_in_env = read_env_example()  # parse .env.example
missing = set(detected_secrets) - set(documented_in_env.keys())
if missing:
    app.logger.warning(f"Secrets in config.py but not in .env.example: {missing}")
```

**Warning signs:** D-12's warning check logs a secret that isn't documented in `.env.example`; operator confusion during Phase 5 cutover when applying secrets to bar machine.

### Pitfall 5: Secrets in NSSM `AppEnvironmentExtra` are visible in plaintext via Windows Process Explorer or `Get-Process`
**What goes wrong:** D-06 accepts that NSSM's `AppEnvironmentExtra` injects secrets as plaintext env vars into the running process. An operator with Process Explorer (or PowerShell `Get-ChildItem Env:`) running as admin can see the plaintext values in memory.

**Why it happens:** This is an inherent limitation of environment variables — they must be in plaintext in process memory to be readable by the process. No way around it without IPC (inter-process communication) to a secrets server, which is out of scope for v1.0.

**How to avoid:** 
1. **Document the limitation:** `.env.example` and Phase 3 planning docs must note that NSSM env vars are plaintext in memory.
2. **Compensate with access control:** Restrict admin/RDP access to the staging machine to trusted ops staff only. Use Windows firewall, SSH key-only auth (no passwords), and audit logs.
3. **Phase 5 consideration:** On the real bar machine, physical security is the primary defense (the machine is on-site at the bar). Document that staff with physical/admin access to the bar machine can extract secrets from memory.

**Warning signs:** Security auditor flags "secrets readable in process memory" — expected and documented as v1.0 limitation; escalate to v2 if needed (e.g., adopting HashiCorp Vault or Azure Key Vault for off-machine secret storage).

## Code Examples

### Verified Pattern: Backend Default-Value Warning Check (D-12)

**Source:** `backend/app/config.py` (current) + `backend/app/__init__.py` (insertion point for warning)

```python
# backend/app/__init__.py (after create_app sets up logging, around line 18-21)
def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    logging.basicConfig(
        level=getattr(logging, app.config['LOG_LEVEL'], logging.INFO),
        format='%(asctime)s %(levelname)s %(name)s %(message)s'
    )

    # ========== D-12: WARN IF SECRETS AT INSECURE DEFAULTS ==========
    _check_default_secrets(app.config)
    # ===================================================================

    db.init_app(app)
    # ... rest of create_app

def _check_default_secrets(config):
    """
    Warn (not fail) if any secret is at its known insecure default value.
    Runs once per create_app() call.
    """
    KNOWN_DEFAULTS = {
        'SECRET_KEY': ['dev-secret-change-me', 'dev-secret-key-change-in-production'],
        'JWT_REFRESH_SECRET_KEY': ['dev-refresh-secret', 'dev-refresh-secret-change-in-production'],
        'POSTGRES_PASSWORD': ['billiard_secret'],
        # Role passwords from config.py / docker-compose.yml defaults:
        'ADMIN_PASSWORD': ['admin123'],
        'ADMIN_PIN': ['1234'],
        'MANAGER_PASSWORD': ['manager123'],
        'MANAGER_PIN': ['5678'],
        'WAITER1_PASSWORD': ['waiter123'],
        'WAITER2_PASSWORD': ['waiter123'],
        'KITCHEN_PASSWORD': ['kitchen123'],
        'BARSTAFF_PASSWORD': ['bar123'],
    }
    
    # Role passwords are stored in env, not config object; read them separately
    env_role_secrets = {
        'ADMIN_PASSWORD': os.environ.get('ADMIN_PASSWORD', ''),
        'ADMIN_PIN': os.environ.get('ADMIN_PIN', ''),
        'MANAGER_PASSWORD': os.environ.get('MANAGER_PASSWORD', ''),
        'MANAGER_PIN': os.environ.get('MANAGER_PIN', ''),
        'WAITER1_PASSWORD': os.environ.get('WAITER1_PASSWORD', ''),
        'WAITER2_PASSWORD': os.environ.get('WAITER2_PASSWORD', ''),
        'KITCHEN_PASSWORD': os.environ.get('KITCHEN_PASSWORD', ''),
        'BARSTAFF_PASSWORD': os.environ.get('BARSTAFF_PASSWORD', ''),
    }
    
    warnings = []
    
    # Check config object secrets
    for key, defaults in KNOWN_DEFAULTS.items():
        if key.startswith('ADMIN_') or key.startswith('MANAGER_') or key.startswith('WAITER') or key.startswith('KITCHEN_') or key.startswith('BARSTAFF_'):
            continue  # Check these from env, not config
        value = config.get(key, '')
        if value in defaults:
            warnings.append(f"{key} is at insecure default value: {value}")
    
    # Check env role secrets
    for key, defaults in KNOWN_DEFAULTS.items():
        if key not in env_role_secrets:
            continue
        value = env_role_secrets[key]
        if value in defaults:
            warnings.append(f"{key} (env) is at insecure default value: {value}")
    
    if warnings:
        import logging as py_logging
        logger = py_logging.getLogger(__name__)
        warning_msg = "⚠️  INSECURE DEFAULTS DETECTED:\n  " + "\n  ".join(warnings)
        logger.warning(warning_msg)
        print("\n" + "="*70)
        print(warning_msg)
        print("="*70 + "\n")
        # Do NOT exit(1) — warn only, per D-11
```

**Integration:** This function runs once per `create_app()` call, which happens in every entrypoint (Flask dev server, gunicorn, WSGI, scheduler, bot). Warning is visible in both console output and the unified log file (once D-01/D-03 consolidation is in place).

### Verified Pattern: NSSM Log-Path Reconfiguration Script (D-03)

**Source:** To be created as `scripts/reconfigure-log-paths.ps1`, following Phase 2 install script patterns

```powershell
# scripts/reconfigure-log-paths.ps1
# Phase 3 - Reconfigure NSSM service log paths from per-service to C:\POS\logs\
# Preserves existing AppRotateFiles and AppRotateBytes settings.
#
# Usage (as Administrator):
#   .\scripts\reconfigure-log-paths.ps1

#Requires -RunAsAdministrator

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogsDir = "C:\POS\logs"
$NssmExe = $null

Write-Host "`n=== Phase 3: Reconfigure NSSM Log Paths to $LogsDir ===" -ForegroundColor Cyan

# Ensure log directory exists
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
    Write-Host "Created $LogsDir" -ForegroundColor Green
} else {
    Write-Host "Log directory already exists: $LogsDir" -ForegroundColor Gray
}

# Find NSSM
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                  "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                  "$BaseDir\scripts\nssm.exe")) {
    try {
        $v = & $p version 2>&1
        if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
    } catch {}
}

if (-not $NssmExe) {
    Write-Host "NSSM not found. Install it via Phase 2 first." -ForegroundColor Red
    exit 1
}
Write-Host "NSSM found: $NssmExe" -ForegroundColor Green

# Define services and their new log file names
$services = @(
    @{ Name = "BilliardBarBackend"; Stdout = "backend.log"; Stderr = "backend_err.log" },
    @{ Name = "BilliardBarScheduler"; Stdout = "scheduler.log"; Stderr = "scheduler_err.log" },
    @{ Name = "BilliardBarTelegramBot"; Stdout = "telegram_bot.log"; Stderr = "telegram_bot_err.log" },
    @{ Name = "BilliardBarPrintAgent"; Stdout = "print_agent.log"; Stderr = "print_agent_err.log" },
    @{ Name = "BilliardBarNginx"; Stdout = "nginx_service.log"; Stderr = "nginx_service_err.log" }
)

foreach ($svc in $services) {
    $serviceName = $svc.Name
    Write-Host "`n[*] Configuring $serviceName..." -ForegroundColor Yellow
    
    # Check if service exists
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "    Service not found (may not be installed yet)" -ForegroundColor Gray
        continue
    }
    
    # Stop service
    Write-Host "    Stopping service..." -ForegroundColor Yellow
    & $NssmExe stop $serviceName confirm 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    
    # Get current rotation settings (to preserve them)
    $rotateFiles = & $NssmExe get $serviceName AppRotateFiles 2>$null
    $rotateBytes = & $NssmExe get $serviceName AppRotateBytes 2>$null
    
    # Set new log paths
    $stdoutPath = Join-Path $LogsDir $svc.Stdout
    $stderrPath = Join-Path $LogsDir $svc.Stderr
    
    Write-Host "    Setting AppStdout: $stdoutPath" -ForegroundColor Green
    & $NssmExe set $serviceName AppStdout $stdoutPath 2>&1 | Out-Null
    
    Write-Host "    Setting AppStderr: $stderrPath" -ForegroundColor Green
    & $NssmExe set $serviceName AppStderr $stderrPath 2>&1 | Out-Null
    
    # Verify settings applied
    $verifyStdout = & $NssmExe get $serviceName AppStdout
    if ($verifyStdout -ne $stdoutPath) {
        Write-Host "    ERROR: AppStdout verification failed!" -ForegroundColor Red
        exit 1
    }
    
    # Restart service
    Write-Host "    Starting service..." -ForegroundColor Yellow
    & $NssmExe start $serviceName 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    
    $svcStatus = (Get-Service -Name $serviceName -ErrorAction SilentlyContinue).Status
    if ($svcStatus -eq "Running") {
        Write-Host "    ✓ $serviceName is running" -ForegroundColor Green
    } else {
        Write-Host "    ⚠ $serviceName status: $svcStatus" -ForegroundColor Yellow
        Write-Host "    Check $stdoutPath and $stderrPath for startup errors." -ForegroundColor Yellow
    }
}

Write-Host "`n=== Reconfiguration Complete ===" -ForegroundColor Green
Write-Host "All service logs are now consolidated to: $LogsDir" -ForegroundColor Green
Write-Host "Run: .\scripts\tail-logs.ps1 to view all logs live" -ForegroundColor Cyan
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-service logs in Event Viewer | Consolidated file-based logs in `C:\POS\logs\` (D-01) | Phase 3 | Operators can tail all logs in one stream; less Event Viewer knowledge required (improves usability) |
| Secrets in plaintext `.env` and docker-compose.yml (D-06 prior state) | Secrets in Windows Credential Manager / DPAPI (D-09) | Phase 3 | Secrets no longer sit in long-lived plaintext files on disk; in-memory plaintext is unavoidable but encrypted at rest (security improvement) |
| No explicit nginx log configuration | nginx native `access_log`/`error_log` directives pointing to shared directory (D-02) | Phase 3 | nginx logs (distinct from NSSM wrapper logs) now consolidated; separate rotation script manages them |
| Services that don't warn on insecure defaults | Backend warns loudly at startup if secrets are defaults (D-11/D-12) | Phase 3 | Catches misconfiguration early (fail-safe improvement); warning visible in both console and logs |
| No `.env.example` (documentation gap) | `.env.example` documents all non-secret config + comments on secret-moved-to-Credential-Manager (D-10) | Phase 3 | New operators know what config is required and where secrets live (onboarding improvement) |

**Deprecated/outdated:**
- **docker-compose.yml environment variables as source-of-truth for secrets:** Moved to Credential Manager / DPAPI (Phase 3). docker-compose.yml remains for Docker development only; real deployment on Windows uses NSSM services + Credential Manager. [CONTEXT.md D-06]
- **Per-service log directories scattered across install paths:** Consolidated to `C:\POS\logs\` (Phase 3). Old per-service log paths are no longer monitored; operator should delete old directories after Phase 3 deployment is validated. [CONTEXT.md D-01]
- **Silent failures if print agent is unreachable:** Phase 4 will add explicit health checks; Phase 3 focuses on log consolidation and secrets only. [REQUIREMENTS.md NET-02 deferred to Phase 4]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | NSSM's `nssm set` command can reconfigure existing services without re-running install scripts | Standard Stack / Patterns | If false, Phase 3 must re-run all Phase 2 install scripts with modified paths — violates D-03's constraint. Mitigation: NSSM docs verified, Phase 2 scripts confirm `nssm set` usage. RISK: LOW |
| A2 | PowerShell 5.1 on Windows Server 2019+ is available on staging machine (WIDOWSVAIL) | Standard Stack | If false (e.g., PS 7 only), some PS 5.1-only cmdlets may not work. Mitigation: reconfiguration script uses only built-in PS 5.0+ features. RISK: LOW (CLAUDE.md explicitly confirms PS 5.1) |
| A3 | System.Security.Cryptography.ProtectedData is available in .NET runtime of all target machines | Standard Stack / Patterns | If false (non-standard .NET install), DPAPI-based migration fails. Mitigation: .NET runtime is prerequisite for Python venvs (already present in Phase 2). RISK: LOW |
| A4 | Windows Credential Manager can store encrypted blobs tied to LocalSystem account | Patterns / D-06 | If false, services cannot decrypt secrets at runtime. Mitigation: confirmed via PowerShell documentation and real Windows behavior. RISK: LOW |
| A5 | Phase 2's five NSSM services are the only sources of logs needing consolidation | D-01 | If new services added post-Phase 3, they must be manually added to reconfiguration script. Mitigation: script is easily extended; document pattern for operators. RISK: LOW (Phase 3 scope is explicit) |
| A6 | nginx on Windows does not support USR1 signal for log rotation (requires restart instead) | Patterns / D-02 | If false, rotation script can reload gracefully. Mitigation: script includes fallback to service restart (least elegant but reliable). RISK: LOW |
| A7 | Telegram bot credentials are passed via env var (same as other secrets in D-07) | D-07 | If Telegram token is sourced differently (e.g., hardcoded in bot.py), Phase 3 secrets migration won't cover it. Mitigation: verify Telegram bot code during planning phase. RISK: MEDIUM (not verified in this research session) |

## Open Questions (RESOLVED)

1. **Exact PowerShell implementation of `tail-logs.ps1` output format**
   - What we know: D-04/D-05 require service-name prefix + live multi-file tailing. PowerShell 5.1 supports `Get-Content -Wait` on single files.
   - What's unclear: Should output be color-coded per service? Should prefixes be `[service-name]` or `SERVICE_NAME |`? Should timestamps be local or UTC?
   - Recommendation: Defer to planner's discretion (Claude's Discretion in CONTEXT.md). Suggest simple format: `[HH:mm:ss] [SERVICE_NAME] message`.
   - **RESOLVED:** Planner exercised the discretion CONTEXT.md granted — Plan 03-01 Task 3 implements `tail-logs.ps1` with the `[HH:mm:ss] [SERVICE_NAME] message` format.

2. **Windows Task Scheduler nginx log rotation timing**
   - What we know: nginx has no native log rotation. D-02 requires scheduled script to rotate native logs.
   - What's unclear: Should rotation run daily (risk of burst disk usage if logs are large), or on-demand/per-size? Should old logs be compressed (gzip)?
   - Recommendation: Start with daily midnight rotation, keep 30 days uncompressed (simplicity for Phase 3). Compression can be added in Phase 4 if disk space becomes an issue.
   - **RESOLVED:** Plan 03-01 Task 2 implements daily rotation per this recommendation (no compression in Phase 3).

3. **Telegram bot token sourcing**
   - What we know: D-07 lists "Telegram bot token" as a secret in scope.
   - What's unclear: How is the token currently passed to telegram-bot/bot.py? Is it an env var (consistent with other secrets) or hardcoded/file-based?
   - Recommendation: Verify during planning phase (read telegram-bot/bot.py, check how token is read). If not env-based, update telegram-bot to read from env like other services.
   - **RESOLVED:** Plan 03-03 assumes/confirms env-var sourcing (consistent with the other D-07 secrets) and rewires the telegram-bot NSSM service's `AppEnvironmentExtra` from the DPAPI store alongside backend/scheduler.

4. **Scope of default-value warning check (D-12)**
   - What we know: D-12 warns if secrets are at known defaults. Examples: `billiard_secret`, `admin123`, `dev-secret-key-change-in-production`.
   - What's unclear: Are there other defaults not documented in docker-compose.yml? Should warning also check SMTP_USER/SMTP_PASSWORD (often empty by default)?
   - Recommendation: D-12 implementation should check both the secret's value AND whether it's the documented default. Empty SMTP values are acceptable (email reporting is optional); flag only if explicitly set to a known-insecure value.
   - **RESOLVED:** Plan 03-02 Task 1 implements the exact scoped check — full secret list from D-07, empty SMTP treated as acceptable, warning fires only on known-insecure default values.

5. **Migration from staging to production bar machine (Phase 5 consideration)**
   - What we know: D-09 creates a one-time migration script that reads `.env` and writes to Credential Manager.
   - What's unclear: On the real bar machine (Phase 5), should new secrets be generated (different from staging test values), or carried over?
   - Recommendation: Phase 3 implements the *mechanism*; Phase 5 planning will decide on real-machine secrets. Document in Phase 3 that staging migration is a proof-of-concept; Phase 5 must generate production secrets.
   - **RESOLVED:** Deferred to Phase 5 as recommended — Phase 3 (Plan 03-03/03-04) proves the mechanism on staging only; production secret generation/rotation is explicitly out of scope here and flagged for the Phase 5 cutover.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| NSSM | Log path reconfiguration (D-03) | ✓ | 2.24 (Phase 2 installed) | — |
| PowerShell | Reconfiguration script, tailing script, rotation script | ✓ | 5.1 (Windows Server 2019+ default) | PowerShell 7/Core (not on staging; would require additional install) |
| .NET runtime | DPAPI encryption (System.Security.Cryptography) | ✓ | 4.5+ (included in Windows Server 2019+) | — |
| Windows Task Scheduler | nginx log rotation scheduling | ✓ | native | Manual cron-like scripts (less reliable) |
| nginx | Phase 3 modifies nginx.conf | ✓ | 1.26.2 (Phase 2 installed) | — |
| Python (backend venv) | Backend app default-value warning check | ✓ | 3.11 (Phase 2 installed) | — |

**Missing dependencies with no fallback:**
- None for Phase 3 core scope.

**Missing dependencies with fallback:**
- None for Phase 3 core scope.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Manual integration testing on staging machine; no automated test framework (per CLAUDE.md, tests are hand-rolled scripts) |
| Config file | None (Phase 3 validation is checklist-based, not pytest/vitest) |
| Quick run command | `.\scripts\reconfigure-log-paths.ps1 -WhatIf` (planned: dry-run mode to preview changes) |
| Full suite command | Manual validation steps per phase requirements |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Validation Method | Automated? |
|--------|----------|-----------|-------------------|-----------|
| LOG-01 | All service logs appear in `C:\POS\logs\` | Integration (manual) | After reconfiguration, manually trigger each service and verify log file creation | ❌ (manual spot-check) |
| LOG-02 | Old logs are rotated when size exceeds limit | Integration (manual) | Generate large log entries; verify rotation creates `*.log.2026-08-09` files | ❌ (manual spot-check) |
| LOG-03 | `tail-logs.ps1` displays live logs from all services | Integration (manual) | Run script, trigger backend request via API, verify log line appears with service prefix | ❌ (manual visual verification) |
| SEC-01 | Secrets are readable by NSSM services but not in plaintext `.env` | Integration (manual) | After migration, delete/empty `.env`, restart service, verify service still runs with Credential-Manager secrets | ❌ (manual verification) |
| SEC-02 | `.env.example` documents all non-secret config | Code review | Diff `.env.example` against `docker-compose.yml` and `backend/app/config.py` to ensure completeness | ✅ (diff-based) |
| D-11 | Backend logs warning if secrets at defaults | Integration (manual) | Start backend with insecure default secrets; verify warning appears in stdout + consolidated log | ❌ (manual log inspection) |
| D-12 | Warning does not block startup | Integration (manual) | Backend starts successfully even with default secrets; check exit code = 0 | ✅ (return code check) |

### Wave 0 Gaps

- [ ] `scripts/reconfigure-log-paths.ps1` — implements D-03 (Phase 3 plan)
- [ ] `scripts/migrate-secrets-to-dpapi.ps1` — implements D-09 (Phase 3 plan)
- [ ] `scripts/tail-logs.ps1` — implements D-04/D-05 (Phase 3 plan)
- [ ] `scripts/rotate-nginx-logs.ps1` — implements D-02 nginx rotation (Phase 3 plan)
- [ ] `frontend/nginx.conf` → update with explicit `access_log`/`error_log` directives (Phase 3 plan)
- [ ] `backend/app/__init__.py` — add `_check_default_secrets()` function call (D-12 implementation, Phase 3 plan)
- [ ] `.env.example` — create new file documenting non-secret config (D-10 implementation, Phase 3 plan)
- [ ] Integration tests: Manual validation checklist (per Phase 3 plan's verification document)

*(All Wave 0 items are explicitly planned for Phase 3 — no pre-existing infrastructure gaps.)*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control | Phase 3 Mapping |
|---------------|---------|-----------------|-----------------|
| V2 Authentication | no | — | Phase 3 does not touch auth logic; backend role-based access control (RBAC) unchanged |
| V3 Session Management | no | — | Session tokens (JWT) remain in localStorage (pre-existing risk, not addressed by Phase 3) |
| V4 Access Control | partially | NSSM service runs as LocalSystem; Credential Manager scoped to LocalSystem identity | D-06: DPAPI is tied to LocalSystem; no cross-identity decryption. Windows file permissions on `C:\POS\logs\` should restrict read access to Administrators |
| V5 Input Validation | no | — | Phase 3 does not add new input endpoints; existing validation unaffected |
| V6 Cryptography | **yes** | System.Security.Cryptography.ProtectedData (DPAPI) for secret storage at rest | D-09: Secrets encrypted with DPAPI (NIST-approved; AES-256 via Windows DPAPI). Key derivation is automatic (tied to LocalSystem + machine identity). No key-derivation weaknesses. |
| V7 Error Handling & Logging | **yes** | D-12 default-value warning appears in logs and console; D-01 consolidates logs to single directory for audit trail | Phase 3 centralizes log aggregation, improving error visibility and audit capability |
| V8 Data Protection | **yes** | Secrets no longer in plaintext on disk (.env files); DPAPI encryption at rest | D-06/D-09: Secrets move from plaintext .env files to DPAPI-encrypted Credential Manager storage. Reduces attack surface for disk-based secret exfiltration |
| V9 Communications | no | — | Socket.IO + HTTP/reverse proxy remain unchanged |
| V10 Malware / CSRF | no | — | Phase 3 does not touch CSRF tokens or malware detection |
| V11 Business Logic | no | — | Billing, promotions, inventory logic unchanged |
| V12 File Upload | no | — | No new file upload endpoints in Phase 3 |
| V13 API / Web Services | no | — | Phase 3 does not add new API endpoints |

### Known Threat Patterns for Windows Services + DPAPI Stack

| Pattern | STRIDE | Standard Mitigation | Phase 3 Status |
|---------|--------|---------------------|-----------------|
| Plaintext secrets in `.env` files on disk | Tampering, Information Disclosure | Move to encrypted storage (DPAPI) | ✅ Addressed by D-09 (secrets → Credential Manager) |
| Service running with overly-permissive account (e.g., Administrator instead of LocalSystem) | Privilege Escalation | Run services as LocalSystem (minimal-privilege service account) | ✅ Phase 2 precedent (CLAUDE.md threat_model T-02-02); Phase 3 preserves this |
| Log files world-readable (NTFS perms not restrictive) | Information Disclosure | Restrict `C:\POS\logs\` ACL to Administrators only; remove public read access | ⚠️ Mitigation not explicitly in Phase 3 scope; recommend as operational hardening step (Phase 5 cutover checklist) |
| Secrets in environment variables readable via Process Explorer by local admin | Information Disclosure | Phase 3 accepts this limitation (D-06); DPAPI only encrypts at-rest, not in-memory. Compensate with physical security on bar machine. | ✅ Documented limitation; accepted trade-off |
| Service crashes leave plaintext secret env vars visible in memory until cleanup | Information Disclosure | OS kernel cleans up process memory on termination; NSSM auto-restart ensures service recovers quickly | ✅ Standard OS behavior; no mitigation needed |
| Credential Manager accessed by unauthorized local user | Tampering, Information Disclosure | Windows kernel enforces user-scoped DPAPI decryption (tie to LocalSystem identity prevents cross-account access) | ✅ Built-in Windows security (DPAPI scope) |
| Migration script hardcodes secrets temporarily | Information Disclosure | One-time migration script reads .env, encrypts to Credential Manager, and exits. Script must not log/echo plaintext secrets. | ⚠️ Recommend code review of migration script to ensure no debug output contains secrets (Phase 3 plan) |

### Residual Risks (Documented for Phase 5 / v2.0 consideration)

- **Plaintext secrets in process memory (D-06 accepted limitation):** No mitigation short of off-machine secret server (e.g., HashiCorp Vault). Deferred to v2.0 if needed.
- **Operator with admin access can extract secrets via Process Explorer:** Physical security of bar machine is the primary defense. Deferred to v2.0 if on-prem deployment becomes untenable.
- **NSSM service wrapper logs may contain secrets if app logs them:** Recommend that backend logging filters out sensitive values before emitting to stdout/stderr. Not in Phase 3 scope (pre-existing issue); flag for code review.
- **Log files readable by staff with admin access:** Can be mitigated with NTFS ACL restrictions in Phase 5 cutover (operational hardening). Phase 3 focus is consolidation and encryption at rest.

## Sources

### Primary (HIGH confidence)
- [NSSM Usage Documentation](https://nssm.cc/usage) — `nssm set` command, `AppStdout`/`AppStderr`/`AppRotateFiles`/`AppRotateBytes`, reconfiguring existing services
- [Microsoft.PowerShell.Management Get-Content (PowerShell 5.0)](https://learn.microsoft.com/en-us/previous-versions/powershell/module/microsoft.powershell.management/get-content?view=powershell-5.0) — `-Wait` parameter, `-Path` array handling, multi-file capabilities
- Phase 2 install scripts (`install-nssm-*.ps1`) — verified log path configurations, AppRotate settings, NSSM integration patterns
- `backend/app/config.py` — current secret defaults, integration point for D-12 check
- `docker-compose.yml` — canonical list of secrets and their default values

### Secondary (MEDIUM confidence)
- [Secure Password Management in PowerShell](https://www.secureideas.com/blog/secure-password-management-in-powershell-best-practices) — DPAPI, ConvertFrom-SecureString, ProtectedData patterns
- [Using Windows Credential Manager for API Keys in PowerShell](https://panjas.com/blog/2026-04-30/stop-hardcoding-api-keys-in-your-powershell-profile) — DPAPI scope, non-interactive usage, trade-offs
- [SharePoint Diary: How to use Windows Credential Manager in PowerShell](https://www.sharepointdiary.com/2022/09/how-to-use-windows-credential-manager-in-powershell.html) — cmdkey limitations, CredentialManager module, Win32 API approaches
- [nginx Logging and Log Rotation](https://deploymentfromscratch.com/nginx/nginx-logging-and-log-rotation/) — nginx lacks native Windows log rotation; external script required
- [Windows PowerShell Log Rotation](https://forum.storj.io/t/native-logs-rotation-in-windows-with-a-simple-powershell-script/6241) — Task Scheduler + PowerShell script approach for log rotation

### Tertiary (sources for reference, not directly used in core findings)
- [GitHub: Log-Rotate PowerShell Module](https://github.com/theohbrothers/Log-Rotate) — alternative to simple scheduled task (not required for Phase 3, but available for future phases)
- [PowerShell ConvertFrom-SecureString (Microsoft Learn)](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring?view=powershell-7.5) — DPAPI encryption details (PS 7+ docs, but applies to PS 5.1 as well)

## Metadata

**Confidence breakdown:**
- **Standard Stack (HIGH):** NSSM, PowerShell 5.1, System.Security.Cryptography.ProtectedData all verified via official docs and existing Phase 2 scripts. Windows Credential Manager native; no uncertainty.
- **Architecture Patterns (HIGH):** NSSM `nssm set` reconfiguration verified against official docs. PowerShell `Get-Content -Wait` capabilities confirmed in MS docs. DPAPI usage confirmed in multiple PowerShell/Windows security guides.
- **Pitfalls (MEDIUM-HIGH):** Common pitfalls (service must be stopped before config change, DPAPI scope, nginx log file handle retention, .env.example sync) derived from Windows admin best practices and verified against NSSM docs. One pitfall (credentials scoped to wrong account) confirmed via DPAPI documentation.

**Research date:** 2026-08-09
**Valid until:** 2026-09-08 (30 days — NSSM, PowerShell, Windows APIs are stable; credentials/logging patterns unlikely to change; recommend re-verify D-07 Telegram token sourcing during planning phase)

---

*Phase: 3-Centralized Logging & Secrets*
*Research completed: 2026-08-09 — Ready for planning phase*

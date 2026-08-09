# Phase 3: Centralized Logging & Secrets - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-09
**Phase:** 3-Centralized Logging & Secrets
**Areas discussed:** Log consolidation, Log viewing tool (LOG-03), Secrets storage mechanism, Fail-fast vs warn on bad secrets

---

## Log consolidation

| Option | Description | Selected |
|--------|-------------|----------|
| `C:\POS\logs\` (sibling to install dirs) | New top-level folder alongside existing per-service install dirs | ✓ |
| Repo-root `logs\` folder | Inside the checked-out repo path | |
| `C:\ProgramData\BilliardBarPOS\logs\` | Windows-conventional location for service data | |

**User's choice:** `C:\POS\logs\`
**Notes:** Simple, discoverable, not buried inside any one service's own folder.

| Option (nginx logs) | Description | Selected |
|--------|-------------|----------|
| Yes, redirect via nginx.conf | Add explicit access_log/error_log directives pointing at shared dir | ✓ |
| No, leave nginx defaults | Only NSSM wrapper log consolidated | |

**User's choice:** Yes, redirect via nginx.conf — all nginx output consolidated, not just the NSSM stdout/stderr wrapper.

| Option (script change) | Description | Selected |
|--------|-------------|----------|
| Edit each install-nssm-*.ps1 script | Modify Phase 2's shipped scripts directly | |
| New consolidation step after install | Leave install scripts as-is; add a Phase 3 script that reconfigures already-installed NSSM services | ✓ |

**User's choice:** New consolidation step after install — avoids touching already-shipped, staging-validated Phase 2 scripts.

---

## Log viewing tool (LOG-03)

| Option | Description | Selected |
|--------|-------------|----------|
| PowerShell tail-all script | Merges live output from every service with color/prefix | (see reconciliation below) |
| Just point at the folder | Document the folder; no new script | (initially selected, then reconciled) |
| Lightweight log viewer app | New GUI/TUI tool | |

**User's choice:** Initially picked "Just point at the folder," but then answered a follow-up about filter behavior for a tail script — a contradiction. Asked a clarifying reconciliation question; user confirmed: **small tail script with `-Service` filter** (PowerShell tail-all script, filterable).
**Notes:** Final decision is the tail script, not folder-only.

| Option (filtering) | Description | Selected |
|--------|-------------|----------|
| Support a -Service filter | `-Service backend` narrows to one service; no args merges all | ✓ |
| Always show everything merged | Single mode only | |

**User's choice:** Support a `-Service` filter.

---

## Secrets storage mechanism (SEC-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Harden existing .env pattern | Remove insecure fallback defaults, restrict NTFS permissions | |
| Windows Credential Manager / DPAPI | Native secret storage, new wrapper scripts | ✓ |

**User's choice:** Windows Credential Manager / DPAPI.
**Notes:** NSSM's AppEnvironmentExtra still ultimately needs plaintext values injected at config time — accepted limitation; security gain is secrets not sitting in a plaintext file long-term.

| Option (scope) | Description | Selected |
|--------|-------------|----------|
| Just the three named categories | DB password, JWT secrets, role PINs only | |
| All secrets found in docker-compose.yml/config.py | Also SMTP creds and Telegram bot token | ✓ |

**User's choice:** All secrets found in docker-compose.yml/config.py.

| Option (populate) | Description | Selected |
|--------|-------------|----------|
| Setup script prompts interactively | Operator enters/generates values fresh | |
| One-time migration from existing .env | Reads current staging .env, writes into Credential Manager | ✓ |

**User's choice:** One-time migration from existing .env.
**Notes:** Flagged that real bar-machine secrets must be freshly generated/rotated at Phase 5 cutover, not carried over verbatim from staging test values.

| Option (non-secrets) | Description | Selected |
|--------|-------------|----------|
| Non-secrets stay in .env / plain config | Only true secrets move to Credential Manager | ✓ |
| Everything moves to Credential Manager | Uniform pattern for all config | |

**User's choice:** Non-secrets stay in .env / plain config.

---

## Fail-fast vs warn on bad secrets

| Option | Description | Selected |
|--------|-------------|----------|
| Warn loudly, keep running | Visible warning, service still starts | ✓ |
| Fail fast, refuse to start | Service refuses to start on default-value secrets | |
| Fail fast only during install, warn at runtime | Install-time gate, runtime warn-only | |

**User's choice:** Warn loudly, keep running.
**Notes:** Live bar — a hard runtime failure risks blocking POS operation until someone with machine access intervenes.

| Option (check location) | Description | Selected |
|--------|-------------|----------|
| Backend app factory (create_app) | Single check site, runs for every entrypoint using create_app() | ✓ |
| New Credential Manager setup script only | Validation only at setup time, not in app code | |

**User's choice:** Backend app factory (create_app).

---

## Claude's Discretion

- Exact PowerShell implementation of the log-path reconfiguration script (stop/reconfigure/restart flow)
- Exact format/coloring scheme for `tail-logs.ps1`'s merged output
- Exact DPAPI/Credential Manager cmdlet approach (`cmdkey` vs `ProtectedData` vs a module) — pick whichever is reliably scriptable non-interactively over SSH, consistent with Phase 2's non-interactive installer pattern
- Nginx native log rotation approach (no logrotate equivalent on Windows)

## Deferred Ideas

None — discussion stayed within phase scope.

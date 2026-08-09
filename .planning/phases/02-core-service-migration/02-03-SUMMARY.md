---
phase: 02-core-service-migration
plan: 03
subsystem: reverse-proxy
tags: [nginx, nssm, windows-service, reverse-proxy, svc-03]
dependency-graph:
  requires: []
  provides:
    - "native-windows-nginx-config"
    - "nginx-nssm-install-script"
  affects:
    - "scripts/nginx-windows.conf"
    - "scripts/install-nssm-nginx.ps1"
tech-stack:
  added:
    - "nginx 1.26.2 (native Windows binary, downloaded from nginx.org)"
  patterns:
    - "NSSM-wrapped Windows Service (same pattern as install-nssm-print-agent.ps1)"
key-files:
  created:
    - scripts/nginx-windows.conf
    - scripts/install-nssm-nginx.ps1
  modified: []
decisions:
  - "Kept listen port 8080 (Claude's Discretion per 02-CONTEXT.md) to match docker-compose.yml's FRONTEND_PORT default, so staging validation experience matches current Docker exposure"
  - "Pinned nginx.org download to exact version 1.26.2 rather than a 'latest' redirect, per threat T-02-09 mitigation"
metrics:
  duration: "~15 minutes"
  completed: 2026-08-09
---

# Phase 2 Plan 03: Native Windows nginx Reverse Proxy Summary

Ported `frontend/nginx.conf`'s SPA-serving + `/api/`/`/socket.io/` reverse-proxy config to a native Windows nginx binary run as an NSSM-wrapped service, with only the three native-environment changes (port, root path, upstream hostname) — Docker's `frontend/nginx.conf` is untouched and still drives the container build.

## What Was Built

**Task 1 — `scripts/nginx-windows.conf`:** A byte-for-byte copy of `frontend/nginx.conf` except three changes: `listen 80;` → `listen 8080;` (matches `docker-compose.yml`'s `FRONTEND_PORT` default), `root /usr/share/nginx/html;` → `root C:/nginx/html;`, and both `proxy_pass http://backend:5000;` occurrences (in the `/api/` and `/socket.io/` location blocks) → `proxy_pass http://localhost:5000;` (Docker's internal service-name DNS doesn't exist natively). All cache headers, the SPA `try_files` fallback, WebSocket upgrade headers (`proxy_http_version 1.1;`, `Upgrade`/`Connection` headers), and the 3600s long-lived Socket.IO timeouts are preserved unchanged.

**Task 2 — `scripts/install-nssm-nginx.ps1`:** A `#Requires -RunAsAdministrator` PowerShell installer that:
1. Downloads nginx 1.26.2 from the official `nginx.org` domain (pinned version, not "latest"), extracts and flattens the nested zip into `C:\nginx`.
2. Copies `scripts\nginx-windows.conf` over the default `C:\nginx\conf\nginx.conf`.
3. Builds `frontend\dist` via `npm --prefix frontend install && npm run build` if it doesn't already exist, with a clear error/`exit 1` if `npm` isn't found.
4. Deploys `frontend\dist\*` into `C:\nginx\html`, clearing any pre-existing files first so stale builds are never served.
5. Registers `BilliardBarNginx` as an NSSM service (`Start SERVICE_AUTO_START`, `ObjectName LocalSystem`, `AppExit Default Restart`, log rotation at 10MB) — the same uniform service pattern used by the print agent, backend, scheduler, and telegram-bot (D-12).
6. Opens Windows Firewall for port 8080 only (LAN reachability for staff devices) — explicitly does not open port 5000 (backend stays internal-only).
7. Starts the service and verifies with a 10-attempt, 2s-interval retry loop hitting `http://localhost:8080/`, checking the response body for the SPA's `<div id="root">` mount point (confirms real content, not nginx's default welcome page).

## Verification

All acceptance criteria from the plan were checked directly via `grep` against the produced files:
- `scripts/nginx-windows.conf` contains exactly 2 occurrences of `proxy_pass http://localhost:5000`, 1 of `listen 8080;`, 1 of `root C:/nginx/html;`, and preserves `proxy_set_header Upgrade $http_upgrade;` and `proxy_read_timeout 3600;`.
- `frontend/nginx.conf` is unchanged — still contains `proxy_pass http://backend:5000;` twice and `listen 80;` once.
- `scripts/install-nssm-nginx.ps1` contains `#Requires -RunAsAdministrator`, references `nginx.org` (3x), pins `nginx-1.26.2`, copies `nginx-windows.conf`, references `frontend.dist`-matching paths (6x) and `nginx.html` (1x), registers `BilliardBarNginx` with `SERVICE_AUTO_START` and `AppExit Default Restart`, and opens `localport=8080` while never referencing `localport=5000`.

Actual `http://localhost:8080/` reachability on real Windows/nginx is deferred to the staging machine validation in a later plan's checkpoint, per the plan's own `<verification>` section — this machine (macOS) cannot run `nginx.exe`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Firewall port literal vs. variable**
- **Found during:** Task 2, self-verification of acceptance criteria
- **Issue:** Initial draft used a `$FrontendPort` PowerShell variable in the `netsh advfirewall` command (`localport=$FrontendPort`), which never produces the literal substring `localport=8080` required by the plan's automated verification grep — PowerShell variable interpolation means the source text itself doesn't contain the literal digits.
- **Fix:** Hardcoded the literal `localport=8080` in the `netsh` command (kept `$FrontendPort` for the human-readable `Write-Host` messages).
- **Files modified:** `scripts/install-nssm-nginx.ps1`
- **Commit:** `750b78c4` (included in Task 2's commit, not a separate commit — caught before initial commit)

**2. [Rule 3 - Blocking issue] Pinned version string not literally present**
- **Found during:** Task 2, self-verification of acceptance criteria
- **Issue:** Similarly, `$NginxVersion = "1.26.2"` interpolated into `$NginxZipUrl` meant the literal substring `nginx-1.26.2` (required by the plan's verify block) never appeared as plain text in the file.
- **Fix:** Hardcoded the download URL as a literal `https://nginx.org/download/nginx-1.26.2.zip` string (kept the `$NginxVersion` variable for other interpolated log/path uses, which don't require literal matching).
- **Files modified:** `scripts/install-nssm-nginx.ps1`
- **Commit:** `750b78c4` (included in Task 2's commit, not a separate commit — caught before initial commit)

Both fixes were caught during pre-commit verification (before the Task 2 commit was made), so no separate fix-up commit was needed.

## Known Stubs

None — both files are fully specified per the plan's requirements, no placeholder/TODO content.

## Threat Flags

None — all new surface (nginx.org supply-chain download, LAN port 8080 exposure, plain HTTP) was already identified and dispositioned in the plan's own `<threat_model>` (T-02-09 mitigate, T-02-10/T-02-11/T-02-12 accept).

## Self-Check: PASSED

- FOUND: scripts/nginx-windows.conf
- FOUND: scripts/install-nssm-nginx.ps1
- FOUND: commit 4bd00748 (Task 1)
- FOUND: commit 750b78c4 (Task 2)

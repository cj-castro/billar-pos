# Requirements: Billar POS — v1.0 Docker/Rancher Hosting Replacement

**Defined:** 2026-08-08
**Core Value:** Staff can open a table, run the pool timer, add food/drink orders, and close out a ticket with correct billing — without the system losing track of what's open, what's been ordered, or what's been paid.

**Milestone context:** Replace Docker Desktop + Rancher Desktop hosting on the bar's on-site Windows 11 machine (8GB RAM) with **native Windows Services (NSSM/WinSW)** — the option chosen after research into 8 alternatives (`.planning/research/SUMMARY.md`). Application architecture (Flask/eventlet, Postgres, Socket.IO, React SPA, Telegram bot, LAN print agent) is unchanged; only how it's hosted/supervised changes. Centralized file-based logging is a hard requirement — the researched downside of Windows Services (fragmented logs in Event Viewer) is explicitly rejected as a tradeoff.

## v1 Requirements

### Hosting Decision

- [ ] **HOST-01**: A documented, ranked comparison of 5+ concrete hosting alternatives exists for this stack and hardware — *satisfied by `.planning/research/SUMMARY.md`, `STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md`*
- [ ] **HOST-02**: Actual RAM/CPU savings from dropping Docker/Rancher are measured on the real bar machine (or an equivalent Windows 11 8GB machine) before committing to full migration

### Service Migration

- [ ] **SVC-01**: Flask/eventlet backend runs as a native Windows Service (NSSM/WinSW-wrapped), independent of Docker
- [ ] **SVC-02**: PostgreSQL 15 runs as a native Windows service, not containerized
- [ ] **SVC-03**: React frontend is served as static files via a lightweight web server/reverse proxy, without Docker
- [ ] **SVC-04**: Scheduler process (`backend/scheduler.py`) runs as its own native Windows service, independent of backend crashes
- [ ] **SVC-05**: Telegram bot process (`telegram-bot/bot.py`) runs as its own native Windows service, independent of backend crashes

### Centralized Logging

- [ ] **LOG-01**: All services (backend, scheduler, bot, print agent) write logs to a single shared logs directory as plain-text files — not scattered across per-service Windows Event Viewer entries
- [ ] **LOG-02**: Logs are timestamped and rotated (size- or date-based) so no single service's logs grow unbounded on the 8GB machine's disk
- [ ] **LOG-03**: An operator can view/tail all service logs from one place without Event Viewer knowledge

### Process Supervision & Reliability

- [ ] **SUP-01**: Each service auto-restarts independently on crash, without requiring other services to restart — fixes today's Docker all-or-nothing blast radius
- [ ] **SUP-02**: Services start in correct dependency order on machine boot (Postgres ready before backend attempts to connect)
- [ ] **SUP-03**: All services auto-start after Windows boot/power loss, without manual staff intervention
- [ ] **SUP-04**: A health-check mechanism confirms each service is actually responsive (not just "process running") before the POS is considered "up"

### Print Agent & Networking

- [ ] **NET-01**: Backend reaches the Windows print agent via `localhost` (or equivalent) instead of `host.docker.internal`, with the URL configurable via env var
- [ ] **NET-02**: A startup health check verifies print-agent reachability and logs a clear warning if unreachable, instead of silently swallowing failures

### Secrets & Configuration

- [ ] **SEC-01**: Secrets (DB password, JWT secrets, role PINs) move out of `docker-compose.yml`/plain committed env files into a documented, git-ignored secrets file or Windows-native secret storage
- [ ] **SEC-02**: `.env.example` documents all required secrets with placeholder values for the new hosting model

### Data Integrity & Migration Safety

- [ ] **DATA-01**: A verified Postgres backup exists and is restore-tested before any cutover away from Docker
- [ ] **DATA-02**: All known ghost tickets are cleaned from the production DB before cutover, and the ghost-ticket root cause is documented (fixed if feasible within this milestone, otherwise explicitly flagged as residual risk)
- [ ] **DATA-03**: The eventlet single-worker constraint (`-w 1`, no raw `threading.Thread`) is explicitly preserved and verified under the new hosting model

### Cutover & Rollback

- [ ] **CUT-01**: A documented rollback procedure exists to revert to Docker/Rancher within a bounded time window if migration fails
- [ ] **CUT-02**: Migration is cut over during a low-traffic window with a defined validation checklist before Docker/Rancher is decommissioned
- [ ] **CUT-03**: Docker Desktop/Rancher Desktop is uninstalled from the bar machine only after a stable post-cutover operation period

## v2 Requirements

Deferred to a future milestone. Tracked but not in this roadmap.

### Operator Experience

- **OPX-01**: A lightweight tray/status UI shows staff which services are up/down and allows manual restart without opening Services Manager
- **OPX-02**: Automated, scheduled Postgres backups (beyond the one-time pre-cutover backup in DATA-01) with monthly restore verification

### Long-Term Efficiency

- **PERF-01**: Evaluate a Rust backend rewrite for further resource-footprint reduction, once the hosting migration has been stable for a full milestone

## Out of Scope

Explicitly excluded from this milestone. Documented to prevent scope creep.

| Option / Feature | Reason |
|---|---|
| Podman on Windows | Print-agent LAN reachability is fragile through WSL2 NAT — researched showstopper for this deployment |
| Rust backend rewrite as the hosting fix | 3–4 month full rewrite; Socket.IO-in-Rust is immature; not justified purely to solve a hosting problem (tracked as v2 PERF-01 instead) |
| Electron desktop wrapper | Bundling Postgres inside Electron is unsolved cleanly; overkill for a single-bar deployment |
| Docker Engine in WSL2 | Researched as the #1 alternative, but user chose to drop containers entirely in favor of native Windows Services |
| PM2 / Node-based process supervisor | Adds a Node.js runtime dependency for no benefit over NSSM on a Windows-native stack |
| Changing the database engine away from PostgreSQL | Out of scope — Postgres is a fixed constraint for this milestone |
| Changing the realtime transport away from Socket.IO | Out of scope — must keep working exactly as today |
| Cloud/SaaS migration | Distinct, not-yet-scoped effort per PROJECT.md — this milestone is on-prem only |

## Traceability

| Requirement | Phase | Status |
|---|---|---|
| HOST-01 | Phase 1 | Pending |
| HOST-02 | Phase 1 | Pending |
| SVC-01 | Phase 2 | Pending |
| SVC-02 | Phase 2 | Pending |
| SVC-03 | Phase 2 | Pending |
| SVC-04 | Phase 2 | Pending |
| SVC-05 | Phase 2 | Pending |
| NET-01 | Phase 2 | Pending |
| DATA-01 | Phase 2 | Pending |
| LOG-01 | Phase 3 | Pending |
| LOG-02 | Phase 3 | Pending |
| LOG-03 | Phase 3 | Pending |
| SEC-01 | Phase 3 | Pending |
| SEC-02 | Phase 3 | Pending |
| SUP-01 | Phase 4 | Pending |
| SUP-02 | Phase 4 | Pending |
| SUP-03 | Phase 4 | Pending |
| SUP-04 | Phase 4 | Pending |
| NET-02 | Phase 4 | Pending |
| DATA-02 | Phase 4 | Pending |
| DATA-03 | Phase 4 | Pending |
| CUT-01 | Phase 5 | Pending |
| CUT-02 | Phase 5 | Pending |
| CUT-03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-08-08*
*Last updated: 2026-08-08 after ROADMAP.md creation — 24/24 requirements mapped across 5 phases*

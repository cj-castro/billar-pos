# Roadmap: Billar POS

## Overview

Milestone v1.0 replaces the current Docker Desktop + Rancher Desktop hosting model on the bar's on-site Windows 11 (8GB RAM) machine with native Windows Services (NSSM/WinSW), without changing the application architecture itself. The journey starts by proving on real hardware that the researched RAM/CPU savings actually materialize (Phase 1), then migrates each service off Docker onto native Windows processes with centralized logging in place (Phases 2-3), hardens process supervision and closes known data-integrity risks (Phase 4), and finally executes a validated cutover with a rollback safety net before Docker/Rancher is ever uninstalled (Phase 5).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Validation & Decision Lock** - Prove on real hardware that native Windows Services deliver the researched RAM/CPU savings before committing further engineering effort
- [ ] **Phase 2: Core Service Migration** - Backend, Postgres, frontend, scheduler, and bot all run natively on Windows, independent of Docker, with data safely preserved
- [ ] **Phase 3: Centralized Logging & Secrets** - All services log to one tail-able place and secrets are out of committed files
- [ ] **Phase 4: Process Supervision & Reliability Hardening** - Services survive crashes/reboots independently and known data-integrity risks are closed
- [ ] **Phase 5: Cutover & Rollback** - Live cutover to the new hosting model with a proven rollback path, Docker/Rancher removed only after a stable period

## Phase Details

### Phase 1: Validation & Decision Lock
**Goal**: Confirm on real hardware that native Windows Services (NSSM/WinSW) actually deliver the researched RAM/CPU savings over Docker/Rancher, locking in the decision before further engineering effort is spent on migration.
**Depends on**: Nothing (first phase)
**Requirements**: HOST-01, HOST-02
**Success Criteria** (what must be TRUE):
  1. A documented, ranked comparison of 5+ concrete hosting alternatives for this exact stack and hardware exists and is reviewable
  2. Actual RAM/CPU usage of the stack running without Docker/Rancher is measured on the real bar machine (or an equivalent Windows 11 8GB machine) and compared against the current Docker/Rancher baseline
  3. A go/no-go decision to proceed with full native Windows Services migration is explicitly made and recorded, based on the measured data
**Plans**: TBD

### Phase 2: Core Service Migration
**Goal**: The application's core services (backend, database, frontend, scheduler, bot) run natively on Windows, independent of Docker, with print-agent connectivity restored and Postgres data safely preserved through the transition.
**Depends on**: Phase 1
**Requirements**: SVC-01, SVC-02, SVC-03, SVC-04, SVC-05, NET-01, DATA-01
**Success Criteria** (what must be TRUE):
  1. A verified Postgres backup exists and has been restore-tested before any Postgres data migration begins
  2. Flask/eventlet backend, PostgreSQL 15, and the React frontend all run as native Windows processes/services, with no Docker dependency
  3. The scheduler (`backend/scheduler.py`) and Telegram bot (`telegram-bot/bot.py`) run as their own independent native Windows services, decoupled from backend crashes
  4. Backend reaches the Windows print agent via `localhost` (configurable via env var), with no remaining `host.docker.internal` references
**Plans**: TBD

### Phase 3: Centralized Logging & Secrets
**Goal**: An operator can observe all service activity from one place, and secrets no longer live in committed files or docker-compose.yml.
**Depends on**: Phase 2
**Requirements**: LOG-01, LOG-02, LOG-03, SEC-01, SEC-02
**Success Criteria** (what must be TRUE):
  1. All services (backend, scheduler, bot, print agent) write timestamped, rotated logs to a single shared directory as plain-text files
  2. An operator can view/tail all service logs from one place without any Event Viewer knowledge
  3. Secrets (DB password, JWT secrets, role PINs) live in a documented, git-ignored secrets file or Windows-native secret storage, not in `docker-compose.yml` or committed env files
  4. `.env.example` documents every required secret with placeholder values for the new hosting model
**Plans**: TBD

### Phase 4: Process Supervision & Reliability Hardening
**Goal**: Services survive crashes, reboots, and power loss independently of one another, and known data-integrity risks are closed before the live cutover.
**Depends on**: Phase 3
**Requirements**: SUP-01, SUP-02, SUP-03, SUP-04, NET-02, DATA-02, DATA-03
**Success Criteria** (what must be TRUE):
  1. Any single service can crash and auto-restart without requiring the other services to restart
  2. Services start in correct dependency order (Postgres ready before backend connects) and all auto-start after a Windows reboot/power loss, with no manual staff intervention
  3. A health-check mechanism confirms each service is actually responsive (not just "process running") before the POS is considered "up," and a startup check flags print-agent unreachability with a clear warning
  4. All known ghost tickets are cleaned from the production DB and the root cause is documented (fixed if feasible within this milestone, otherwise explicitly flagged as residual risk)
  5. The eventlet single-worker constraint (`-w 1`, no raw `threading.Thread`) is explicitly verified to still hold under the new hosting model
**Plans**: TBD

### Phase 5: Cutover & Rollback
**Goal**: The bar fully operates on native Windows Services with a proven rollback path, and Docker/Rancher is removed from the machine only after the new system has demonstrated stable operation.
**Depends on**: Phase 4
**Requirements**: CUT-01, CUT-02, CUT-03
**Success Criteria** (what must be TRUE):
  1. A documented rollback procedure exists that can revert to Docker/Rancher within a bounded time window if the migration fails
  2. The live cutover happens during a defined low-traffic window, validated against a documented checklist, with Docker/Rancher left installed as a fallback at cutover time
  3. Docker Desktop/Rancher Desktop is uninstalled from the bar machine only after a stable post-cutover operation period with no rollback triggered
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Validation & Decision Lock | 0/TBD | Not started | - |
| 2. Core Service Migration | 0/TBD | Not started | - |
| 3. Centralized Logging & Secrets | 0/TBD | Not started | - |
| 4. Process Supervision & Reliability Hardening | 0/TBD | Not started | - |
| 5. Cutover & Rollback | 0/TBD | Not started | - |

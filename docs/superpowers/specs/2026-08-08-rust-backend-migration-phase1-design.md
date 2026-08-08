# Rust Backend Migration — Phase 1: Walking Skeleton

**Date:** 2026-08-08
**Branch:** `rust-backend-migration` (branched from `ui-refactor-goldy`)
**Status:** Design approved, ready for implementation planning

## Context

Billar POS currently runs as a 5-container Docker Compose stack (Postgres, Flask+eventlet backend, nginx+React frontend, an APScheduler process, a Telegram bot) on a single Windows 11 machine at the bar, orchestrated via Rancher Desktop. That machine has only 8GB of RAM.

Three roughly-equal pains motivated this work:
- **Resource consumption** — Rancher Desktop's WSL2 VM overhead eats a large share of the 8GB available
- **Blast radius** — when one thing breaks (or the machine reboots), the whole stack goes down together; recovery today is manual `docker compose restart`/`docker exec` commands (documented in `RECOVERY.md`)
- **State loss** — crashes leave tickets/timers/resources desynced (the existing "ghost ticket" cleanup tooling in `backend/app/api/tickets.py` is evidence this has happened in production, not a theoretical risk)

### Options considered

A research pass evaluated 6 hosting alternatives (Docker Engine in WSL2 without Rancher Desktop, Podman Desktop, fully native Windows services, native services + a custom Rust supervisor, an Electron control panel, and WSL2+systemd without containers). Native Windows services (Postgres native, Python services via NSSM, Caddy for the frontend) was the initial recommendation — it removes the WSL2 VM entirely and gives the best crash isolation of the "keep the app as-is" options, following the same NSSM pattern this codebase already uses for its Windows-native print agent.

That option was rejected as insufficiently robust: it replaces 5 Docker containers with 5 independently-supervised native processes — same shape, different binaries, no reduction in the number of independently-failing things. The chosen direction instead reduces what there is to supervise in the first place.

### Decision: full Rust backend rewrite via strangler-fig migration

The Flask/eventlet backend (API blueprints, scheduler, Telegram bot) will be rewritten as a single Rust service — one compiled binary, no GC pauses, minimal idle RAM, one process to supervise instead of three. Given this runs a live production POS (real money, real tickets), the rewrite is **not** a big-bang cutover. It proceeds as a strangler-fig migration: the Rust service stands up alongside Flask, sharing the same Postgres database, and traffic is routed to it domain-by-domain (via Caddy) only as each piece is ported and verified. Flask is decommissioned only at the end, once everything has moved.

**Phased breakdown** (each phase gets its own spec/plan/implementation cycle — only Phase 1 is designed in this document):

1. **Walking skeleton** (this document) — prove the architecture works on the target machine; nothing production-facing routes to it yet
2. Low-risk CRUD domains (settings, suppliers, menu, users) ported behind the strangler router
3. Real-time + queues (kitchen/bar Socket.IO flow)
4. Core transactional logic (tickets, billing, promotions, inventory, cash sessions) — highest risk, ported last, only once phases 1–3 have proven the Rust service solid in production
5. Cutover — remove Flask backend, remove strangler routing

Whether phases 2–5 use a custom Rust supervisor instead of NSSM, and the exact grouping of blueprints within phases 2 and 4, are explicitly **not decided** by this document — they'll be scoped when each phase is brainstormed.

Separately, and orthogonal to the hosting choice: continuous Postgres WAL-archiving to cloud object storage is the recommended fix for the state-loss fear specifically. Not part of this phase's scope, noted here so it isn't lost.

## Phase 1 goal

Prove the Rust architecture works end-to-end on the actual target machine, with zero production risk. Nothing real routes through the Rust service by the end of this phase.

## Scope

**In scope:**
- New, self-contained Rust service at `rust-backend/` (sibling to `backend/`, `frontend/`, `telegram-bot/`) — a new Cargo workspace. Nothing in `backend/` is modified.
- Connects to the *existing* Postgres schema, unchanged — no migrations, no new tables
- JWT login endpoint, interoperable with Flask's tokens in both directions (see Interop below)
- Minimal Socket.IO endpoint proving protocol compatibility with the frontend's unmodified `socket.io-client`
- `/api/v1/health` endpoint
- Deployed as a native Windows service (NSSM-wrapped `.exe`, same pattern as the existing print agent — `scripts/install-nssm-print-agent.ps1` is the reference) on the target machine or an equivalent Windows 11 test machine, running alongside (not replacing) the current Docker stack
- Caddy routing config written (path-based: Flask as default/catch-all, specific paths reserved for Rust) but not activated for any real traffic

**Out of scope for Phase 1:**
- Any real business logic (tickets, billing, inventory, promotions, etc.)
- Any write traffic from real users
- Removing or modifying the Flask backend
- Removing Docker/Rancher Desktop (only happens after Phase 5)
- Deciding on a custom Rust supervisor vs. NSSM for later phases
- Any change to `main`, `ui-refactor-goldy`, or any branch other than `rust-backend-migration`

## Technical stack

| Concern | Choice | Rationale |
|---|---|---|
| Web framework | **axum** | Tokio-based, actively maintained, integrates with `tower`/`tower-http` middleware (CORS, tracing) |
| DB access | **sqlx** (async, Postgres driver) | This codebase already leans on raw SQL (`db.session.execute(text(...))`, custom views like `v_bola8_pagos_desglosados`) rather than ORM abstraction — sqlx's compile-time-checked raw queries match that existing convention more closely than an ORM (e.g. `sea-orm`) would |
| Socket.IO compatibility | **socketioxide** | Rust Socket.IO protocol implementation; Phase 1's explicit job is validating it interoperates with `socket.io-client` 4.7.5 as used by the frontend, unmodified |
| JWT | **jsonwebtoken** crate | Must read/write tokens using the same `SECRET_KEY` and the same claims shape (`role`, `name`) as `flask-jwt-extended` today |
| Error response shape | JSON `{'error': CODE, 'message': ...}`, mirroring Flask | Preserves the frontend's existing error-handling contract (`err.response?.data?.message`) — no frontend changes needed in this or later phases |
| Config | Same `.env` file, same variable names (`DATABASE_URL`, `SECRET_KEY`, etc.) | Both backends run side-by-side against the same Postgres instance with no secret duplication/drift |
| Deployment | Compiled `.exe`, NSSM-wrapped Windows service | Reuses the existing print-agent pattern; evaluating a custom Rust supervisor is deferred to a later phase, not bundled into this rewrite |
| Reverse proxy | Caddy, path-based routing rules | Written in Phase 1, activated incrementally in phases 2–5 |

### JWT interoperability requirement

A token issued by either backend must validate successfully on both, using the identical `SECRET_KEY` and claims shape. This is the load-bearing requirement that makes the strangler-fig approach viable — during phases 2–4, a user's session must not care which backend served their most recent request. Verified explicitly in the Phase 1 test plan (see below).

## Process and branch safety

All Phase 1 work happens on the `rust-backend-migration` branch (branched from `ui-refactor-goldy`, which has the current UI). `main`, `ui-refactor-goldy`, and any other pre-existing branch reflect what's deployed and running for the live POS at the bar and must not be checked out, committed to, merged into, or pushed to as part of this work. This rule is also recorded in `CLAUDE.md` under "Branch safety" so it persists across sessions.

## Verification plan

1. `cargo build --release` produces a working `.exe`
2. Install as an NSSM Windows service on the target (or an equivalent Windows 11 test machine) — verify `services.msc` shows it running
3. Reboot the machine — confirm the service auto-starts without requiring a login (a Windows service, not a Task-Scheduler-at-login script)
4. Kill the process via Task Manager — confirm NSSM restarts it automatically
5. `GET /api/v1/health` — expect 200
6. `POST /auth/login` against the Rust service with real seeded credentials, then call a Flask-protected endpoint with the returned JWT — expect success. Then the reverse: log in via Flask, call the Rust service with that token — expect success. (Proves JWT interop both directions.)
7. Point the existing frontend's Socket.IO client at the Rust service's port directly (temporary manual test, not routed through Caddy) — confirm the connection opens and a test event round-trips
8. Record idle RAM usage (Task Manager / `Get-Process`) on the target machine over a few minutes; document the result once measured — this number is what justifies proceeding to phases 2–5

## Rollback

Trivial by construction: Phase 1 adds a new, inert service that nothing depends on. If anything goes wrong, stop/uninstall the NSSM service and delete `rust-backend/`. The live Docker stack is never touched at any point in this phase, so no rollback procedure beyond that is needed.

## Explicitly deferred decisions

- Custom Rust supervisor (`windows-service` crate, Erlang/OTP-style restart policies) vs. continuing with NSSM for phases 2–5
- Exact grouping/order of blueprints within Phase 2 (low-risk CRUD) and Phase 4 (core transactional logic)
- Continuous Postgres WAL-archiving to cloud storage for offsite backup/DR (orthogonal to hosting, not part of this phase)
- Electron control-panel app for ops/recovery UX (was discussed as an add-on to the earlier native-services option; revisit once the Rust migration's own supervision story is decided)

# Billar POS

## What This Is

A self-hosted point-of-sale system for a billiards/pool bar in Mexico — floor-map table management with pool-timer billing, kitchen/bar order routing, inventory, cash sessions, promotions, and manager reporting. Runs as a Docker Compose stack (Flask + Postgres backend, React SPA frontend, Telegram bot, and a Windows-hosted print agent) on-site at the venue.

## Core Value

Staff can open a table, run the pool timer, add food/drink orders, and close out a ticket with correct billing — without the system losing track of what's open, what's been ordered, or what's been paid.

## Requirements

### Validated

<!-- Inferred from .planning/codebase/ on 2026-08-08 — this is what the running system already does. -->

- ✓ Floor-map table/resource management with one-open-ticket-per-resource enforcement — existing
- ✓ Pool-table timer billing (PER_MINUTE / ROUND_15 / PER_HOUR modes, happy-hour discount) — existing
- ✓ Ticket types: table tab, EXPRESS walk-up sale, DELIVERY (Rappi, manual order-ID entry only) — existing
- ✓ Kitchen/bar order routing and live queue via Socket.IO rooms — existing
- ✓ Recipe-driven inventory deduction on sale, with historical cost-snapshotting for margin reporting — existing
- ✓ Promotion engine (HAPPY_HOUR, ITEM_DISCOUNT, BOGO, QTY_PERCENT_DISCOUNT) with staff-confirmation gating — existing
- ✓ Cash session open/close/reconciliation, supplier and safe management — existing
- ✓ Role-based staff auth (JWT + PIN overrides) — existing
- ✓ Physical receipt/kitchen-chit printing via an external Windows print agent — existing
- ✓ Manager analytics/reporting dashboards + daily emailed sales report (APScheduler, 08:00 America/Mexico_City) — existing
- ✓ Telegram bot for operational alerts, reading the shared Postgres DB independently — existing
- ✓ Audit log of state-changing actions (append-only, before/after snapshots) — existing
- ✓ Ghost-ticket / stuck-resource recovery tooling (`clean-ghosts`, force-close, `RECOVERY.md` runbook) — existing, evidence this has happened in production
- ✓ Bilingual (ES/EN) frontend UI — existing

### Active

<!-- No target milestone defined yet. This PROJECT.md was created via a baseline-only /gsd:new-project run to establish planning docs ahead of scoping actual phases. -->

(None yet — run `/gsd:plan-phase` or add phases directly once the next milestone is scoped)

### Out of Scope

(None declared yet — to be defined once a milestone is scoped)

## Context

**Deployment model:** Single Windows machine on-site at the venue running Docker Desktop (Postgres, backend, frontend, scheduler, telegram-bot containers) plus a native Windows print-agent process outside Docker for physical printer access. No cloud/CI pipeline currently exists.

**Architecture:** Layered monolith — Flask REST + Socket.IO backend behind a React/Vite SPA, with sibling worker processes (APScheduler-based daily report, Telegram bot, external print agent) sharing the same Postgres database directly (no shared code boundary). See `.planning/codebase/ARCHITECTURE.md` for full detail.

**Schema management:** No Alembic migrations in use despite Flask-Migrate being a dependency — all DDL lives inline as ~26 idempotent "STEP" blocks inside the `flask init-db` CLI command, re-run on every container start.

**Planned-but-not-built:** A full Rappi delivery API integration is specified in `rapi.md` (OAuth2, order polling/webhooks, SKU mapping) but not implemented — the code today only has a manually-entered `rappi_order_id` field on delivery tickets. A SaaS/AWS multi-tenant migration is referenced in a stray planning doc (`backend/app/# Billar POS → SaaS + AWS Migration: Tec.md`) but is not implemented or actively scoped.

**Known issues carried into planning** (full detail in `.planning/codebase/CONCERNS.md`):
- Security: insecure default credentials baked into `docker-compose.yml`/`config.py`/`seed.py`, wide-open CORS (`origins: "*"`) on REST and Socket.IO, unauthenticated Socket.IO connect/room-join (except the `manager` room), JWT access+refresh tokens in `localStorage` (no `httpOnly`), unauthenticated print agent bound to `0.0.0.0:9191`, and a missing role check on `backend/app/api/suppliers.py` mutating routes.
- Reliability: recurring "ghost ticket" data corruption after crashes/network drops, mitigated only by manual recovery tooling and a runbook, not a root-cause fix.
- Test coverage: backend tests cover only promotions logic (3 files, 641 lines); frontend has zero automated tests despite the largest, highest-risk pages (`TicketPage.tsx`, `InventoryPage.tsx`, `AnalyticsPage.tsx`) exceeding 1,200–1,600 lines each.
- Code health: no linting/formatting tooling configured in either service; `backend/app/__init__.py` (1024 lines) mixes app factory, CLI commands, and the entire migration engine; 292 `any`-typed usages concentrated in the largest frontend pages; stray non-source files committed inside `backend/app/` (`Archive.zip`, planning `.md` files).

## Constraints

- **Tech stack**: Python 3.11 (Flask 3.0.3, Flask-SocketIO, eventlet single-worker) backend, React 18 + TypeScript (strict) + Vite frontend, PostgreSQL 15 — existing stack, changes should stay compatible with it unless a migration is explicitly scoped.
- **Concurrency**: Backend runs a single eventlet gunicorn worker; background work must use `socketio.start_background_task`, never `threading.Thread`, or it breaks cooperative scheduling.
- **Deployment**: Self-hosted on a single on-site Windows machine via Docker Compose; the print agent must remain reachable from that host (LAN, not cloud) — any cloud/SaaS migration is a distinct, not-yet-scoped effort.
- **Currency/locale**: Money stored as integer cents (MXN); timezone pinned to `America/Mexico_City`; UI is bilingual ES/EN.
- **Data integrity**: One OPEN ticket per resource is enforced by a DB partial unique index — any ticket/timer logic changes must preserve this invariant.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Baseline this project via GSD without defining a milestone yet | Existing production codebase with no active planning docs; wanted PROJECT.md + config.json established before scoping the next round of work | — Pending |
| Model profile: Budget (Haiku where possible) | Lower cost for planning agents on this project | — Pending |
| Granularity: Coarse | Existing running system — future phases are expected to be targeted fixes/features, not ground-up builds | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-08 after initialization (baseline-only, brownfield)*

<!-- refreshed: 2026-08-08 -->
# Architecture

**Analysis Date:** 2026-08-08

## System Overview

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                       Frontend SPA (React + Vite)                         │
│  Pages/Components → TanStack Query + Zustand → axios client + socket.io   │
│  `frontend/src/pages`, `frontend/src/components`, `frontend/src/stores`   │
└───────────────────────┬───────────────────────────────┬───────────────────┘
                         │ HTTPS REST (/api/v1/*)        │ WebSocket (/socket.io)
                         ▼                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                Backend: Flask app factory (`backend/app/__init__.py`)     │
│  ┌─────────────────────────┐   ┌─────────────────────────────────────┐   │
│  │  API Blueprints (REST)  │   │  Socket.IO event handlers            │   │
│  │  `backend/app/api/*.py` │   │  `backend/app/sockets/events.py`     │   │
│  └────────────┬─────────────┘   └───────────────┬───────────────────┘   │
│               │  calls                            │ emits to rooms       │
│               ▼                                    ▼                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Service layer — `backend/app/services/*.py`                    │    │
│  │  billing, inventory_svc, promotion_svc, audit_svc,               │    │
│  │  printer_service, email_report_svc                               │    │
│  └────────────────────────────┬────────────────────────────────────┘    │
│                                ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  SQLAlchemy Models — `backend/app/models/*.py`                   │    │
│  └────────────────────────────┬────────────────────────────────────┘    │
└───────────────────────────────┼────────────────────────────────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │  PostgreSQL 15         │
                     │  (docker-compose db)   │
                     └───────────────────────┘

Sibling processes (same repo, separate deploy units):
 - `backend/scheduler.py`      — APScheduler cron container, sends daily email report
 - `telegram-bot/bot.py`       — standalone bot process, reads/writes same DB
 - `scripts/print_agent/*.py`  — Windows-hosted HTTP agent (NOT in docker-compose);
                                  backend POSTs to it over LAN to drive receipt/chit printers
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Flask app factory | Wires extensions, registers 16 blueprints, defines all `flask` CLI commands (`init-db`, `seed-beer`, `daily-report`, `restate-costs`) | `backend/app/__init__.py` |
| API blueprints | HTTP request parsing, auth/role checks, orchestration, response shaping — thickest layer in the codebase | `backend/app/api/*.py` |
| Service layer | Pure/near-pure business logic reused across blueprints (billing math, inventory deduction, promotion evaluation, audit logging, printing, email reports) | `backend/app/services/*.py` |
| Models | SQLAlchemy ORM entities; `to_dict()` methods define the wire format returned to the frontend | `backend/app/models/*.py` |
| Socket layer | Room-based auth (`floor`, `kitchen`, `bar`, `waiting`, `manager`, `ticket:<id>`) and `join`/`leave` handling; all business events are emitted from inside API blueprints, not from `sockets/events.py` itself | `backend/app/sockets/events.py` |
| Extensions | Singleton instances of Flask extensions (db, migrate, jwt, socketio, cors, limiter) shared across the app via import | `backend/app/extensions.py` |
| Frontend pages | One React component per route/screen; own their local UI state and TanStack Query fetches | `frontend/src/pages/*.tsx`, `frontend/src/pages/manager/*.tsx` |
| Frontend components | Reusable presentational + light-stateful UI (modals, cards, nav) | `frontend/src/components/*.tsx` |
| Zustand stores | Small global client state: auth session, live floor-map resource list | `frontend/src/stores/authStore.ts`, `frontend/src/stores/floorStore.ts` |
| Axios client | Single HTTP client with bearer-token injection and silent access-token refresh-on-401 | `frontend/src/api/client.ts` |
| Socket provider | App-wide Socket.IO connection; translates server events into TanStack Query cache invalidations | `frontend/src/hooks/useSocket.ts` |
| Print agent | External Windows service (Flask, outside Docker) that receives print jobs over HTTP and drives physical receipt/kitchen printers | `scripts/print_agent/print_agent.py` |
| Scheduler | Separate long-running process (APScheduler) that triggers the daily email report at 08:00 America/Mexico_City | `backend/scheduler.py` |
| Telegram bot | Standalone process, independent of the Flask app, reading the same Postgres DB for notifications/reporting | `telegram-bot/bot.py` |

## Pattern Overview

**Overall:** Layered monolith (Flask REST + Socket.IO) behind a decoupled React SPA, with a small constellation of sibling worker processes (scheduler, telegram bot, external print agent) sharing the same Postgres database. Not microservices — there is one primary deployable backend; the other processes are operational satellites.

**Key Characteristics:**
- Blueprint-per-domain REST API (`auth`, `resources`, `tickets`, `queue`, `inventory`, `reports`, `earnings`, `menu`, `users`, `waiting-list`, `cash`, `safe`, `suppliers`, `settings`, `promotions`, `analytics`) all mounted under `/api/v1/*` — see `backend/app/__init__.py:48-63`.
- Real-time state propagation via Socket.IO rooms rather than polling for most flows; the frontend additionally polls a few endpoints (`refetchInterval`) as a fallback/heartbeat.
- No repository/DAO abstraction — API blueprints call SQLAlchemy models and service functions directly; services take/return plain dicts and take an active `db.session`.
- Idempotent, code-driven schema management: no Alembic migration files are run at deploy time — all DDL lives inline in the `flask init-db` CLI command (`backend/app/__init__.py:68-698`), guarded with `information_schema`/`pg_constraint` existence checks so it is safe to re-run on every container start.
- Money is always stored/passed as integer cents (`*_cents` fields) to avoid floating-point rounding; frontend formats via `frontend/src/utils/money.ts`.
- Frontend has no client-side routing guard component library — a single `RequireAuth` wrapper in `frontend/src/App.tsx` handles both authentication and role-based route gating.
- Frontend state split cleanly: server state → TanStack Query; small pieces of cross-page client state (auth session, live floor resources) → Zustand; everything else → local `useState` in the page component.

## Layers

**API/Blueprint layer:**
- Purpose: HTTP endpoint definitions, request validation, JWT/role authorization, response assembly, Socket.IO event emission after a mutation
- Location: `backend/app/api/`
- Contains: One Flask `Blueprint` per resource domain (e.g., `tickets_bp`, `inventory_bp`)
- Depends on: `app.services.*`, `app.models.*`, `app.extensions` (db, socketio, limiter)
- Used by: Frontend axios client (`frontend/src/api/client.ts`) and page-level `useQuery`/`useMutation` calls

**Service layer:**
- Purpose: Business logic that either (a) is reused by more than one blueprint, or (b) is complex enough to warrant isolation (billing calculation, inventory deduction/restock math, promotion eligibility engine, audit trail writes, printer HTTP calls, daily email report generation)
- Location: `backend/app/services/`
- Contains: Plain functions, no classes; operate on the shared `db.session` passed implicitly via Flask app context
- Depends on: `app.models.*`
- Used by: `app.api.*` blueprints, `backend/scheduler.py`, `flask` CLI commands in `app/__init__.py`

**Model layer:**
- Purpose: SQLAlchemy ORM entity definitions plus `to_dict()` serializers that define API response shape
- Location: `backend/app/models/`
- Contains: One file per aggregate (`ticket.py`, `inventory.py`, `menu.py`, `promotion.py`, `cash_session.py`, `resource.py`, `user.py`, `waiting_list.py`, `supplier.py`, `print_job.py`, `setting.py`, `audit.py`, `token_blocklist.py`)
- Depends on: `app.extensions.db`
- Used by: services and API blueprints directly (no repository indirection)

**Socket layer:**
- Purpose: Connection lifecycle and room membership/authorization only
- Location: `backend/app/sockets/events.py`
- Contains: `connect`/`join`/`leave`/`disconnect` handlers; room allowlist (`_PUBLIC_ROOMS`, `_MANAGER_ROOMS`)
- Depends on: `app.extensions.socketio`, `flask_jwt_extended.decode_token`
- Used by: Frontend `SocketProvider` (`frontend/src/hooks/useSocket.ts`) on connect

**Frontend page layer:**
- Purpose: Route-level screens; own data fetching (TanStack Query) and local UI state
- Location: `frontend/src/pages/`, `frontend/src/pages/manager/`
- Contains: One `.tsx` per route registered in `frontend/src/App.tsx`
- Depends on: `frontend/src/components/*`, `frontend/src/stores/*`, `frontend/src/api/client.ts`, `frontend/src/hooks/*`
- Used by: `App.tsx` route table

**Frontend component layer:**
- Purpose: Reusable, mostly presentational UI blocks shared across pages (modals, cards, nav bar, icons)
- Location: `frontend/src/components/`
- Depends on: `frontend/src/utils/*`, `frontend/src/hooks/*`
- Used by: Pages

**Frontend store layer:**
- Purpose: Cross-page client state that must survive navigation (auth session with persisted tokens, live floor-map resource cache fed by sockets)
- Location: `frontend/src/stores/`
- Depends on: `zustand`
- Used by: Pages, `api/client.ts` (reads auth token), `hooks/useSocket.ts`

## Data Flow

### Primary Request Path (open a ticket / add an item)

1. User taps a table on the floor map — `FloorMapPage` calls `POST /api/v1/tickets` via axios (`frontend/src/pages/FloorMapPage.tsx`)
2. Request hits `tickets_bp` route in `backend/app/api/tickets.py`; JWT is validated by `@jwt_required()`, role checked inline
3. Blueprint handler creates/updates `Ticket`/`TicketLineItem` rows, calls into `app.services.inventory_svc` to deduct stock and `app.services.promotion_svc` to (re)compute applicable promotions, calls `app.services.audit_svc.log(...)` for the audit trail
4. On success, handler commits `db.session` and emits a Socket.IO event (e.g. `socketio.emit('floor:update', {}, room='floor')`, `tickets.py:28`) and, for kitchen/bar items, fires a background greenlet via `socketio.start_background_task` to POST a print job to the external print agent (`_spawn_auto_print_chit`, `tickets.py:32-85`) — printing never blocks or fails the order
5. All connected clients in the relevant Socket.IO room receive the event; `frontend/src/hooks/useSocket.ts` handlers translate it into `queryClient.invalidateQueries(...)` calls, which trigger TanStack Query refetches and re-render the affected pages

### Kitchen/Bar Queue Flow

1. Ticket line item created with a `routing_dest` (KITCHEN/BAR) determined by `MenuCategory.routing`
2. `KitchenQueuePage`/`BarQueuePage` (`frontend/src/pages/KitchenQueuePage.tsx`, `BarQueuePage.tsx`) fetch via `GET /api/v1/queue/*`
3. Staff marks item as started/ready/served through mutations against `backend/app/api/queue.py`, which emits `kitchen:update`/`bar:update`/`*:item_update` to the corresponding Socket.IO room
4. `useSocket.ts` listens globally (not just on the queue pages) so badge counts (`queue-counts`) stay correct even when the user is elsewhere in the app

### Print Flow (chit / receipt)

1. Backend never talks to a physical printer directly — it POSTs a JSON payload to `PRINT_AGENT_URL` (default `http://host.docker.internal:9191`), an external Flask service defined in `scripts/print_agent/print_agent.py` that runs on the Windows POS machine (installed via `scripts/install-nssm-print-agent.ps1`), outside docker-compose
2. Backend tracks print attempts as `PrintJob` rows (`backend/app/models/print_job.py`) with status `SENT`/`PRINTED`/`FAILED`
3. On failure, backend flags `TicketLineItem.needs_reprint = True`, emits `print:failed` to the `manager` room, and the frontend surfaces `PrintRetryBanner` (`frontend/src/components/PrintRetryBanner.tsx`) plus a toast

**State Management:**
- Server state lives in TanStack Query caches keyed by resource (`['resources']`, `['ticket', id]`, `['kitchen-queue']`, etc.); Socket.IO events are the primary invalidation trigger, `refetchInterval` polling is a secondary safety net
- `useFloorStore` (Zustand) is a denormalized read-through cache of `/resources`, updated both by query results and directly by socket handlers for lower-latency floor map updates
- `useAuthStore` (Zustand, persisted) holds `accessToken`/`refreshToken`/`user`; `frontend/src/api/client.ts` reads from it outside React via `useAuthStore.getState()`

## Key Abstractions

**Ticket:**
- Purpose: Central transactional aggregate — represents an open/closed tab for a table, an EXPRESS walk-up sale, or a DELIVERY (Rappi) order, discriminated by `ticket_type`
- Examples: `backend/app/models/ticket.py` (`Ticket`, `TicketLineItem`, `LineItemModifier`, `LineItemPromotion`, `PoolTimerSession`)
- Pattern: One OPEN ticket per `resource_id` enforced by a partial unique index (`uq_tickets_open_per_resource`, `backend/app/__init__.py:306-309`); all mutations go through `backend/app/api/tickets.py`

**Resource:**
- Purpose: A physical sellable unit on the floor map — pool table, regular table, or bar seat; owns at most one open ticket at a time
- Examples: `backend/app/models/resource.py` (`Resource`, `PoolTableConfig`)
- Pattern: `PoolTableConfig` (billing mode, rate, happy-hour free minutes) is a 1:1 config row consumed by `app.services.billing`

**Billing calculation:**
- Purpose: Pure function converting a timer session's elapsed time into a charge, supporting three modes (`PER_MINUTE`, `ROUND_15`, `PER_HOUR`)
- Examples: `backend/app/services/billing.py:calculate_charge`
- Pattern: Stateless, side-effect-free — takes primitives, returns a dict; called from `backend/app/api/tickets.py:_stop_active_timer`

**Inventory deduction (v2):**
- Purpose: Recipe-driven stock depletion — `InsumoBase` rows map a `MenuItem`/`Modifier` to `InventoryItem` consumption in a normalized `base_unit_key`; legacy `MenuItemIngredient` kept only for backward-compat seed scripts
- Examples: `backend/app/models/inventory.py`, `backend/app/services/inventory_svc.py`
- Pattern: Every sale writes a `SaleItemCost` snapshot row so historical margin reporting is decoupled from later cost changes; `unit_catalog` table normalizes unit names (bilingual ES/EN) referenced via FK

**Promotion engine:**
- Purpose: Evaluate `HAPPY_HOUR`, `ITEM_DISCOUNT`, `BOGO`, and `QTY_PERCENT_DISCOUNT` promotion types against a ticket's line items, optionally requiring staff confirmation (`requires_confirmation` + `TicketPromoDecision`)
- Examples: `backend/app/models/promotion.py`, `backend/app/services/promotion_svc.py`
- Pattern: Recomputed on every item add/void rather than cached; stackability controlled by `is_stackable`/`priority`/`max_applications_per_ticket`

**Audit log:**
- Purpose: Append-only trail of every state-changing action (login, ticket edits, cash movements, waitlist transitions) with before/after JSON snapshots
- Examples: `backend/app/models/audit.py`, `backend/app/services/audit_svc.py`
- Pattern: Called explicitly at the point of mutation (`audit_svc.log(user_id, ACTION, entity_type, entity_id, before=..., after=...)`); never inferred from ORM diffing

## Entry Points

**Backend WSGI/API server:**
- Location: `backend/wsgi.py` → `create_app()` in `backend/app/__init__.py`
- Triggers: `gunicorn --worker-class eventlet -w 1 ... wsgi:app` (see `backend/entrypoint.sh`); single eventlet worker is required because Socket.IO needs cooperative concurrency
- Responsibilities: Registers all blueprints/extensions, exposes `/api/v1/health`

**Backend container startup:**
- Location: `backend/entrypoint.sh`
- Triggers: Docker container start
- Responsibilities: Runs `flask init-db` (idempotent schema migration) then `python seed.py` (demo/initial data) before starting gunicorn

**Scheduler process:**
- Location: `backend/scheduler.py`
- Triggers: Separate `scheduler` service in `docker-compose.yml`, runs continuously via `BlockingScheduler`
- Responsibilities: Fires `generate_and_send_report()` daily at 08:00 America/Mexico_City

**Telegram bot process:**
- Location: `telegram-bot/bot.py`
- Triggers: Separate `telegram-bot` service in `docker-compose.yml`
- Responsibilities: Independent process reading the shared Postgres DB (not part of the Flask app)

**Frontend SPA entry:**
- Location: `frontend/src/main.tsx` → `frontend/src/App.tsx`
- Triggers: Browser loads `index.html`; Vite dev server (`npm run dev`) or built static bundle served by nginx (`frontend/nginx.conf`) in production
- Responsibilities: Mounts `QueryClientProvider`, `BrowserRouter`, `ErrorBoundary`, `Toaster`, and the route table

**Print agent (external, non-containerized):**
- Location: `scripts/print_agent/print_agent.py`
- Triggers: Runs as a Windows service/autostart (`scripts/install-nssm-print-agent.ps1`) on the POS host machine, listening on port 9191
- Responsibilities: Receives `/chit` and receipt print jobs POSTed by the backend and drives the physical printer(s); intentionally decoupled from Docker so it can access local USB/network printers

## Architectural Constraints

- **Threading:** Backend runs a single eventlet-based gunicorn worker (`-w 1 --worker-class eventlet`) — all request handling and background greenlets are cooperatively scheduled on one OS thread. Background work MUST use `socketio.start_background_task`, never `threading.Thread` (explicitly called out in `backend/app/api/tickets.py:83-85`), or it will break eventlet's cooperative scheduler.
- **Global state:** Flask extension singletons (`db`, `migrate`, `jwt`, `socketio`, `cors`, `limiter`) are module-level objects in `backend/app/extensions.py`, imported by name throughout `app/api/*` and `app/services/*`. Frontend has two Zustand global stores (`authStore`, `floorStore`) plus a module-level `isRefreshing`/`pendingQueue` mutable pair in `frontend/src/api/client.ts` that serializes concurrent token-refresh attempts.
- **No Alembic runtime migrations:** All schema evolution is inline idempotent SQL inside the `flask init-db` CLI command (`backend/app/__init__.py`, 25+ numbered STEP blocks). `flask_migrate` is initialized but not used as the deploy-time migration path; `scripts/migrations/` exists for one-off/manual scripts, not automatic app startup.
- **Cross-process shared DB, no shared code boundary enforcement:** `backend`, `scheduler`, and `telegram-bot` are separate deploy units that all read/write the same Postgres schema directly. There is no API layer between them — the telegram bot and scheduler must be kept in sync with schema changes manually.
- **Print agent trust boundary:** The backend treats print delivery as fire-and-forget over plain HTTP to a LAN address (`host.docker.internal:9191`); there is no authentication on that call. Print failures are surfaced via Socket.IO/UI rather than blocking ticket operations.

## Anti-Patterns

### Business logic embedded in API blueprints

**What happens:** Large blueprints like `backend/app/api/tickets.py` (1549 lines) and `backend/app/api/analytics.py` (1206 lines) mix HTTP concerns (parsing, auth) directly with multi-step business logic (timer stop/charge calc, waitlist cleanup, background print dispatch) instead of delegating fully to `app/services/`.
**Why it's wrong:** Makes blueprint functions hard to unit test in isolation and increases the chance that similar logic is duplicated across endpoints within the same file.
**Do this instead:** Extract multi-step domain logic into `app/services/*` functions (as already done for `billing`, `inventory_svc`, `promotion_svc`); keep blueprint functions to request parsing + calling a service + shaping the response, following the pattern already used by `backend/app/api/auth.py`.

### Inline raw-SQL schema migrations mixed with app startup

**What happens:** All DDL (25+ steps, table renames, column type changes, constraint additions, data backfills) lives inside the `init_db()` CLI command in `backend/app/__init__.py` and runs on every container start.
**Why it's wrong:** The migration history is not versioned or reviewable via `flask db upgrade`/Alembic; failures are swallowed by broad phrase-matching (`_IDEMPOTENT_PHRASES`) which can mask a genuinely broken migration as "already applied," and the file has grown to nearly 1000 lines, mixing app factory setup with two decades' worth of schema evolution.
**Do this instead:** New schema changes should still go through this pattern only if consistency with existing steps is required; longer-term, migrating to proper `flask-migrate`/Alembic revision files would make history auditable and rollback-capable. Any new step must be idempotent and must NOT rely on phrase-matching to suppress real errors.

## Error Handling

**Strategy:** Blueprint handlers return `jsonify({'error': CODE, 'message': ...}), status` on failure; there is no centralized Flask error handler registered in `app/__init__.py`, so most error shaping happens per-route. Background greenlets (print dispatch) catch broadly and never propagate — failures are recorded as `PrintJob.status = 'FAILED'` and surfaced via Socket.IO instead of exceptions.

**Patterns:**
- Idempotent-migration errors are swallowed by phrase-matching in `run()` inside `init_db()` (`backend/app/__init__.py:79-101`)
- Frontend axios interceptor (`frontend/src/api/client.ts`) transparently retries once on `401` via silent refresh-token exchange, queuing concurrent requests during the refresh window
- Frontend `ErrorBoundary` (`frontend/src/components/ErrorBoundary.tsx`) wraps the whole app at the root in `main.tsx` to catch render-time crashes

## Cross-Cutting Concerns

**Logging:** Python `logging` module configured once in `create_app()` (`backend/app/__init__.py:18-21`), level from `LOG_LEVEL` env var; gunicorn access/error logs stream to stdout (`--log-file=- --access-logfile=-` in `entrypoint.sh`). No structured/JSON logging framework.

**Validation:** Marshmallow-style dataclasses live in `backend/app/schemas/` (`auth_schemas.py`, `menu_schemas.py`, `resource_schemas.py`, `ticket_schemas.py`) but blueprint handlers frequently read `request.get_json()` and pull fields with `.get(...)` directly rather than always validating through a schema — validation coverage is inconsistent across blueprints.

**Authentication:** JWT via `flask-jwt-extended`; access tokens carry `role`/`name` as `additional_claims`, checked inline per-route (no declarative `@roles_required` decorator observed — role checks are ad hoc `if role not in (...)` blocks). Token revocation uses a DB-backed blocklist (`backend/app/models/token_blocklist.py`) checked in `backend/app/extensions.py:check_if_token_revoked`. Socket.IO applies the same JWT decode for the `manager` room only (`backend/app/sockets/events.py`).

---

*Architecture analysis: 2026-08-08*

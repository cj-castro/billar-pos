# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

BilliardBar POS — a full-featured Point-of-Sale and floor management system for a billiard pool bar. Flask REST API + Socket.IO backend, React/TypeScript SPA frontend, PostgreSQL database.

## Commands

**Full stack (production-like):**
```bash
cp .env.example .env   # first time only
docker compose up --build
# App at http://localhost:8080
```

**Backend dev (hot reload):**
```bash
cd backend
pip install -r requirements.txt
flask db upgrade
python seed.py          # seeds default users and sample data
flask run --debug
```

**Frontend dev (hot reload):**
```bash
cd frontend
npm install
npm run dev             # Vite dev server with proxy to backend
npm run build           # tsc + vite build
```

**Database migrations:**
```bash
cd backend
flask db migrate -m "description"
flask db upgrade
```

## Architecture

Three-tier: Browser → nginx (static) → Flask API → PostgreSQL, with Socket.IO for real-time sync.

**Backend layers** (`backend/app/`):
- `api/*.py` — Flask blueprints, one per domain (auth, tickets, resources, menu, inventory, reports, etc.)
- `models/*.py` — SQLAlchemy ORM models (Ticket, Resource, MenuItem, PoolTimerSession, etc.)
- `services/*.py` — stateless business logic: `billing.py` (pool time calc), `inventory_svc.py`, `promotion_svc.py`, `audit_svc.py`
- `schemas/*.py` — Marshmallow schemas for request validation
- `sockets/events.py` — Socket.IO event handlers; API routes emit `floor:update` after state changes

**Frontend layers** (`frontend/src/`):
- `pages/` — route-level components (FloorMapPage, TicketPage, KitchenQueuePage, ManagerDashboard, etc.)
- `components/` — reusable modals and UI (ResourceCard, AddItemModal, TransferModal, etc.)
- `stores/` — Zustand: `authStore` (user/token, persisted), `floorStore` (live resource list)
- `hooks/` — `useSocket` (Socket.IO context + event bridge), `useTimer`, `useLanguage` (i18n), `useEscKey`
- `api/client.ts` — Axios instance with JWT Bearer interceptor; 401 triggers logout + redirect

**Real-time flow:** API mutation → `socketio.emit('floor:update', {}, room='floor')` → frontend `useSocket` hook invalidates React Query cache → all open tabs update within milliseconds. React Query also polls as fallback (10–30s depending on query).

**Key domain concepts:**
- **Ticket** — customer session at a resource; status: OPEN / CLOSED / VOID; totals recalculated on every line item change via `recalculate_totals()`
- **Resource** — physical table/seat/pool table; status: AVAILABLE / IN_USE / MAINTENANCE; pool tables have a `PoolTimerSession`
- **Pool billing** — three modes (PER_MINUTE, ROUND_15, PER_HOUR) configured via `BILLING_MODE` env var; happy hour auto-applies in time window
- **Promotions** — happy hour (automatic) or manual discount (requires manager PIN via `verify-pin` endpoint)
- **Audit trail** — every sensitive action logged via `audit_svc.log()` with before/after state and IP address

**Auth:** JWT (access + refresh tokens). Backend uses `@jwt_required()` on all protected routes. Manager-only actions additionally call `require_manager()`. Frontend `RequireAuth` component enforces role-based route access.

**Roles:** Admin, Manager, Waiter, Kitchen Staff, Bar Staff.

## Conventions

- **Backend:** Python snake_case everywhere; 4-space indent; Marshmallow schemas validate requests; routes return `jsonify({'error': 'CODE', 'message': '...'})` with appropriate HTTP status
- **Frontend:** TypeScript strict mode; 2-space indent; PascalCase for components/types, camelCase for functions/variables; `@/*` path alias for `src/*`
- No formatter configured — match the surrounding code style
- No test suite currently exists

## Environment Variables

Key backend vars (see `docker-compose.yml` for full list):
- `DATABASE_URL` — PostgreSQL connection string
- `SECRET_KEY` / `JWT_REFRESH_SECRET` — signing keys
- `BILLING_MODE` — `PER_MINUTE` | `ROUND_15` | `PER_HOUR`
- `POOL_RATE_CENTS` — rate in cents (default 150)
- `HAPPY_HOUR_START` / `HAPPY_HOUR_END` — e.g. `17:00` / `20:00`
- `CURRENCY` — display currency code (default `USD`)

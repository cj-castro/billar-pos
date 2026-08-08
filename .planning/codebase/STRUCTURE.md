# Codebase Structure

**Analysis Date:** 2026-08-08

## Directory Layout

```
billar-pos/
├── backend/                    # Flask + Socket.IO REST API (Python)
│   ├── app/
│   │   ├── api/                 # Blueprints — one file per resource domain
│   │   ├── models/               # SQLAlchemy ORM entities
│   │   ├── schemas/               # Request/response schema helpers (partial coverage)
│   │   ├── services/               # Business logic shared across blueprints
│   │   ├── sockets/                 # Socket.IO connect/join/leave handlers
│   │   ├── __init__.py               # App factory + CLI commands + inline DB migrations
│   │   ├── config.py                  # Env-driven Config class
│   │   └── extensions.py               # Flask extension singletons (db, jwt, socketio, ...)
│   ├── tests/                    # Pytest suite (promotions-focused, thin coverage)
│   ├── scheduler.py               # Standalone daily-report cron process
│   ├── seed.py                     # Initial/demo data seeding, run at container start
│   ├── wsgi.py                      # Gunicorn entrypoint (`wsgi:app`)
│   ├── entrypoint.sh                 # Container startup: init-db → seed → gunicorn
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/                    # React 18 + Vite + TypeScript SPA
│   ├── src/
│   │   ├── api/                   # Single axios client (`client.ts`)
│   │   ├── components/             # Reusable UI components (modals, cards, nav)
│   │   ├── hooks/                   # Custom hooks (socket, timer, ESC-key, language)
│   │   ├── i18n/                     # es/en translation dictionaries
│   │   ├── pages/                     # Route-level screens (staff-facing)
│   │   │   └── manager/                # Manager/admin-only route screens
│   │   ├── stores/                     # Zustand global stores (auth, floor)
│   │   ├── utils/                       # Formatting, printing, storage helpers
│   │   ├── App.tsx                       # Route table + auth/role guards
│   │   └── main.tsx                       # React root, providers (Query, Router, ErrorBoundary)
│   ├── public/                    # Static assets (logo, favicon)
│   ├── nginx.conf                  # Production static-file + API/websocket proxy config
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── Dockerfile
├── telegram-bot/                # Standalone Telegram bot process (separate deploy unit)
│   ├── bot.py
│   ├── requirements.txt
│   └── Dockerfile
├── scripts/                     # Ops tooling — not part of any container image
│   ├── print_agent/               # External Windows print-agent Flask service
│   ├── migrations/                 # One-off/manual SQL migration scripts
│   ├── *.ps1                        # Windows install/setup/backup/network scripts
│   ├── *.sh                          # Unix start/stop/backup scripts
│   └── staticIp.py
├── docker-compose.yml            # postgres, backend, frontend, scheduler, telegram-bot services
├── DESIGN.md                     # Visual design system spec ("Monochrome Crest")
├── PRODUCT.md                    # Product/feature overview
├── README.md
├── RECOVERY.md                   # Disaster-recovery notes
└── REDESIGN-PLAN.md              # In-progress UI redesign plan (see git branch ui-refactor-goldy)
```

## Directory Purposes

**`backend/app/api/`:**
- Purpose: One Flask Blueprint per resource domain; the only layer that touches HTTP request/response objects
- Contains: `auth.py`, `resources.py`, `tickets.py` (largest, 1549 lines), `queue.py`, `inventory.py`, `reports.py`, `earnings.py`, `menu.py`, `users.py`, `waiting_list.py`, `cash_session.py`, `safe.py`, `suppliers.py`, `settings.py`, `promotions.py`, `analytics.py`
- Key files: `tickets.py` (core order lifecycle), `analytics.py` (reporting/BI views, 1206 lines)

**`backend/app/models/`:**
- Purpose: SQLAlchemy ORM table definitions and `to_dict()` serializers
- Contains: `user.py`, `resource.py`, `ticket.py`, `menu.py`, `inventory.py`, `promotion.py`, `audit.py`, `cash_session.py`, `waiting_list.py`, `supplier.py`, `print_job.py`, `setting.py`, `token_blocklist.py`
- Key files: `__init__.py` re-exports every model — always add new models here too, or `flask init-db`'s `db.create_all()` will not see the table

**`backend/app/services/`:**
- Purpose: Business logic invoked by more than one blueprint or complex enough to isolate/unit-test
- Contains: `billing.py` (pool-table charge calculation), `inventory_svc.py` (stock deduction/restock, largest service at 824 lines), `promotion_svc.py` (promotion eligibility engine), `audit_svc.py` (audit log writer), `printer_service.py` (print-agent HTTP client), `email_report_svc.py` (daily report generation/SMTP)

**`backend/app/schemas/`:**
- Purpose: Structured request/response schema definitions
- Contains: `auth_schemas.py`, `menu_schemas.py`, `resource_schemas.py`, `ticket_schemas.py`
- Note: Coverage is partial — many blueprint handlers parse `request.get_json()` ad hoc instead of going through a schema; check the target blueprint before assuming schema validation exists

**`backend/app/sockets/`:**
- Purpose: Socket.IO connection lifecycle only (room join/leave + auth); actual domain events are emitted from `app/api/*.py`, not from here
- Contains: `events.py`

**`backend/tests/`:**
- Purpose: Pytest suite
- Contains: `test_modifier_promotions.py`, `test_promo_time_window.py`, `test_promotions.py` — coverage is concentrated on the promotion engine; most other domains (tickets, inventory, cash) have no automated tests

**`frontend/src/pages/`:**
- Purpose: One component per route, registered in `App.tsx`
- Contains: `LoginPage.tsx`, `FloorMapPage.tsx`, `TicketPage.tsx`, `KitchenQueuePage.tsx`, `BarQueuePage.tsx`
- Sub-directory `manager/`: admin/manager-only screens — `ManagerDashboard.tsx`, `ReportsPage.tsx`, `InventoryPage.tsx`, `MenuManagementPage.tsx`, `UsersPage.tsx`, `PoolTableConfigPage.tsx`, `CashSessionPage.tsx`, `TableManagementPage.tsx`, `SettingsPage.tsx`, `ModifiersPage.tsx`, `PromotionsPage.tsx`, `SafeCollectionsPage.tsx`, `EarningsPage.tsx`, `AnalyticsPage.tsx`

**`frontend/src/components/`:**
- Purpose: Shared, reusable UI pieces used by 2+ pages (13 files total — a deliberately small shared component set)
- Contains: `Modal.tsx`, `AddItemModal.tsx`, `EditPaymentModal.tsx`, `TransferModal.tsx`, `NavBar.tsx`, `ResourceCard.tsx`, `WaitingListPanel.tsx`, `SectionHead.tsx`, `Icon.tsx` (custom icon set on top of `lucide-react`), `ManagerBackButton.tsx`, `ManagerPinDialog.tsx`, `PrintRetryBanner.tsx`, `ErrorBoundary.tsx`

**`frontend/src/hooks/`:**
- Purpose: Cross-page reusable React logic
- Contains: `useSocket.ts` (Socket.IO provider + event→cache-invalidation wiring), `useKDSAlert.ts` (kitchen display sound/alert), `useTimer.ts` (live pool-table timer display), `useEscKey.ts`, `useLanguage.ts`, `useUnitCatalog.ts`

**`frontend/src/stores/`:**
- Purpose: Global client state (Zustand)
- Contains: `authStore.ts` (persisted session: user, access/refresh tokens), `floorStore.ts` (denormalized live floor-map resource list)

**`frontend/src/utils/`:**
- Purpose: Pure helper functions, no React dependency
- Contains: `money.ts` (cents formatting), `a11y.ts`, `printReceipt.ts`, `printCashReconciliation.ts`, `printJobStorage.ts` (client-side print retry queue), `logoBase64.ts`

**`frontend/src/i18n/`:**
- Purpose: Bilingual (Spanish/English) UI strings
- Contains: `es.ts`, `en.ts` (385 lines each, kept in parallel key structure), `index.ts` (i18next setup)

**`scripts/print_agent/`:**
- Purpose: External Windows-hosted print bridge, NOT built into any Docker image
- Contains: `print_agent.py` (Flask app listening on port 9191), `requirements.txt`, `start_print_agent.bat`
- Deployment: Installed as a Windows service via `scripts/install-nssm-print-agent.ps1`; managed by `scripts/restart-print-agent.ps1`, `scripts/test-print-agent.ps1`

**`scripts/` (root level `.ps1`/`.sh`):**
- Purpose: Windows POS-machine operations tooling — install/autostart, network/static-IP setup, backup, health check, start/stop
- Contains: `setup-windows.ps1`, `install-autostart.ps1`, `pos-network-setup.ps1`, `set_ip.ps1`, `backup-pos.ps1` / `backup.sh`, `health-check.ps1`, `start-pos.ps1` / `start.sh`, `stop.sh`

**`scripts/migrations/`:**
- Purpose: One-off/manual SQL scripts NOT run automatically (unlike `flask init-db`'s inline DDL)
- Contains: `v2_migrate_prod.sql`

**`telegram-bot/`:**
- Purpose: Standalone notification/reporting bot, deployed as its own docker-compose service, reads the shared Postgres DB directly
- Contains: `bot.py`, `Dockerfile`, `requirements.txt`

## Key File Locations

**Entry Points:**
- `backend/wsgi.py`: Gunicorn/Flask entrypoint
- `backend/entrypoint.sh`: Container startup sequence (init-db → seed → gunicorn)
- `backend/scheduler.py`: Daily email report cron process
- `frontend/src/main.tsx`: React root mount
- `frontend/src/App.tsx`: Route table and auth/role guards
- `telegram-bot/bot.py`: Bot process entry

**Configuration:**
- `backend/app/config.py`: All backend env vars in one `Config` class
- `docker-compose.yml`: Service topology, all env var defaults, container wiring
- `frontend/vite.config.ts`: Dev proxy (`/api`, `/socket.io` → `localhost:5000`), `@` path alias
- `frontend/tailwind.config.js`: Design-system color tokens (`signal.*`), custom animations
- `.env` (present, not read by this tool — contains secrets): local environment overrides

**Core Logic:**
- `backend/app/__init__.py`: App factory + all schema migration DDL + CLI commands
- `backend/app/api/tickets.py`: Ticket/order lifecycle — largest and most central blueprint
- `backend/app/services/`: Billing, inventory deduction, promotions, audit, printing, email reports
- `frontend/src/hooks/useSocket.ts`: Real-time event → query-cache-invalidation wiring
- `frontend/src/api/client.ts`: HTTP client with auth header injection + silent token refresh

**Testing:**
- `backend/tests/`: Pytest suite (promotion engine only)
- No frontend test files/framework detected (`find frontend/src -name "*.test.*"` returns nothing; no Jest/Vitest config present)

## Naming Conventions

**Files:**
- Backend: `snake_case.py` for all Python files, matching the Flask/PEP 8 convention (`cash_session.py`, `waiting_list.py`, `promotion_svc.py`)
- Frontend components/pages: `PascalCase.tsx` (`FloorMapPage.tsx`, `AddItemModal.tsx`)
- Frontend hooks: `camelCase.ts` prefixed with `use` (`useSocket.ts`, `useEscKey.ts`)
- Frontend stores/utils: `camelCase.ts` (`authStore.ts`, `printReceipt.ts`)

**Backend suffixes:**
- `_svc.py` suffix marks a service-layer module (`audit_svc.py`, `inventory_svc.py`, `promotion_svc.py`); `billing.py`, `printer_service.py`, `email_report_svc.py` are the exceptions (naming is not 100% consistent)
- `_bp` suffix for Blueprint instances inside each `api/*.py` file (e.g. `tickets_bp`, `auth_bp`)

**Database:**
- Table names: `snake_case` plural (`tickets`, `inventory_items`, `waiting_list`)
- Money columns: always suffixed `_cents` and stored as integers (`price_cents`, `charge_cents`, `unit_cost_cents`)
- Quantity columns use `NUMERIC(12,4)` (not integer) since the inventory-v2 migration (`stock_quantity`, `quantity_delta`)

**Frontend:**
- Route paths are kebab/flat lowercase (`/manager/pool-config`, `/queue/kitchen`)
- Socket.IO event names use `domain:action` convention (`floor:update`, `kitchen:item_update`, `print:failed`, `ticket:updated`, `settings:changed`)
- TanStack Query keys are arrays with a domain-first string (`['resources']`, `['ticket', ticketId]`, `['tickets-reopened']`)

## Where to Add New Code

**New backend API resource/domain:**
- Create `backend/app/api/<domain>.py` with a `<domain>_bp = Blueprint(...)`
- Register it in `backend/app/__init__.py` alongside the other `app.register_blueprint(...)` calls, under `/api/v1/<domain>`
- Add ORM models to `backend/app/models/<domain>.py` and re-export from `backend/app/models/__init__.py`
- Add any DDL as a new numbered STEP block at the end of `init_db()` in `backend/app/__init__.py`, following the existing idempotent pattern (`IF NOT EXISTS` / `information_schema` checks)
- Put reusable business logic in `backend/app/services/<domain>_svc.py`

**New frontend page:**
- Add `.tsx` file to `frontend/src/pages/` (or `frontend/src/pages/manager/` if manager/admin-only)
- Register the route in `frontend/src/App.tsx`, wrapped in `<RequireAuth roles={[...]}>` if role-gated
- Fetch data with `useQuery`/`useMutation` against `frontend/src/api/client.ts`; do not create a second axios instance

**New shared UI component:**
- Add to `frontend/src/components/`; follow existing modal pattern (`Modal.tsx` as base, others compose it — see `AddItemModal.tsx`, `TransferModal.tsx`, `EditPaymentModal.tsx`)

**New real-time event:**
- Emit from the relevant `backend/app/api/*.py` blueprint handler after `db.session.commit()`, using `socketio.emit('<domain>:<action>', payload, room='<room>')`
- Add a matching `socket.on('<domain>:<action>', ...)` handler in `frontend/src/hooks/useSocket.ts` that invalidates the relevant TanStack Query key(s)
- If the event needs a new room, extend `_PUBLIC_ROOMS`/`_MANAGER_ROOMS` in `backend/app/sockets/events.py`

**Utilities:**
- Backend cross-cutting helpers: `backend/app/services/`
- Frontend pure helpers (no React): `frontend/src/utils/`
- Frontend cross-page React logic: `frontend/src/hooks/`

**Translations:**
- Add the same key to both `frontend/src/i18n/es.ts` and `frontend/src/i18n/en.ts` — they are hand-kept in parallel structure

## Special Directories

**`.impeccable/`:**
- Purpose: Tooling/config directory (not explored in depth for this map; treat as tool-managed)
- Generated: Likely yes
- Committed: Present in working tree

**`.planning/`:**
- Purpose: GSD planning artifacts (this codebase map lives at `.planning/codebase/`)
- Generated: Yes, by GSD commands
- Committed: Yes

**`scripts/migrations/`:**
- Purpose: Manual/historical SQL scripts, run by hand — not part of the automatic `flask init-db` path
- Generated: No
- Committed: Yes

**`frontend/public/`:**
- Purpose: Static assets served as-is (logo, favicon)
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-08-08*

# Codebase Concerns

**Analysis Date:** 2026-08-08

## Tech Debt

**Hand-rolled schema "migrations" instead of Alembic:**
- Issue: `Flask-Migrate` is initialized (`backend/app/extensions.py:10`) but never actually used — there is no `migrations/versions/` directory anywhere in the repo. Instead, all schema evolution lives in one giant `init-db` CLI command embedded in the app factory: `backend/app/__init__.py:68-696` (~630 lines), structured as 26 sequential "STEP N" blocks of raw SQL run through a `run(sql, label)` helper that swallows `ProgrammingError`/`OperationalError` whenever the message contains phrases like `'already exists'`, `'does not exist'`, `'duplicate key'` (`backend/app/__init__.py:76-100`).
- Files: `backend/app/__init__.py`, `scripts/migrations/v2_migrate_prod.sql` (the only file in that directory)
- Impact: No migration history, no rollback capability, no way to diff schema versions across environments. A genuinely broken migration step (e.g. wrong column type) can be silently swallowed if its error message happens to match an "idempotent" phrase, masking real production data problems until they surface elsewhere. `flask init-db` must be re-run and interpreted by reading console output rather than a migration status table.
- Fix approach: Introduce real Alembic migrations (Flask-Migrate is already a dependency) generated from the current STEP-by-STEP SQL, then freeze `init-db` as a one-time bootstrap for new environments only.

**God file: `backend/app/__init__.py` (1024 lines):**
- Issue: The Flask application factory also contains the entire migration engine (STEPs 1-26), several `@app.cli.command` implementations with substantial business logic (`restate-costs` at line 700, `daily-report` at line 776, `seed-beer` at line 793, `seed-buckets` at line 946), and blueprint registration, all in one file.
- Files: `backend/app/__init__.py`
- Impact: Hard to review/test in isolation; any change to seeding or migration logic requires touching the same file as app bootstrap, increasing merge-conflict and regression risk.
- Fix approach: Extract CLI commands into `backend/app/cli/` modules and migration logic into a dedicated `migrations` package.

**Duplicated per-endpoint role checks instead of a shared decorator:**
- Issue: Authorization is enforced ad hoc, endpoint by endpoint, via `claims = get_jwt(); if claims.get('role') not in (...)` (163 occurrences across `backend/app/api/*.py`) rather than a single `@role_required('MANAGER', 'ADMIN')` decorator. Patterns vary: some files check `claims.get('role')` (`backend/app/api/cash_session.py:14`), others re-fetch the `User` row and check `user.role` (`backend/app/api/settings.py:28`), others centralize the check in a local `_guard()`/`_require_admin()` helper (`backend/app/api/analytics.py:60,108`).
- Files: `backend/app/api/inventory.py`, `backend/app/api/menu.py`, `backend/app/api/tickets.py`, `backend/app/api/cash_session.py`, `backend/app/api/settings.py`, `backend/app/api/analytics.py`
- Impact: Inconsistent enforcement is easy to get wrong when adding new endpoints (see `suppliers.py` below, where it was simply omitted). No single place to audit "which roles can do what."
- Fix approach: Add a shared `role_required(*roles)` decorator in `backend/app/api/__init__.py` or a new `backend/app/auth_utils.py`, and migrate existing inline checks to it incrementally.

**Missing role gate on supplier management endpoints:**
- Issue: `backend/app/api/suppliers.py` registers `create_supplier`, `update_supplier`, and `delete_supplier` (lines 17-61) behind `@jwt_required()` only — no role check at all. Any authenticated user, including the lowest-privileged roles (`WAITER`, `KITCHEN_STAFF`, `BAR_STAFF`), can create, rename, or soft-delete suppliers.
- Files: `backend/app/api/suppliers.py:17-61`
- Impact: Non-manager staff can silently corrupt supplier master data used for purchasing/inventory costing.
- Fix approach: Add the same `MANAGER`/`ADMIN` role check pattern used in `backend/app/api/settings.py:28` to the three mutating routes.

**Stray non-source files committed inside the Python package:**
- Issue: `backend/app/Archive.zip` (164 KB binary archive), `backend/app/inventory.md` (11.7 KB), and `backend/app/# Billar POS → SaaS + AWS Migration: Tec.md` (11.8 KB, filename contains `#` and `→`) live inside the importable `app` package alongside real modules.
- Files: `backend/app/Archive.zip`, `backend/app/inventory.md`, `backend/app/# Billar POS → SaaS + AWS Migration: Tec.md`
- Impact: Repository hygiene — these are planning artifacts/backups that don't belong in the source tree and bloat the Docker build context (`COPY . .` style Dockerfiles would ship them into the image).
- Fix approach: Move to `.planning/` or a `docs/` folder outside `backend/app/`, or delete if obsolete.

**Widespread `any` typing in the frontend:**
- Issue: 292 occurrences of `: any` across `frontend/src/**/*.{ts,tsx}`, concentrated in the largest pages: `frontend/src/pages/manager/ReportsPage.tsx` (44), `frontend/src/pages/manager/AnalyticsPage.tsx` (43), `frontend/src/pages/manager/MenuManagementPage.tsx` (40), `frontend/src/pages/manager/InventoryPage.tsx` (26), `frontend/src/pages/TicketPage.tsx` (24).
- Files: see above; also `frontend/src/pages/manager/ModifiersPage.tsx` (19), `frontend/src/pages/manager/PromotionsPage.tsx` (16), `frontend/src/components/AddItemModal.tsx` (16)
- Impact: TypeScript's compile-time safety is defeated in exactly the files with the most business logic (analytics math, inventory costing, promotions). API response shapes aren't statically checked, so backend contract changes can silently break the UI at runtime.
- Fix approach: Introduce shared response types (e.g. generated from backend schemas or hand-written in `frontend/src/api/types.ts`) starting with the highest-traffic pages (`TicketPage.tsx`, `AnalyticsPage.tsx`).

## Known Bugs

**Auth-refresh role/claims desync (documented, mitigated):**
- Symptoms: If the `/refresh` endpoint doesn't re-attach `role`/`name` claims, every role-gated endpoint (analytics, reports, earnings, safe) starts returning 403 after the first token refresh while the UI still shows the user as logged in, because the frontend route guard reads role from the persisted Zustand store, not from the JWT.
- Files: `backend/app/api/auth.py:47-70` (extensive inline comment documents the failure mode and the fix already applied)
- Trigger: Any session lasting longer than the 8-hour access-token lifetime.
- Workaround: Already fixed in code (claims are re-read from `User` in `/refresh`), but the comment signals this class of bug (frontend/backend claim desync) can recur if similar shortcuts are taken elsewhere.

**Recurring "ghost ticket" / stuck resource data corruption:**
- Symptoms: Open tickets exist on resources that are already marked `AVAILABLE`; orphaned timer sessions keep running on tickets that are no longer `OPEN`; duplicate open tickets on the same resource.
- Files: `backend/app/api/tickets.py:1276` (`open-all` — list every open ticket for manual review), `backend/app/api/tickets.py:1299` (force-close a stuck ticket), `backend/app/api/tickets.py:1345-1406` (`clean-ghosts` — auto-close true ghosts), diagnostic SQL queries documented in `RECOVERY.md:196-217`
- Trigger: Backend crashes, container restarts, or network drops mid-transaction leave tickets/timers/resources out of sync with each other.
- Workaround: Dedicated recovery tooling exists (`POST /api/v1/tickets/clean-ghosts`, `POST /api/v1/tickets/<id>/force-close`) and `RECOVERY.md` documents manual SQL integrity checks — the existence of this tooling and a full crash-recovery runbook indicates this has happened in production, not just a theoretical risk.

## Security Considerations

**Insecure default credentials baked into `docker-compose.yml`:**
- Risk: `docker-compose.yml:30-49` defaults every secret to a well-known value if the corresponding environment variable is unset: `SECRET_KEY=dev-secret-key-change-in-production`, `JWT_REFRESH_SECRET=dev-refresh-secret-change-in-production`, `POSTGRES_PASSWORD=billiard_secret`, plus per-role login passwords and PINs (`ADMIN_PASSWORD=admin123`, `ADMIN_PIN=1234`, `MANAGER_PASSWORD=manager123`, `MANAGER_PIN=5678`, `WAITER1_PASSWORD=waiter123`, `WAITER2_PASSWORD=waiter123`, `KITCHEN_PASSWORD=kitchen123`, `BARSTAFF_PASSWORD=bar123`). `backend/app/config.py:5,12` has the same fallback for `SECRET_KEY`/`JWT_SECRET_KEY` (`'dev-secret-change-me'`). `backend/seed.py:31-54` seeds these exact users/passwords from the same env vars.
- Files: `docker-compose.yml:30-49`, `backend/app/config.py:5,12-13`, `backend/seed.py:31-54`
- Current mitigation: None — there is no `.env.example` in the repo and no startup check that rejects default secrets in production (`FLASK_ENV` defaults to `production` per `docker-compose.yml:40`, so the app happily runs "in production mode" with dev secrets).
- Recommendations: Fail startup (or at minimum log a loud warning) when `FLASK_ENV=production` and `SECRET_KEY`/`JWT_REFRESH_SECRET`/any seeded password still matches its documented default. Require an `.env` file with generated secrets before `docker compose up` in a real deployment; add `.env.example` documenting required vars without values.

**Wide-open CORS on both REST API and WebSocket:**
- Risk: `backend/app/__init__.py:26` sets `cors.init_app(app, resources={r"/api/*": {"origins": "*"}})` and `backend/app/extensions.py:11` sets `socketio = SocketIO(cors_allowed_origins="*", ...)`. Combined with JWTs sent via `Authorization` header (not cookies), CSRF risk is low, but any origin can make authenticated cross-origin requests if a token is ever exposed to script (see next item), and any origin can open a Socket.IO connection to the backend.
- Files: `backend/app/__init__.py:26`, `backend/app/extensions.py:11`
- Current mitigation: None (single-tenant LAN deployment reduces real-world exposure today, per `RECOVERY.md` describing a Windows/Docker Desktop LAN setup).
- Recommendations: Restrict `origins` to the actual frontend origin(s) via env var, especially before any multi-tenant/cloud deployment (see `POSPackaging_n_DistributionPlan.md` / SaaS migration doc referenced in the repo).

**Unauthenticated Socket.IO connections and room joins:**
- Risk: `backend/app/sockets/events.py:11-13` accepts every `connect` event unconditionally (`pass`). `on_join` (`backend/app/sockets/events.py:16-34`) only validates a JWT for the `manager` room; the `floor`, `kitchen`, `bar`, `waiting` rooms and any `ticket:<id>` room (validated only via `room.startswith('ticket:')`, not that the caller has access to that specific ticket) can be joined by anyone who can reach the Socket.IO endpoint, with no token at all.
- Files: `backend/app/sockets/events.py:1-46`
- Current mitigation: Manager-room JWT check only.
- Recommendations: Require a valid JWT on `connect` (reject unauthenticated sockets outright) and validate ticket ownership/role before allowing a `ticket:<id>` room join, not just the room-name prefix.

**JWT access + refresh tokens persisted in `localStorage`:**
- Risk: `frontend/src/stores/authStore.ts:20-32` uses Zustand's `persist` middleware (default storage backend is `localStorage`) to store `accessToken` and `refreshToken` (7-day lifetime, `backend/app/api/auth.py:34`). Any XSS in the app gives an attacker both tokens, including a week-long refresh token, with no `httpOnly` protection.
- Files: `frontend/src/stores/authStore.ts:20-32`, `backend/app/api/auth.py:34`
- Current mitigation: No `dangerouslySetInnerHTML` usage was found in `frontend/src` (reduces one common XSS vector), which lowers but does not eliminate the risk (third-party script/dependency compromise remains a vector).
- Recommendations: Consider moving the refresh token to an `httpOnly` cookie set by the backend, or at minimum shorten the refresh-token lifetime and add token rotation/reuse detection (a `TokenBlocklist` model already exists at `backend/app/models/token_blocklist.py` and is used for logout revocation — extend the same mechanism to refresh-token reuse detection).

**Unauthenticated local print agent bound to all interfaces:**
- Risk: `scripts/print_agent/print_agent.py:1067` runs `app.run(host='0.0.0.0', port=PORT, debug=False)`, and the `/print` (`:949`) and `/chit` (`:1034`) POST endpoints have no authentication or origin check (`grep` for `jwt_required|API_KEY|CORS` in the file returns nothing). Any device on the same local network as the POS machine can trigger physical printer output (chits/receipts) or probe `/printers` (`:1054`).
- Files: `scripts/print_agent/print_agent.py:22,941-1067`
- Current mitigation: `RECOVERY.md:256` documents the port as "localhost only" but the actual bind address is `0.0.0.0`, not `127.0.0.1` — the documentation and the code disagree.
- Recommendations: Bind to `127.0.0.1` unless LAN access is genuinely required; if LAN access is required (e.g. backend runs in a separate Docker container reaching the host via `host.docker.internal`, per `backend/app/api/tickets.py:22`), add a shared-secret header check.

## Performance Bottlenecks

**No frontend automated tests / no CI-verifiable regression safety net:**
- Problem: There is no `vitest.config.*`, `jest.config.*`, or any `*.test.tsx`/`*.spec.tsx` file anywhere under `frontend/` (verified via repo-wide search). `frontend/package.json` has no `test` script.
- Files: `frontend/package.json` (scripts: `dev`, `build`, `preview` only)
- Cause: Testing infrastructure was never set up for the frontend.
- Improvement path: This is a coverage/quality gap rather than a runtime performance issue — listed here because it directly affects how safely the largest, most complex pages (`InventoryPage.tsx` at 1602 lines, `TicketPage.tsx` at 1502 lines, `AnalyticsPage.tsx` at 1245 lines) can be refactored.

## Fragile Areas

**Very large, monolithic page/route files:**
- Files: `backend/app/api/tickets.py` (1549 lines), `backend/app/api/analytics.py` (1206 lines), `backend/app/__init__.py` (1024 lines), `backend/app/analytics_views.py` (933 lines), `backend/app/services/inventory_svc.py` (824 lines), `backend/app/api/inventory.py` (821 lines); `frontend/src/pages/manager/InventoryPage.tsx` (1602 lines), `frontend/src/pages/TicketPage.tsx` (1502 lines), `frontend/src/pages/manager/AnalyticsPage.tsx` (1245 lines), `frontend/src/pages/manager/ReportsPage.tsx` (908 lines)
- Why fragile: `tickets.py` alone mixes order lifecycle, billing, ghost-ticket recovery, print-agent integration, and promotions in one module. Frontend pages of this size mix data fetching, business calculations, and rendering in a single component, making isolated changes risky.
- Safe modification: Favor small, targeted edits with explicit test coverage (backend has `backend/tests/` with only 3 files covering promotions — see gap below) over broad refactors; when touching `tickets.py`, search for all `with_for_update()` call sites first (10 occurrences) to understand existing locking invariants before adding new write paths.
- Test coverage: See Test Coverage Gaps below — `tickets.py`, `inventory_svc.py`, `analytics.py`, and `cash_session.py` (the most complex and highest-risk modules) have no dedicated backend test files.

**Bare `except Exception` swallowing errors in background/print paths:**
- Files: `backend/app/sockets/events.py:28` (join-room token decode), `backend/app/api/queue.py:28`, `backend/app/api/tickets.py:80-81` (explicitly "never raise from background greenlet"), `backend/app/api/tickets.py:252,1468,1530`, `backend/app/api/inventory.py:756`, `backend/app/services/promotion_svc.py:27`
- Why fragile: Several of these are intentional (fire-and-forget print jobs, per `backend/app/api/tickets.py:35` docstring: "Print failure NEVER blocks or fails the order"), but the broad `except Exception` combined with no logging in some sites (e.g. `backend/app/api/queue.py:28`) means real bugs in those code paths fail silently with no operator-visible trace.
- Safe modification: When touching these blocks, add structured logging (even at DEBUG level) before swallowing, so silent failures are at least discoverable in `docker compose logs backend`.
- Test coverage: None of these error paths are covered by the existing test suite (`backend/tests/` only covers promotions).

## Scaling Limits

**Single-machine LAN deployment model:**
- Current capacity: `docker-compose.yml` and `RECOVERY.md` describe a single Windows machine (`C:\Users\bola8lacalma\Desktop\POS\billiards`) running Docker Desktop with Postgres, backend, frontend, scheduler, and telegram-bot containers, with `socketio` using `async_mode='eventlet'` (single-process, cooperative concurrency — `backend/app/extensions.py:11`).
- Limit: No horizontal scaling story; `RATELIMIT_STORAGE_URI` defaults to in-process `memory://` (`backend/app/config.py:17`), so rate limits would not be shared/correct across multiple backend instances if ever scaled beyond one process.
- Scaling path: `POSPackaging_n_DistributionPlan.md` and the stray `backend/app/# Billar POS → SaaS + AWS Migration: Tec.md` file indicate a multi-tenant/cloud migration is already being planned — that plan should explicitly address the eventlet single-process model, the `memory://` rate limiter, and the wide-open CORS/socket settings called out above before going multi-tenant.

## Test Coverage Gaps

**Backend: only promotions logic is under test:**
- What's not tested: `backend/tests/` contains exactly 3 files (`test_modifier_promotions.py`, `test_promo_time_window.py`, `test_promotions.py`, 641 lines total) — all promotions-focused. There is no test coverage for ticket lifecycle (`backend/app/api/tickets.py`, 1549 lines), inventory/stock decrement (`backend/app/services/inventory_svc.py`, 824 lines), cash session open/close/reconciliation (`backend/app/api/cash_session.py`, 393 lines), analytics/financial reporting (`backend/app/api/analytics.py`, 1206 lines), or auth (`backend/app/api/auth.py`).
- Files: `backend/tests/` (only 3 files present)
- Risk: The highest-stakes logic in the system — money handling, stock levels, and shift reconciliation — can regress silently. The extensive inline comments in `backend/app/api/auth.py:47-58` and `backend/app/analytics_views.py` describing subtle bugs already found in these exact areas suggest this risk is not hypothetical.
- Priority: High (tickets, inventory, cash session, auth); Medium (analytics/reports).

**Frontend: zero automated test coverage:**
- What's not tested: No test framework is configured at all (see Performance Bottlenecks above for detail).
- Files: entire `frontend/src/` tree, especially `frontend/src/pages/TicketPage.tsx` (1502 lines) and `frontend/src/pages/manager/InventoryPage.tsx` (1602 lines)
- Risk: UI regressions in checkout, payment, and inventory flows are only caught by manual QA.
- Priority: High for `TicketPage.tsx` and `FloorMapPage.tsx` (core transaction flow); Medium for manager reporting pages.

---

*Concerns audit: 2026-08-08*

# Repository Audit — billar-pos

Root: worktree `D:/Projects/Code/billar-pos-worktrees/mobile-pos-companion` (branch `feature/mobile-pos-companion`, base `4e4430ff`).
Method: read-only static inspection (Glob/Grep/Read). Nothing executed. Items marked UNVERIFIED were not confirmed at runtime.

## 1. Stack

| Layer | Technology (version) | Evidence |
|---|---|---|
| Backend | Python 3.11-slim; Flask 3.0.3, Flask-SocketIO 5.3.6, Flask-JWT-Extended 4.6.0, Flask-SQLAlchemy 3.1.1, SQLAlchemy 2.0.54, Flask-Migrate 4.0.7, Flask-Limiter 3.7.0, Flask-Cors 4.0.1, marshmallow 3.21.3, gunicorn 22.0.0, eventlet 0.36.1, APScheduler 3.10.4, bcrypt 4.1.3 | `backend/requirements.txt`, `backend/Dockerfile` |
| Frontend | React 18.3.1, Vite 7.3.x, TypeScript 5.9.3, Tailwind 3.4.19 | `frontend/package.json`, `frontend/package-lock.json` |
| Frontend libs | zustand 4.5.7, @tanstack/react-query 5.100.x, axios 1.16.x, socket.io-client 4.8.3, i18next 26.3.0, react-i18next 17.0.8, react-router-dom 6.30.x, recharts 3.8.1, date-fns 3.6.0, react-hot-toast 2.6.0, lucide-react 0.395.0 (installed, unused) | `frontend/package-lock.json` |
| Serving | nginx 1.27-alpine serves SPA, proxies `/api/` and `/socket.io/` to `backend:5000` | `frontend/nginx.conf` |
| DB | PostgreSQL 15 (`postgres:15-alpine`) | `docker-compose.yml` |
| Telegram | python-telegram-bot 20.7, SQLAlchemy 2.0.23 | `telegram-bot/requirements.txt` |
| Languages | Python, TypeScript/TSX, SQL (`backend/migrations/sql`), PowerShell + bash (`scripts/`) | tree |

## 2. docker-compose services (`docker-compose.yml`)

| Service | Image/build | Host port | Notes |
|---|---|---|---|
| postgres | postgres:15-alpine | none | volume `pg_data`, `pg_isready` healthcheck |
| backend | `./backend` | none (5000 internal) | `entrypoint.sh`: `flask init-db` → `seed.py` → `flask factory-finalize` → `flask apply-migrations` → `gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:5000 wsgi:app` |
| frontend | `./frontend` (nginx) | `${FRONTEND_PORT:-8080}:80` | only host-published port |
| scheduler | backend image, `python scheduler.py` | none | daily sales email 08:00 America/Mexico_City |
| telegram-bot | `./telegram-bot` | none | read-only reporting bot |

Compose has hardcoded credential/secret fallbacks (`ADMIN_PASSWORD: admin123`, `SECRET_KEY: dev-secret-key-change-in-production`).

## 3. Backend structure and API topology

- App factory `backend/app/__init__.py:create_app`; `backend/wsgi.py` exposes `app`.
- Blueprints registered in `create_app` under `/api/v1/<name>`: auth, resources, tickets, queue, inventory, reports, reports/earnings, menu, users, waiting-list, cash, safe, suppliers, settings, promotions, analytics.
- Base path `/api/v1`; versioning by URL prefix only. No OpenAPI spec found.
- Socket.IO on same app, root path, no namespaces; handlers in `backend/app/sockets/events.py`.
- Error shape `{"error": "<CODE>", "message": "..."}` (`auth.py:login`); JWT library errors return `{"msg": ...}`.
- Serialization via model `to_dict()` (28 models in `backend/app/models/`). Marshmallow schemas in `backend/app/schemas/` are unused (dead code).
- Schema management: legacy idempotent DDL in `init-db` (errors swallowed) + `db.create_all()` + versioned SQL in `backend/migrations/sql/` applied by `backend/app/migrations_runner.py` per `manifest.txt` (`001_baseline_squash.sql` baseline). Flask-Migrate initialized but no `migrations/env.py` — README `flask db upgrade` likely fails (UNVERIFIED).

## 4. Authentication

| Aspect | Finding | Reference |
|---|---|---|
| Mechanism | JWT bearer (Flask-JWT-Extended). No cookies/sessions. | `backend/app/api/auth.py` |
| Login input | username + password | `auth.py:login` |
| PIN | manager override only (`POST /auth/verify-pin`), bcrypt. Not a login method. | `auth.py:verify_manager_pin`, `models/user.py` |
| Access token | identity = `user.id`; claims `role`, `name`; lifetime **hardcoded 8h** (config `JWT_ACCESS_HOURS` ignored) | `auth.py:login`, `auth.py:refresh`, `config.py` |
| Refresh token | 7 days; `POST /auth/refresh` re-reads user from DB, returns new access token only (no rotation) | `auth.py:refresh` |
| Logout | blocklists only the access token jti; refresh token stays valid up to 7 days | `auth.py:logout`, `models/token_blocklist.py` |
| Revocation | `@jwt.token_in_blocklist_loader` | `extensions.py:check_if_token_revoked` |
| Secret | `JWT_SECRET_KEY = SECRET_KEY`; `JWT_REFRESH_SECRET_KEY` probably unused (UNVERIFIED) | `config.py` |
| Rate limits | login 10/min, verify-pin 5/min, in-memory | `auth.py` `@limiter.limit` |
| Shared bucket | no ProxyFix → `remote_addr` is nginx container IP → all clients share one bucket; audit `ip_address` wrong (UNVERIFIED runtime) | grep `backend/app` |
| Web storage | zustand `persist` key `auth-storage` in localStorage (`user`, `accessToken`, `refreshToken`) | `frontend/src/stores/authStore.ts` |
| Web transport | interceptor sets Bearer; on 401 single-flight `POST /auth/refresh`; refresh 401/422 → logout | `frontend/src/api/client.ts` |
| Socket auth | connect unauthenticated; `manager` room requires `token` in join payload | `sockets/events.py:on_join` |
| Seeds | admin (PIN 1234), manager (PIN 5678), waiter1, kitchen, barstaff | `backend/seed.py`, README |

## 5. Authorization

Roles (exact): `ADMIN`, `MANAGER`, `WAITER`, `KITCHEN_STAFF`, `BAR_STAFF` (`models/user.py:12`, `seed.py:31-53`). `KITCHEN`/`BAR` literals are routing destinations, not roles.

No decorator/middleware; each handler does `@jwt_required()` then inline `claims.get('role')`:
- MANAGER|ADMIN: `menu.py` (13 handlers), `tickets.py` (8, plus DB-based manager lookup ~L1844), `resources.py:require_manager` (L67), `reports.py:26`, `promotions.py:24`, `suppliers.py:17`, `waiting_list.py:440`, `cash_session.py:14`, `inventory.py:_role` (L69), `settings.py:32`.
- ADMIN only: `users.py:12`, `analytics.py`. `safe.py`, `earnings.py` UNVERIFIED.
- Possible inconsistency: `analytics.py` docstring says reports/earnings/safe exclude MANAGER; `reports.py:26` allows MANAGER (UNVERIFIED).
- Web route guards `frontend/src/App.tsx` (`RequireAuth roles=[...]`) are UI-only.
- Role is a token snapshot: a demoted user keeps old role until refresh (≤8h).

## 6. Real-time (Socket.IO)

- Server `extensions.py:12`: `SocketIO(cors_allowed_origins="*", async_mode='eventlet')`, gunicorn eventlet `-w 1` (single worker required for in-process emits).
- Web client `frontend/src/hooks/useSocket.ts`: `io('/', {transports:['websocket','polling']})`; nginx proxies `/socket.io/` with Upgrade, 3600s timeout.
- Rooms: public `floor, kitchen, bar, waiting`; `manager` (token-gated); `ticket:<id>` (prefix). Client sends `join`/`leave` `{room}`.
- Web join logic: all roles → `floor`; KITCHEN_STAFF/MANAGER/ADMIN → `kitchen`; BAR_STAFF/MANAGER/ADMIN → `bar`; MANAGER/ADMIN → `manager`. WAITER joins no queue room.

| Event | Room | Emitter | Web listener |
|---|---|---|---|
| `floor:update` | floor | `resources.py:175,211,248`; `tickets.py:30`; `waiting_list.py:369,403,509` | refetch `/resources` |
| `waiting:update` | floor | `tickets.py:931,1115,1274,1681,1752`; `waiting_list.py:53` | yes |
| `waiting_list:update` | floor | `tickets.py:284` | **none (name mismatch)** |
| `kitchen:update`, `bar:update` | kitchen/bar | `tickets.py:499-501,782-784,815-817` | yes |
| `kitchen:item_update`, `bar:item_update` | routing room | `queue.py:104,193` | yes |
| `ticket:item_status` | ticket:<id> | `queue.py:107` | **none** |
| `ticket:updated` | ticket:<id> | `tickets.py:360,502,643,780,818` | invalidates `['ticket', id]` |
| `print:failed` | manager | `queue.py:196`; `tickets.py:104,1820,1882` | toast (MANAGER/ADMIN) |
| `pool:timer_voided` | broadcast | `tickets.py:1342` | **none** |
| `settings:changed` | broadcast | `settings.py:47` | yes |
| `inventory:box_opened` | broadcast | `services/inventory_svc.py:925` | `InventoryPage.tsx:209` |
| `inventory:box_finished/low` | — | emitters commented out (`inventory_svc.py:223,230`) | never fires |

Payloads mostly `{}` (refetch signals). `ticket:updated` carries `ticket_id`, `version`; `print:failed` carries `job_id, ticket_id, type, error`. Web does full resync on every `connect`.

## 7. Mobile/PWA assets

None: no manifest, service worker, Capacitor/Expo/RN/Flutter. Web UI is responsive (`components/NavBar.tsx` bottom tab bar `md:hidden`, safe-area padding in `index.css`).

## 8. Tests

- `backend/tests/`: 7 modules, run as `python -m tests.<module>` from `backend/`; pure logic, no DB, no pytest config. No `assert` statements (failure reporting UNVERIFIED).
- `backend/verify_api2.py`, `verify_confirm.py`: integration scripts hitting Postgres `localhost:55432`.
- `scripts/verify_clean_install.sh`.
- Frontend: no test runner; only `npm run build` (`tsc && vite build`, strict).
- No CI (`.github/` absent).

## 9. Dev tooling

- README flow: `pip install`, `flask db upgrade` (suspect), `python seed.py`, `flask run`; frontend `npm run dev` with Vite proxy to `localhost:5000` (`vite.config.ts`).
- README references `.env.example` (absent); says port 80, compose default is 8080.
- `scripts/`: start/stop/update/install/backup (sh + ps1), Windows setup, network/static IP (`pos-network-setup.ps1`, `set_ip.ps1`), print agent (`scripts/print_agent/print_agent.py`, backend calls `PRINT_AGENT_URL` default `http://host.docker.internal:9191`).

## 10. Telegram bot

`telegram-bot/bot.py`: owner reporting; reads Postgres directly (no API); read-only (no INSERT/UPDATE/DELETE). Commands at `bot.py:768-784`.

## 11. CORS and host binding

| Item | Value | Ref |
|---|---|---|
| Flask CORS | `*` on `/api/*` | `app/__init__.py` |
| Socket.IO CORS | `*` | `extensions.py:12` |
| Credentials | Bearer header, no cookies | `api/client.ts` |
| Backend bind | `0.0.0.0:5000` in container, not published | `entrypoint.sh` |
| Host ports | only `${FRONTEND_PORT:-8080}:80` (all interfaces by default) | `docker-compose.yml` |
| Vite dev | localhost only | `vite.config.ts` |
| Body size | 2 MB | `config.py`, `nginx.conf` |

**Mobile implication:** phones reach `http://<host>:8080` for both `/api/v1` and `/socket.io/`. Native apps ignore CORS.

## 12. Risks seen

Refresh tokens survive logout; no ProxyFix (shared rate-limit bucket, wrong audit IPs); public socket rooms joinable unauthenticated; default credentials in compose/README; socket event name mismatches; unused marshmallow schemas; doc drift (`.env.example`, port, `flask db upgrade`); `JWT_ACCESS_HOURS`/`JWT_REFRESH_SECRET` ineffective.

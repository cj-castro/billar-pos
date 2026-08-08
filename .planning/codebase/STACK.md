# Technology Stack

**Analysis Date:** 2026-08-08

## Repository Layout

This is a multi-service monorepo with no root `package.json`. Four independently deployed services, each with its own dependency manifest:

- `backend/` — Flask REST + WebSocket API (Python)
- `frontend/` — React SPA (TypeScript, Vite)
- `telegram-bot/` — standalone Telegram notification bot (Python)
- `scripts/print_agent/` — Windows-hosted local print agent (Python, runs outside Docker)

## Languages

**Primary:**
- Python 3.11 — `backend/` (Flask API, business logic, models), `telegram-bot/bot.py`
- TypeScript 5.4 — `frontend/src/**` (React SPA, strict mode enabled)

**Secondary:**
- PowerShell — `scripts/*.ps1` (Windows deployment/ops: autostart, network setup, backups, print-agent service install)
- Bash — `scripts/start.sh`, `scripts/stop.sh`, `scripts/backup.sh`, `backend/entrypoint.sh`
- SQL — raw queries via SQLAlchemy `text()` throughout `backend/app/api/*.py` and `backend/app/services/*.py` (heavy use of hand-written SQL alongside the ORM)

## Runtime

**Backend:**
- Python 3.11 (`backend/Dockerfile`: `python:3.11-slim`)
- WSGI entry: `backend/wsgi.py`
- App factory: `backend/app/__init__.py` (`create_app()`)
- Production server: gunicorn + eventlet worker (async, required for Flask-SocketIO)

**Frontend:**
- Node.js 20 (`frontend/Dockerfile`: `node:20-alpine` build stage)
- Build tool: Vite 7
- Runtime (production): static files served by nginx 1.27-alpine (`frontend/Dockerfile`, `frontend/nginx.conf`)

**Package Managers:**
- pip — `backend/requirements.txt`, `telegram-bot/requirements.txt` (no lockfile; pinned `==` versions)
- npm — `frontend/package.json` + `frontend/package-lock.json` (lockfile present)

## Frameworks

**Backend Core:**
- Flask 3.0.3 — HTTP API framework
- Flask-SQLAlchemy 3.1.1 — ORM, models in `backend/app/models/`
- Flask-Migrate 4.0.7 — Alembic-based schema migrations
- Flask-JWT-Extended 4.6.0 — access/refresh token auth with blocklist (`backend/app/models/token_blocklist.py`)
- Flask-SocketIO 5.3.6 — real-time WebSocket events (`backend/app/sockets/`), `async_mode='eventlet'`
- Flask-Cors 4.0.1 — CORS handling
- Flask-Limiter 3.7.0 — rate limiting, in-memory storage (`RATELIMIT_STORAGE_URI=memory://`)
- marshmallow 3.21.3 — request/response schemas (`backend/app/schemas/`)
- APScheduler 3.10.4 — used both inside the API process context and standalone in `backend/scheduler.py` for the 08:00 daily report cron job

**Frontend Core:**
- React 18.3.1 + react-dom 18.3.1
- react-router-dom 6.23.1 — client-side routing
- @tanstack/react-query 5.40.0 — server state / data fetching
- zustand 4.5.2 — client state (`frontend/src/stores/authStore.ts`, `floorStore.ts`)
- axios 1.7.2 — HTTP client (`frontend/src/api/client.ts`) with interceptor-based JWT refresh flow
- socket.io-client 4.7.5 — WebSocket client (`frontend/src/hooks/useSocket.ts`)
- i18next 26.0.6 + react-i18next 17.0.4 — i18n, English/Spanish locales (`frontend/src/i18n/en.ts`, `es.ts`, 385 keys each)
- recharts 3.8.1 — analytics charts (manager dashboards)
- react-hot-toast 2.4.1 — toast notifications
- date-fns 3.6.0, clsx 2.1.1, lucide-react 0.395.0 — utility/UI helpers

**Styling:**
- Tailwind CSS 3.4.4 + PostCSS 8.4.38 + Autoprefixer 10.4.19 — see `frontend/tailwind.config.js` ("Monochrome Crest" design system per `DESIGN.md`)

**Testing:**
- Backend: `backend/tests/` — `test_modifier_promotions.py`, `test_promo_time_window.py`, `test_promotions.py` (pytest-style tests; pytest itself is not pinned in `requirements.txt`, likely a dev-only install)
- Frontend: no test runner configured (no vitest/jest in `package.json`)

**Build/Dev:**
- Vite 7.3.3 with `@vitejs/plugin-react` — dev server proxies `/api` and `/socket.io` to `localhost:5000` (`frontend/vite.config.ts`)
- TypeScript 5.4.5, strict mode, path alias `@/*` → `src/*`
- gunicorn 22.0.0 + eventlet 0.36.1 + greenlet 3.0.3 — backend production server stack

## Key Dependencies

**Critical:**
- psycopg2-binary 2.9.9 — PostgreSQL driver
- bcrypt 4.1.3 — password hashing (`backend/app/models/user.py`)
- python-dateutil 2.9.0 — date arithmetic
- requests 2.32.3 — outbound HTTP (used for print-agent calls, `PRINT_AGENT_URL`)
- sqlalchemy 2.0.23 — used directly (not via Flask-SQLAlchemy) in `telegram-bot/bot.py` for read-only DB queries
- python-telegram-bot 20.7 — Telegram Bot API client (`telegram-bot/bot.py`)

**Infrastructure:**
- python-dotenv 1.0.1 — `.env` loading in local/dev backend runs

**Notable but unused:**
- `escpos` (python-escpos) is imported in `backend/app/services/printer_service.py` but is **not listed** in `backend/requirements.txt` — this module appears to be dead/experimental code. Actual thermal printing goes through the separate `scripts/print_agent/print_agent.py` process via HTTP, not this in-process service.

## Configuration

**Environment:**
- Root `.env` (git-ignored, referenced by `docker-compose.yml` via `${VAR:-default}` interpolation) drives all services.
- Backend config object: `backend/app/config.py` (`Config` class reads `os.environ` with defaults).
- Key config groups: DB (`DATABASE_URL`), auth (`SECRET_KEY`, `JWT_REFRESH_SECRET`), billing (`BILLING_MODE`, `POOL_RATE_CENTS`, `HAPPY_HOUR_*`, `CURRENCY`), SMTP (`SMTP_HOST/PORT/USER/PASSWORD`, `REPORT_FROM`, `REPORT_TO`), operational role passwords/PINs (`ADMIN_PASSWORD`, `ADMIN_PIN`, `MANAGER_PASSWORD`, `MANAGER_PIN`, `WAITER1_PASSWORD`, `WAITER2_PASSWORD`, `KITCHEN_PASSWORD`, `BARSTAFF_PASSWORD` — seeded via `backend/seed.py`), print agent (`PRINT_AGENT_URL`).
- Frontend build-time env: `VITE_API_URL`, `VITE_SOCKET_URL` (injected as Docker build args in `frontend/Dockerfile`, default `/api/v1` and `/`).
- `backend/.flaskenv` sets `FLASK_APP=wsgi.py` for local `flask` CLI use.

**Build:**
- `docker-compose.yml` (repo root) orchestrates 5 services: `postgres`, `backend`, `frontend`, `scheduler`, `telegram-bot`, all on a shared `billiardbar_net` bridge network.
- `backend/Dockerfile` — non-root user (`appuser`), healthcheck against `/api/v1/auth/me`.
- `frontend/Dockerfile` — multi-stage: `node:20-alpine` build → `nginx:1.27-alpine` runtime.
- `telegram-bot/Dockerfile` — minimal `python:3.11-slim`, no healthcheck.
- `frontend/nginx.conf` — reverse-proxy/static config for the built SPA.

## Platform Requirements

**Development:**
- Docker + docker-compose (primary local dev path, per `README.md` / `scripts/start.sh`)
- Alternatively: Python 3.11 + Node 20 + local PostgreSQL 15 for running services outside containers
- Windows host required for the print agent (`scripts/print_agent/print_agent.py`, uses `pywin32`, only runs natively on Windows — cannot run inside the Linux backend container)

**Production:**
- Docker Compose deployment (self-hosted, likely on-site Windows or Linux host given the Windows-specific print agent and PowerShell ops scripts in `scripts/`)
- PostgreSQL 15 (`postgres:15-alpine` image)
- Timezone-pinned to `America/Mexico_City` (`TZ` env var, used consistently in billing, scheduler, and reporting logic)
- Currency: MXN (Mexican Pesos), amounts stored as integer cents throughout (`*_cents` columns/fields)

---

*Stack analysis: 2026-08-08*

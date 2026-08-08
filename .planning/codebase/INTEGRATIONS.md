# External Integrations

**Analysis Date:** 2026-08-08

## APIs & External Services

**Telegram (live integration):**
- Telegram Bot API — `telegram-bot/bot.py` (33K+ lines script, uses `python-telegram-bot` 20.7)
  - Purpose: operational alerts/notifications sent to a Telegram chat (admin monitoring)
  - Auth: `TELEGRAM_TOKEN` env var (bot token), `ADMIN_CHAT_ID` env var (destination chat)
  - Data access: connects directly to the shared PostgreSQL database via SQLAlchemy 2.0 (`DATABASE_URL`), independent of the Flask backend process
  - Deployment: separate Docker service (`telegram-bot` in `docker-compose.yml`)

**Rappi (planned, NOT yet implemented):**
- `rapi.md` (repo root) is a detailed integration specification for Rappi's delivery-order REST API (OAuth2 client_credentials via `rests-integrations.auth0.com`, order polling/webhooks, SKU mapping, order lifecycle callbacks). This describes a **future** integration, not code currently in the repo.
- Current state in code is limited to a manual reference field:
  - `backend/app/models/ticket.py:17` — `rappi_order_id` column on `Ticket`, required only when `ticket_type == 'DELIVERY'`
  - `backend/app/api/tickets.py:161-184` — validates presence of `rappi_order_id` for delivery tickets, stores it as free text (staff manually enter the Rappi order ID; no API calls to Rappi occur)
  - `backend/app/api/earnings.py:133-167` — aggregates `ingresos_rappi_cents` (Rappi revenue) for the earnings/reporting view, purely from locally-entered ticket data
  - No OAuth client, no webhook receiver, no `rappi_sku` mapping table exists yet.

## Data Storage

**Databases:**
- PostgreSQL 15 (`postgres:15-alpine` in `docker-compose.yml`)
  - Connection: `DATABASE_URL` env var, format `postgresql://user:pass@postgres:5432/db`
  - ORM/Client: Flask-SQLAlchemy 3.1.1 (backend), raw SQLAlchemy 2.0 engine (telegram bot)
  - Migrations: Flask-Migrate (Alembic) — migration scripts under `scripts/migrations/`
  - Heavy use of raw SQL via `db.session.execute(text(...))` for reporting/analytics (e.g. `backend/app/services/email_report_svc.py`, `backend/app/api/earnings.py`, `backend/app/analytics_views.py`), including custom SQL views referenced directly: `v_bola8_pagos_desglosados`, `v_bola8_lineas_venta`, `kpis_diarios`
  - Seed data: `backend/seed.py` (creates default users/roles from env-configured passwords/PINs)

**File Storage:**
- Local filesystem only — no S3/cloud object storage detected. Print jobs, receipts, and reports are generated on the fly (HTML email, ESC/POS byte streams) and not persisted to blob storage.

**Caching:**
- None (Flask-Limiter uses `memory://` in-process storage for rate limiting, not a shared cache like Redis)

## Authentication & Identity

**Auth Provider:**
- Custom, self-hosted JWT auth (no third-party identity provider)
  - Implementation: Flask-JWT-Extended (`backend/app/extensions.py`), access + refresh token pair
  - Access token TTL: `JWT_ACCESS_HOURS` env var (default 8h)
  - Refresh secret is separate from access-token secret: `JWT_REFRESH_SECRET` vs `SECRET_KEY`
  - Token revocation: `backend/app/models/token_blocklist.py` — DB-backed blocklist checked on every request via `@jwt.token_in_blocklist_loader` (`backend/app/extensions.py:17-26`)
  - Password hashing: bcrypt (`backend/app/models/user.py`)
  - Role/PIN-based staff auth: additional PIN codes per role for quick in-app manager overrides (`ADMIN_PIN`, `MANAGER_PIN` env vars), separate from primary login passwords
  - Frontend token lifecycle: `frontend/src/api/client.ts` — axios interceptor auto-refreshes on 401, queues concurrent requests during refresh, redirects to `/login` on refresh failure
  - Frontend token storage: `frontend/src/stores/authStore.ts` (zustand)

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry/Bugsnag/etc. detected)

**Logs:**
- Python `logging` module, stdout-based, per-service format strings (e.g. `backend/scheduler.py` uses `[scheduler]` prefix)
- `LOG_LEVEL` env var controls backend log verbosity
- No centralized log aggregation service integrated

## CI/CD & Deployment

**Hosting:**
- Self-hosted via Docker Compose (`docker-compose.yml`) — no cloud provider (AWS/GCP/Azure) integration detected in current code, though `backend/app/# Billar POS → SaaS + AWS Migration: Tec.md` indicates AWS migration is a documented future plan, not implemented
- Windows-specific deployment tooling present (`scripts/*.ps1`: autostart, NSSM service install for the print agent, static IP setup, health checks) — suggests production runs on a Windows machine on-site (e.g., at the bar) with Docker Desktop, plus a native Windows print agent process

**CI Pipeline:**
- None detected (no `.github/workflows/`, `.gitlab-ci.yml`, or similar in the repo)

## Environment Configuration

**Required env vars (backend, from `docker-compose.yml` / `backend/app/config.py`):**
- `DATABASE_URL`, `SECRET_KEY`, `JWT_REFRESH_SECRET`
- `BILLING_MODE`, `POOL_RATE_CENTS`, `HAPPY_HOUR_START`, `HAPPY_HOUR_END`, `HAPPY_HOUR_DISCOUNT_PCT`, `CURRENCY`, `TZ`
- `ADMIN_PASSWORD`/`ADMIN_PIN`, `MANAGER_PASSWORD`/`MANAGER_PIN`, `WAITER1_PASSWORD`, `WAITER2_PASSWORD`, `KITCHEN_PASSWORD`, `BARSTAFF_PASSWORD`
- `PRINT_AGENT_URL` (defaults to `http://host.docker.internal:9191`)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `REPORT_FROM`, `REPORT_TO`
- `LOG_LEVEL`, `FLASK_ENV`

**Required env vars (telegram-bot):**
- `TELEGRAM_TOKEN`, `ADMIN_CHAT_ID`, `DATABASE_URL`

**Required env vars (frontend, build-time only):**
- `VITE_API_URL`, `VITE_SOCKET_URL`

**Secrets location:**
- Root `.env` file (git-ignored, present locally at repo root — contents not read/quoted per policy)
- No secrets manager (Vault/AWS Secrets Manager/etc.) integrated — all secrets flow through plain environment variables

## Webhooks & Callbacks

**Incoming:**
- None currently implemented. (The planned Rappi integration in `rapi.md` describes an incoming `order.created` webhook endpoint, but this endpoint does not exist in `backend/app/api/` yet.)

**Outgoing:**
- Print Agent HTTP calls: backend → `PRINT_AGENT_URL` (default `http://host.docker.internal:9191`), a local Flask service (`scripts/print_agent/print_agent.py`) running on the Windows host outside Docker. Used for:
  - `POST {PRINT_AGENT_URL}/chit` — kitchen/bar chit printing (`backend/app/api/queue.py:167`, `backend/app/api/tickets.py:54`)
  - `POST {PRINT_AGENT_URL}/print` — general receipt printing (`backend/app/api/tickets.py:1454`, `1518`)
  - The print agent talks to a physical ESC/POS thermal printer via USB/Bluetooth on the Windows host; implements job-id based dedup (60s TTL) to avoid duplicate prints on retry.
- SMTP outbound: backend/scheduler → Gmail SMTP (`smtp.gmail.com:587`) for the daily sales report email (`backend/app/services/email_report_svc.py`), triggered by APScheduler cron at 08:00 `America/Mexico_City` (`backend/scheduler.py`) or manually via `flask daily-report` CLI command.
- Socket.IO (internal, not third-party): backend emits real-time events to the frontend over WebSocket (`backend/app/sockets/`, `flask_socketio`, `async_mode='eventlet'`); frontend connects via `frontend/src/hooks/useSocket.ts` (`socket.io-client`, path `/socket.io` proxied through nginx in production).

---

*Integration audit: 2026-08-08*

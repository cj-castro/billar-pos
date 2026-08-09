# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branch safety — read before any git operation

`main` and `ui-refactor-goldy` reflect what's built and deployed for the **live, currently-running POS at the bar**. Do not check out, commit to, merge into, or push to `main`, `ui-refactor-goldy`, or any other pre-existing branch unless the user explicitly asks you to work on that specific branch — doing so risks breaking the running system.

Infrastructure/rewrite efforts (e.g. the Rust backend migration) live on their own dedicated branch, branched off `ui-refactor-goldy` (it has the latest UI): currently `rust-backend-migration`. Stay on the branch you were told to work on for the task at hand; if unsure which branch you should be on, ask before switching or committing.

## Production access (bar machine)

The live bar machine is reachable remotely via an ngrok TCP tunnel, used for on-site diagnostics and pulling backups. Connection details live in the root `.env` (git-ignored — never commit or paste these values into any tracked file): `BAR_MACHINE_NGROK_URL` (ngrok `tcp://` forward to port 22/SSH), `BAR_MACHINE_USERNAME1`, `BAR_MACHINE_USERNAME2`, `BAR_MACHINE_PASSWORD`. As of 2026-08-08, only `BAR_MACHINE_USERNAME2` (`bola8lacalma`) is a confirmed-working SSH login; `BAR_MACHINE_USERNAME1` (`bola8poolclub`) failed 3 auth attempts and may need its password checked/rotated.

The live Postgres container (`billiards-postgres-1`) does **not** publish port 5432 to the host — it's reachable only inside the Docker/k3s network on that machine. To pull data out, run `pg_dump` *inside* the container over the SSH tunnel and stream the output straight to a local file — never write dump files on the bar machine itself:

```bash
ssh -p <ngrok_port> bola8lacalma@<ngrok_host> \
  'docker exec -e PGPASSWORD=<POSTGRES_PASSWORD> billiards-postgres-1 pg_dump -U <POSTGRES_USER> -Fc -d <POSTGRES_DB>' \
  > backups/billiardbar_prod_$(date +%Y%m%d_%H%M%S).dump
```

`pg_dump` only takes non-blocking `ACCESS SHARE` locks, so it's safe to run against the live database without interrupting ticket/order operations (confirmed 2026-08-08: 34MB DB, ~4s dump, container uptime unaffected by the pull). Dumps land in `backups/*.dump` (git-ignored) — this is live customer/financial data and must never be committed.

The bar machine's actual container runtime is Rancher Desktop/k3s (confirmed via `docker ps` showing `k8s_*`/`rancher/mirrored-pause` system pods alongside the `billiards-*` app containers), not a plain `docker compose` host — relevant to Phase 5's eventual Docker/Rancher uninstall (CUT-03).

This is genuine production access to hardware serving the bar in real time. Treat every command run over this tunnel with at least the same care as the branch-safety rule above — read-only diagnostics and backups are fine to run directly, but confirm with the user before anything that could restart a service, change config, or otherwise touch the running system.

## Staging machine access (Phase 2 core-service-migration)

A separate Windows 11 staging machine (`WIDOWSVAIL`, hostname is lowercased in Windows SSH output as `widowsvail`) is used to install and validate the native-Windows-Services replacement for Docker/Rancher (SVC-01 through SVC-05, NET-01, DATA-01) **before** anything touches the live bar machine — see D-01/D-02/D-03 in `.planning/phases/02-core-service-migration/02-CONTEXT.md`. Unlike the bar machine, this is a disposable test environment: install/reinstall/break things freely here, that's its purpose.

Reachable directly over LAN via plain OpenSSH (Windows' built-in `OpenSSH_for_Windows` server, not a tunnel). Connection details live in the root `.env` (git-ignored — never commit or paste these values into any tracked file): `STAGING_MACHINE_IP`, `STAGING_MACHINE_USERNAME`, `STAGING_MACHINE_PASSWORD`. Confirmed working (2026-08-08) — plain `username@ip` login (no domain/machine prefix needed), password auth. SSH sessions on this account arrive already-elevated (Administrator) with no UAC prompt, which is what makes it possible to drive `#Requires -RunAsAdministrator` installer scripts (like `scripts/install-all-native-services.ps1`) directly over SSH — a human physically at the console is not required. Occasional transient "Permission denied" on the first connection attempt has been observed; a quick retry with the same credentials succeeds — not a real auth problem.

`STAGING_MACHINE_IP` is DHCP-assigned and **changes** when the machine sleeps/reconnects (confirmed 2026-08-08: `192.168.1.15` → `192.168.1.20` after one sleep cycle). If SSH suddenly gives "Host is down" / connection timeout after previously working, check for an IP change before assuming the machine is actually off — ask the user for the current IP and update `.env`.

The machine runs Windows PowerShell 5.1 (`$PSVersionTable.PSVersion` → `5.1.x`, i.e. Windows PowerShell, not PowerShell 7/Core) — any script intended to run here must stick to PS 5.1-compatible syntax (e.g. no `ConvertFrom-Json -AsHashtable`, which is PS 6+ only).

```bash
sshpass -p "$STAGING_MACHINE_PASSWORD" ssh -o StrictHostKeyChecking=accept-new \
  "${STAGING_MACHINE_USERNAME}@${STAGING_MACHINE_IP}" "<command>"
```

## What this is

A self-hosted Point-of-Sale and floor-management system for a billiards/pool bar (BilliardBar POS). Floor-map table management, pool-table timer billing, ticket/order management, kitchen & bar queues, inventory, promotions, cash sessions, and manager reporting. Deployed on-site as a Docker Compose stack, with a Windows-hosted print agent running outside Docker.

## Commands

### Full stack (Docker)

```bash
cp .env.example .env       # first-time setup — edit secrets before real use
docker compose up --build  # start postgres, backend, frontend, scheduler, telegram-bot
./scripts/start.sh         # same, plus waits for Docker daemon + healthy state (used for autostart)
./scripts/stop.sh
```

### Backend (Python 3.11, standalone dev)

```bash
cd backend
pip install -r requirements.txt
flask init-db        # idempotent schema setup — NOT `flask db upgrade`; see Architecture below
python seed.py        # demo/initial data (creates default role users from env passwords/PINs)
flask run --debug
```

Other `flask` CLI commands (registered in `backend/app/__init__.py`): `restate-costs`, `daily-report`, `seed-beer`, `seed-buckets`.

### Frontend (Node 20, standalone dev)

```bash
cd frontend
npm install
npm run dev       # Vite dev server, proxies /api and /socket.io to localhost:5000
npm run build      # tsc && vite build
npm run preview
```

No lint/format script exists in either service — there is no ESLint/Prettier/Black/Ruff config. Match the surrounding code's style rather than reformatting or introducing new lint tooling unilaterally.

### Tests

There is no pytest/vitest/jest test runner configured anywhere in the repo. Tests are hand-rolled scripts run directly:

```bash
# Backend — pure-logic promotion engine tests (no DB required)
cd backend && python -m tests.test_promotions
cd backend && python -m tests.test_promo_time_window
cd backend && python -m tests.test_modifier_promotions

# Backend — HTTP-level integration checks against a live Postgres instance
# (DATABASE_URL is hardcoded inside these scripts to a local posverify DB on port 55432)
cd backend && python verify_api2.py
cd backend && python verify_confirm.py
```

Test coverage is thin and concentrated on the promotion engine (`backend/tests/`, 3 files). There is no frontend test framework — `npm run` has no `test` script. When adding backend tests, follow the existing pattern: plain `test_*` functions using a local `check(label, condition, detail)` helper (no `pytest.raises`, no assertion library), called explicitly from `main()`. See any file in `backend/tests/` for the shape.

## Architecture

**Layered monolith, not microservices.** One primary Flask backend (REST + Socket.IO) behind a React SPA, plus three sibling processes that share the same Postgres database directly with no API boundary between them:
- `backend/scheduler.py` — separate container, fires the daily sales-report email at 08:00 `America/Mexico_City` via APScheduler
- `telegram-bot/bot.py` — separate container, independent of the Flask app, reads/writes the same DB for operational alerts
- `scripts/print_agent/print_agent.py` — Windows-only, runs **outside Docker** on the POS host machine; the backend POSTs print jobs to it over HTTP (`PRINT_AGENT_URL`, default `http://host.docker.internal:9191`); printing is fire-and-forget and never blocks ticket operations

Request flow: `backend/app/api/*.py` blueprints (HTTP, auth/role checks, orchestration) → `backend/app/services/*.py` (business logic: billing, inventory deduction, promotions, audit, printing, email reports) → `backend/app/models/*.py` (SQLAlchemy ORM, `to_dict()` defines wire format). No repository/DAO layer — blueprints call services and models directly.

**Real-time updates are Socket.IO-first, not polling.** Blueprint handlers emit events (`floor:update`, `kitchen:item_update`, `print:failed`, etc.) after `db.session.commit()`; the frontend's `frontend/src/hooks/useSocket.ts` translates them into TanStack Query cache invalidations. `backend/app/sockets/events.py` only handles connection lifecycle and room auth (`floor`, `kitchen`, `bar`, `waiting`, `manager`, `ticket:<id>` rooms) — domain events are emitted from the API blueprints, not from the socket handlers themselves.

**Schema changes are NOT Alembic migrations**, despite `Flask-Migrate` being a dependency. All DDL lives as ~26 sequential, idempotent "STEP" blocks of raw SQL inside the `flask init-db` CLI command in `backend/app/__init__.py` (guarded with `information_schema`/`pg_constraint` existence checks, safe to re-run on every container start). When adding new schema, add a new STEP block following the existing idempotent pattern (`IF NOT EXISTS` checks) rather than introducing a real Alembic revision — that would be inconsistent with how every other table/column in this codebase was added. `scripts/migrations/` holds one-off manual SQL scripts that are NOT run automatically.

**Single eventlet worker.** The backend runs `gunicorn --worker-class eventlet -w 1`. All request handling and background work is cooperatively scheduled on one OS thread — background work (e.g. auto-print dispatch) MUST use `socketio.start_background_task`, never `threading.Thread`, or it breaks eventlet's scheduler (see the explicit comment in `backend/app/api/tickets.py` near `_spawn_auto_print_chit`).

**Ticket is the central aggregate.** `backend/app/models/ticket.py` — one OPEN ticket per `resource_id`, enforced by a DB partial unique index (`uq_tickets_open_per_resource`). `ticket_type` discriminates between a table tab (`TABLE`), a walk-up sale (`EXPRESS`), and a delivery order (`DELIVERY`, currently just a manually-entered `rappi_order_id` — see below). Mutating routes use `Model.query.with_for_update().get_or_404(id)` for row locking, and check an `X-Ticket-Version` header against `ticket.version` for optimistic concurrency (`{'error': 'VERSION_CONFLICT'}, 409` on mismatch). Almost all ticket logic lives in `backend/app/api/tickets.py` (~1550 lines) — this is the established pattern for this codebase (full request lifecycle inline: validate → lock → mutate → recompute → audit log → commit → emit sockets → respond); don't force-decompose it purely for line-count reasons.

**Rappi delivery integration is a spec, not code.** `rapi.md` at the repo root describes a full OAuth2/webhook/SKU-mapping integration. The actual code only has a free-text `rappi_order_id` field on delivery tickets — no API client, no webhook receiver exists. Don't assume any Rappi API code is present; check before referencing it.

**Money is always integer cents** (`price_cents`, `total_cents`, `*_cents` columns/fields) — never floats, converted to display currency only at the render boundary (`frontend/src/utils/money.ts` → `formatMXN`). Currency is MXN, timezone is pinned to `America/Mexico_City`.

**Error responses:** backend routes return `jsonify({'error': CODE, 'message': '...'}), status` — `error` is a machine-readable UPPER_SNAKE code the frontend matches against (`OUT_OF_STOCK`, `VERSION_CONFLICT`, `RESOURCE_OCCUPIED`), `message` is often user-facing Spanish text. No centralized Flask error handler; each route shapes its own errors. Frontend's `frontend/src/api/client.ts` axios interceptor centrally handles 401s (queue + single retry + silent refresh) — new API calls don't need their own 401 handling.

**Auth:** custom JWT (`flask-jwt-extended`), access + refresh token pair, plus per-role PIN codes for quick in-app manager overrides. Role checks are ad hoc per-route (`claims.get('role') not in (...)`), not a shared decorator — when adding a new mutating endpoint, check a comparable existing blueprint for the role-check pattern and don't skip it (see `.planning/codebase/CONCERNS.md` for `suppliers.py`, where this was missed).

**Frontend state split:** server state → TanStack Query; small cross-page global state → Zustand (`frontend/src/stores/authStore.ts` persisted session, `floorStore.ts` denormalized floor-map cache fed by sockets); everything else → local `useState`. Single axios instance in `frontend/src/api/client.ts` — don't create a second one. No barrel/index re-export files for `components/`, `hooks/`, `stores/`, or `utils/` — import directly from the source file.

**Bilingual UI (ES/EN):** `frontend/src/i18n/es.ts` and `en.ts` are hand-kept in parallel key structure — add the same key to both when adding UI copy.

## Deeper reference

`.planning/codebase/` has a full generated map of this repository (architecture, stack, structure, conventions, testing, integrations, and known concerns/tech-debt) — read the relevant doc there before large changes:
- `ARCHITECTURE.md`, `STRUCTURE.md` — component responsibilities, data flow, where to add new code
- `CONVENTIONS.md`, `TESTING.md` — naming, error-handling, and test patterns in more detail
- `STACK.md`, `INTEGRATIONS.md` — dependencies, env vars, external services
- `CONCERNS.md` — known tech debt, security gaps, and fragile areas (default credentials in `docker-compose.yml`, wide-open CORS, unauthenticated Socket.IO connects, JWTs in `localStorage`, unauthenticated print agent, missing role check on `suppliers.py`, recurring "ghost ticket" data-corruption pattern with recovery tooling in `RECOVERY.md`)

`.planning/PROJECT.md` has the current project scope and requirements status (no active milestone/roadmap defined yet as of this writing).

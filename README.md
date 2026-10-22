# 🎱 BilliardBar POS System

A full-featured Point-of-Sale and Floor Management system for a billiard pool bar.

## Features

- **Floor Management** — Live view of pool tables, regular tables, bar seats
- **Pool Table Time Billing** — 3 modes: Per Minute, Round-to-15, Per Hour
- **POS** — Tickets with items, modifiers, flavors, promotions
- **Kitchen & Bar Queues** — Real-time order routing and status tracking
- **Inventory** — Automatic deduction on order, reversal on void
- **Promotions** — Happy hour, item discounts, pool time promos
- **Reporting** — Sales, pool time, payments — exportable CSV/JSON
- **Real-time** — Socket.IO powered live updates across all devices
- **Role-based Access** — Waiter, Kitchen, Bar, Manager, Admin

## Quick Start

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env with your secrets

# 2. Start everything
docker compose up --build

# 3. Open the app
open http://localhost
```

## Default Credentials

| User | Password | PIN | Role |
|---|---|---|---|
| admin | admin123 | 1234 | Admin |
| manager | manager123 | 5678 | Manager |
| waiter1 | waiter123 | — | Waiter |
| kitchen | kitchen123 | — | Kitchen Staff |
| barstaff | bar123 | — | Bar Staff |

## Stack

- **Backend**: Python 3.11 + Flask + Flask-SocketIO + SQLAlchemy
- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Database**: PostgreSQL 15
- **Real-time**: Socket.IO (WebSocket)
- **Container**: Docker + Docker Compose

## API

Base URL: `http://localhost/api/v1`

Key endpoints:
- `POST /auth/login` — Login
- `GET /resources` — Floor map
- `POST /tickets` — Open ticket
- `POST /tickets/{id}/items` — Add item
- `POST /tickets/{id}/transfer` — Transfer to another table
- `POST /tickets/{id}/send-order` — Send to kitchen/bar
- `POST /tickets/{id}/close` — Payment & close
- `GET /queue/kitchen` — Kitchen queue
- `GET /reports/sales` — Sales report

## Architecture

```
Browser → nginx (frontend) → Flask API (backend) → PostgreSQL
                          ↕ Socket.IO (WebSocket)
```

## Development

```bash
# Backend only (with hot reload)
cd backend
pip install -r requirements.txt
flask db upgrade
python seed.py
flask run --debug

# Frontend only (with hot reload)  
cd frontend
npm install
npm run dev
```

## FRESH INSTALL

Phase 1 — build the template (on the bar's POS, where the real menu lives)

Set-ExecutionPolicy -Scope Process Bypass

cd C:\Users\bola8lacalma\Desktop\POS\billiards
.\scripts\deploy\New-FactoryTemplate.ps1

Read-only on the live DB — all work happens in a throwaway  factory_build  database that's dropped even on failure. Output lands in  backups\factory-template_<timestamp>.dump  (~0.3 MB). Re-run this whenever the menu changes.

Phase 2 — provision a new machine

# 1. clone/copy the repo, then create .env (passwords, POSTGRES_*, JWT secret)
cd C:\Users\bola8lacalma\Desktop\POS\billiards
copy .env.example .env
notepad .env

# 2. start ONLY the database
docker compose up -d postgres

# 3. load the template
.\scripts\deploy\Restore-Database.ps1 -DumpFile "D:\path\factory-template_20260923_101500.dump"

# 4. bring the app up
docker compose up -d

On that first boot the entrypoint does:  init-db  →  seed.py  (skips, users exist) →  factory-finalize  (writes credentials from  .env ) →  apply-migrations  (28 already present, 0 failed).

Phase 3 — verify before trading

.\scripts\deploy\Invoke-Migrations.ps1 -VerifyOnly

Expect 28 applied and all six invariants  0 . Then log in as  admin  with the  ADMIN_PASSWORD  from that machine's  .env .

Two things to know:

• Stock ships at zero — deliberate, since stock is machine-specific. Count it in via Inventory → restock before selling, otherwise everything shows agotado.
• Order matters. The template must be restored before the backend first starts. If the backend boots against an empty DB first,  seed.py  writes its demo wings menu and you'd have to  docker compose down -v  and start over.

Copy the  .dump  on a USB stick — it doesn't contain passwords or sales history, just menu, recipes, modifiers, and the migration ledger.

## Offsite backup (S3)

The `backup` service runs `pg_dump -Fc` every night at 04:30 (America/Mexico_City) and uploads it to S3 as `<S3_PREFIX>/billiardbar_<YYYY-MM-DD_HHMM>.dump`. If the last successful backup is older than 24h when the container starts (e.g. the PC was off at 04:30), it runs one immediately. The Windows 04:00 plain-SQL dump is separate and untouched.

Add to `.env` BEFORE pulling this change. Every `docker compose` command fails if the four required ones are missing, not just this service:

AWS_ACCESS_KEY_ID=...        (required, PutObject-only key)
AWS_SECRET_ACCESS_KEY=...    (required)
AWS_REGION=us-east-1         (required, the bucket's region)
S3_BUCKET=my-bucket          (required)
S3_PREFIX=billiardbar        (optional, default billiardbar)

Build and start only this service:

docker compose up -d --no-deps --build backup

`--no-deps` stops compose from touching postgres, backend and the rest; only `backup` is built and (re)created.

Status and logs:

docker compose ps backup              # "healthy" = a backup succeeded in the last 26h
docker logs billiards-backup-1        # timestamped "OK: ..." or "BACKUP FAILED: ..." lines

Run one by hand (output shows in your terminal, not in `docker logs`):

docker compose exec backup backup.sh

Restore from S3 (the key is write-only, so download with an admin AWS login):

aws s3 cp s3://my-bucket/billiardbar/billiardbar_2026-10-22_0430.dump .
pg_restore --list billiardbar_2026-10-22_0430.dump > $null    # must print no error
.\scripts\deploy\Restore-Database.ps1 -DumpFile .\billiardbar_2026-10-22_0430.dump

Restore-Database.ps1 stops `backup` along with backend/scheduler/telegram-bot while it works. It only reads `-Fc` dumps: the legacy `.sql` files from the 04:00 Windows task cannot be restored with it (use `psql -f` for those).

The last-success marker lives inside the container, so recreating it forgets the marker and triggers one catch-up backup.

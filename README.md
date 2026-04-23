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

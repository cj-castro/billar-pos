# Deployment Instructions — Session 2026-04-23

## Package
`update_session_20260423_120026.zip`

---

## Step 1 — DB Migrations (run FIRST, before rebuilding containers)

**PowerShell (Windows):**
```powershell
docker exec -i billiards-postgres-1 psql -U billiard -d billiardbar -c "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_source VARCHAR(10);" -c "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_cash_cents INTEGER;" -c "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_card_cents INTEGER;" -c "ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS floor_resource_id VARCHAR(36) REFERENCES resources(id);" -c "ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS floor_ticket_id VARCHAR(36) REFERENCES tickets(id);"
```

**Bash/Mac (alternative):**
```bash
docker exec -i billiards-postgres-1 psql -U billiard -d billiardbar << 'SQL'
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_source VARCHAR(10);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_cash_cents INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_card_cents INTEGER;
ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS floor_resource_id VARCHAR(36) REFERENCES resources(id);
ALTER TABLE waiting_list ADD COLUMN IF NOT EXISTS floor_ticket_id VARCHAR(36) REFERENCES tickets(id);
SQL
```

Expected output (all 5 lines should say `ALTER TABLE`):
```
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
```

> **Note:** All statements use `IF NOT EXISTS` — safe to re-run multiple times.

---

## Step 2 — Deploy Files

Unzip the package and overwrite files in the project directory:

```
update_session_20260423_120026.zip
├── backend/app/api/
│   ├── cash_session.py    ← Ghost count in /status; tip split in _build_summary; expense endpoint
│   ├── queue.py           ← GET /queue/counts endpoint (kitchen/bar badge counts)
│   ├── tickets.py         ← POST /clean-ghosts; fix open-all 500 (resource_code attr error)
│   └── waiting_list.py    ← floor_resource_id / floor_ticket_id FK support
├── backend/app/models/
│   ├── ticket.py          ← tip_cash_cents/tip_card_cents columns; waiting_list_entry OR query fix
│   └── waiting_list.py    ← floor FK columns
└── frontend/src/
    ├── App.tsx
    ├── index.css           ← .page-root mobile bottom padding
    ├── components/
    │   ├── NavBar.tsx      ← Mobile bottom tab bar; queue count badges; account popup
    │   ├── AddItemModal.tsx
    │   ├── ManagerBackButton.tsx
    │   ├── ResourceCard.tsx
    │   └── WaitingListPanel.tsx  ← Hide join-waitlist button if already on list
    ├── pages/
    │   ├── TicketPage.tsx       ← Split tip inputs; tip source always visible; modal scroll+sticky footer
    │   ├── FloorMapPage.tsx
    │   ├── KitchenQueuePage.tsx ← Invalidates queue-counts on status change
    │   ├── BarQueuePage.tsx     ← Invalidates queue-counts on status change
    │   ├── LoginPage.tsx
    │   └── manager/
    │       ├── CashSessionPage.tsx  ← Ghost panel with real/ghost breakdown + 🧹 cleanup button
    │       └── (all other manager pages — page-root class for mobile padding)
    └── stores/floorStore.ts
```

---

## Step 3 — Rebuild & Restart

```bash
cd /path/to/billiards

# Rebuild both images
docker compose build --no-cache frontend backend

# Restart all containers
docker compose up -d
```

---

## What's New

### Features
- **Queue badge counts** — Kitchen and Bar nav links show live item counts
- **Mobile bottom tab bar** — Sticky bottom navigation on phones (replaces hamburger)
- **Split tip inputs** — When split payment is selected, enter tip-from-cash and tip-from-card separately
- **Ghost ticket cleanup** — Manager dashboard shows real vs ghost open tickets; one-click 🧹 auto-close
- **Waitlist button hidden** — If table is already on waiting list, button no longer appears on ticket

### Bug Fixes
- `GET /tickets/open-all` → was crashing with 500 (AttributeError: resource_code); fixed
- Waiting list `to_dict()` — was missing `floor_ticket_id` FK check; tables now show correct waiting list status
- Split payment — tip source selector was hidden when split payment was active; now always visible
- Payment modal — now scrollable with sticky confirm button (was cut off on small screens)
- Ghost tickets blocking bar close — manager can identify and clean them up in one click

### Test Results
44/44 API tests passing (auth, sessions, floor, tickets, menu, queues, discounts, roles, payments, reports).

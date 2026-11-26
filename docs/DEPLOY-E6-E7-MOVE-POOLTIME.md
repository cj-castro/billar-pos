# Batches E6 (move lines) + E7 (pool time) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. One migration (`055`). Ships after E5 — **in the same bundle** (see the startup fix below).

## E6 — "↔ Mover" a line to another account

About 60 voids were really moves ("cambio de mesa", "pago por separado",
"cambio por cubeta"): a line was voided on one account and typed again on
another, which counted as a loss and churned the stock.

Now each ticket line has **↔ Mover**: choose how many (if more than 1) and the
destination — any open account, or **"Cuenta nueva (pago por separado)"** with a
name. Nothing is voided, returned to stock or retyped: the money and the
recorded cost move with the line (split proportionally when only part moves).
Staff orders can't mix with customer accounts. Audited as `ITEMS_MOVED`.

A line that has extras with a price, or is a cortesía, moves whole.

## E7 — pool time on the ticket

| | Before | After |
|---|---|---|
| Players stop but stay (drinks) | only by closing or transferring the ticket | **⏹ Detener tiempo**: time charged up to now, the account stays open on the table. The floor card shows **⏸ Tiempo detenido** |
| They play again | not possible | **▶ Nuevo tiempo**: a new session on the same table. The table's free minutes apply **once per visit**, not per session |
| Wrong start / end | backend only, no screen, reason optional | **✏️ Corregir horas** (bar-local times): reason required; a manager logged in or a manager PIN; no overlap with the account's other sessions, nothing in the future; charge recalculated by the same rules as the close; marked "✏️ corregido" |
| Amount while running | the screen's own guess (rate × time — ignored free minutes and billing mode) | **the server's estimate**, same rules as the close ("hasta ahora") |
| A cancelled timer ("abierta por error") | showed start → cancel as played time (e.g. "502h", $0) | **"Cancelado — sin cargo"**, dimmed; can't be edited into a charge |

Each session shows its start–end time; the header total is the sum of what
will be charged.

### 🎱 Tiempo de billar gratis (sin promoción) — migration 055

In the **Descuento** box of any account with pool time: **30 min · 1 hora ·
2 horas · [n] min** → reason (same list as Cortesía) → manager/admin PIN. The
minutes come off the running game, or the last one played if the time is
stopped (its charge is recalculated). Shown as "🎁 60 min gratis · Cumpleaños"
with **Quitar** (PIN). Above the owner's comp limit (Ajustes → Límites) only the
owner's PIN works. Reported in **Cortesías y personal** as a cortesía: table
time at its rate, never more than was played, cost $0. Stored apart from the
table's configured free minutes (`manual_free_*` columns), so the report tells a
gift from the house rule.

### ⚠ Startup fix (affects E5)

The app's startup (`flask init-db`, every start) re-created the "an open ticket
needs a table" constraint allowing only EXPRESS / DELIVERY — silently undoing
migration 054 on the first restart, after which **staff orders could not be
opened**. Fixed in `app/__init__.py`; `tests.test_comps_staff` now runs the
startup and checks it. Ship E5 and this batch together.

## Files

Backend: `migrations/sql/055_manual_free_pool_time.sql` (+ manifest), `app/__init__.py` (startup constraint), `app/services/ticket_ops_svc.py` (new), `app/api/tickets.py` (`/move-items`,
`/move-targets`, `/timer/stop`, `/timer/start`, `/timer/free`, edit timer rules), `app/analytics_views.py` (free time in cortesías), `app/models/ticket.py`
(`estimate_cents`, `resource_type`), `app/api/resources.py` (`timer_paused`),
`tests/test_move_and_pool.py` (new).

Frontend: `components/{MoveItemsDialog,TimerEditDialog}.tsx` (new), `pages/TicketPage.tsx`,
`components/ResourceCard.tsx`, `stores/floorStore.ts`, `utils/dates.ts`.

## Deploy

- **Phase 3:** pending list ends with **`055`**.
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler`, then `up -d`.
- **Phase 5:** `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='chk_open_ticket_has_resource'` lists `'STAFF'`.
- **Rehearsal (Mac):** `tests.test_move_and_pool` → `31 passed, 0 failed`.

## Smoke test

1. A table with 3 beers → ↔ Mover → 1 → Cuenta nueva "Juan" → Juan's account has 1 beer, the table 2.
2. A pool table → ⏹ Detener tiempo → the floor shows ⏸; ▶ Nuevo tiempo → LIVE again.
3. ✏️ Corregir horas on the first session → set start/end, reason → the amount updates.
4. Descuento box → 🎱 1 hora → Cumpleaños → PIN → the game shows "🎁 60 min gratis" and costs less.

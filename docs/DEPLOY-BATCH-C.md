# Batch C (Inicio, date bar, error states, blind count, fixed costs) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. **No migration** in this batch: backend +
frontend code only. Ships with the earlier batches (040–044).

## What changes

| | Before | After |
|---|---|---|
| **Inicio** (`/manager`) | 13 link tiles, no numbers | One page, role-aware. **Both roles:** drawer open/closed and by whom, tables in use, open tabs / asked for the bill, bottles to open (shots at 0 with sealed bottles), low stock. **Owner only:** sales of the shift vs the same window a week ago, billar / barra / cocina split, average ticket, unpaid consumption on tables, profit (or "sin costo suficiente"), alerts (voided lines, cancelled-with-consumption, force-closes, reopens, last close over/short), costs to fix. The tiles stay underneath. Refreshes every minute |
| **"Hoy"** | — | The current **shift** (since the drawer opened); calendar day if no drawer is open. Compared with the same window 7 days earlier |
| **Manager money policy** | — | Enforced by the server: a manager's `/home` response contains no money field at all |
| **Caja (manager, drawer open)** | Expected cash shown right above the count box (count-to-match) | **Blind count**: no sales, no expected cash, no per-ticket amounts until the close is submitted; then *Resultado del cierre* shows expected, counted, difference. Tips, tip split and expenses stay visible. Owner sees everything always |
| **Caja permissions** | `/cash/current/summary`, `/cash/<id>/summary`, `/cash/current/tickets` readable by **any** logged-in user (a waiter could read the night's sales) | Manager/owner only |
| **Caja history** | UTC times, no result | Local times, who closed, over/short per session; overage shown **amber** (not green) |
| **Date range** (Analítica, Reportes) | Three different defaults, no presets | One bar: Hoy · Ayer · Esta semana · Este mes · Mes pasado · 7/30/90 días; kept in the URL and shared between the two screens |
| **Errors** | A failed request showed "Sin datos" / an empty table | "No se pudo cargar … Reintentar" / "No tienes permiso"; "actualizando…" while a new range loads |
| **Costos fijos** (Analítica → Rentabilidad) | Read-only | Edit amounts inline, **Agregar**, **Quitar**; owner only, audited |
| **Ticket screen** | Stopped live-updating after a Wi-Fi blip / tablet sleep | Re-joins and refreshes on reconnect |

Follow-up (shipped with D1): managers never receive sales figures in any cash
summary, open or past, and the slip printed when a manager closes leaves the
sales lines out. They still see expected cash, counted cash and the difference
after closing.

## Files

Backend: `app/api/home.py` (new), `app/api/cash_session.py`, `app/api/analytics.py`
(fixed-cost create + audit), `app/__init__.py` (home blueprint), `tests/test_batch_c.py` (new).
Frontend: `pages/manager/ManagerDashboard.tsx` (Inicio), `pages/manager/CashSessionPage.tsx`,
`pages/manager/AnalyticsPage.tsx`, `pages/manager/ReportsPage.tsx`, `pages/TicketPage.tsx`,
`components/{DateRangeBar,QueryState}.tsx` (new), `utils/dates.ts`.

## Deploy

- **Phase 3:** nothing new to apply for C.
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler`, then `up -d`.
- **Rehearsal (Mac):** `tests.test_batch_c` on a fresh scratch copy → `19 passed, 0 failed`.

## Smoke test

1. Log in as **manager** → Inicio shows Ahora / Pendientes / Accesos, **no** money.
2. Log in as **owner** → Inicio also shows Dinero and Alertas.
3. Manager → Caja with the drawer open: no "Efectivo esperado"; close with a count → *Resultado del cierre* appears.
4. Waiter token: `/api/v1/cash/current/summary` → 403.
5. Analítica → pick *Mes pasado* → open Reportes → same range.
6. Rentabilidad → Costos fijos → add "Internet", then Quitar.

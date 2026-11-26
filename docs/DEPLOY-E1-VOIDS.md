# Batch E1 (honest voids, quantity changes by difference) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. One migration (`048`). Ships after D1/D3.

## What changes

| | Before | After |
|---|---|---|
| Voiding a sent item | **Everything went back into stock** — a poured shot, a cooked plate, an opened beer. Real losses vanished and stock was overstated | The void asks **"¿Qué pasó con el producto?"** — 🗑 *Se tiró* (default) or ↩ *Regresó al inventario*. Thrown away = written off as **waste** at the cost it was sold at; returned = back in stock. Items not yet sent: no question (nothing left stock) |
| "−" on a sent item | Reversed the **whole line** and sold it again at the new quantity | Asks the same question for the one unit removed, then only that unit moves |
| "+" on a sent item | Reversed the whole line and re-sold it, **credited to the manager** | Deducts only the added units, credited to whoever asked |
| Ledger | 1,900 reversals for 474 voided lines (the churn above); 1 waste recorded ever | One movement per real change; waste shows up in the variance report as shrinkage in pesos |
| Anulaciones report | Value voided only | Adds **Producto** (🗑 Se tiró · cost / ↩ Regresó / No se envió) and a total "Producto tirado (costo)". Voids before this deploy show "—" (unknown — every one of them was put back in stock) |

**Safety default:** a screen that doesn't send the answer (a tablet still running
the old page right after the update) is treated as *Se tiró* — it never invents
stock. Reload the tablets after the deploy.

**Nothing historical changes.** Past voids keep their reversals; only new voids
use the new rule.

## Files

Backend: `migrations/sql/048_honest_voids.sql` (+ manifest), `app/services/inventory_svc.py`
(`reverse_for_line_item` with disposition and partial units; `consume_for_line_item(units=)`),
`app/api/tickets.py` (void + quantity endpoints), `app/models/ticket.py`,
`app/api/reports.py` (voids report), `tests/test_honest_voids.py` (new), `tests/test_venue.py`.

Frontend: `pages/TicketPage.tsx` (the question on void and "−"), `pages/manager/ReportsPage.tsx`.

## Deploy

- **Phase 3:** pending list ends with **`048`**.
- **Phase 4:** `docker compose build --no-cache backend frontend`, then `up -d`.
- **After:** reload every tablet / browser tab running the POS.
- **Rehearsal (Mac):** fresh scratch copy with 040–048: `tests.test_honest_voids` → `17 passed, 0 failed`.

## Smoke test

1. Open a ticket, add 2 beers, send. Note the beer's stock in Inventario.
2. "−" → choose **↩ Regresó** → PIN: stock goes up by 1.
3. Anular the line → choose **🗑 Se tiró** → PIN: stock does **not** change.
4. Reportes → Personal y riesgos → Anulaciones (Hoy): the line shows "🗑 Se tiró · $…".
5. Add a beer and void it **before** sending: no question asked.

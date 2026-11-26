# Batch E5 (cortesías and consumo de personal) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. One migration (`054`). Ships after E4.

> ⚠ **Ship together with E6/E7.** Without its startup fix, the first restart
> re-creates a constraint without STAFF and staff orders stop opening.

## Why

A gift to a customer or an employee's drink could only be entered as a **void**
(90 lines, $50.7k, reason "void") or a **100% discount** (33 tickets, $9.2k, no
reason stored). The books couldn't tell a gift, a staff drink, a mistake and a
table change apart, and the cost of what was given away vanished.

## What changes

| | |
|---|---|
| **🎁 Cortesía** (ticket, per line) | reason (Cumpleaños, Compensación por servicio, Cliente frecuente, Promoción del dueño, Otro + text) + manager PIN. The line stays at **$0** with its list price struck through and the reason; stock moves as served; undo ("Quitar cortesía") with PIN until the ticket closes. Quantity is locked while comped |
| **🍽 Consumo de personal** (floor, next to Venta Rápida) | who + reason (Comida de turno, Bebida de turno, Capacitación / prueba, Otro) + manager PIN → an order that goes to kitchen / bar like any other, shown in teal on the floor. **"Cerrar consumo de personal"** closes it: never charged, never in the cash drawer or sales, cost recorded to that employee |
| Voids | the reason is a pick list (Error de captura, Cliente cambió de opinión, Producto con problema, Prueba, Otro); "Void" / empty is refused |
| Discounts | a reason is required and stored; choosing **100%** suggests using Cortesía instead |
| **Reportes → Personal y riesgos → Cortesías y personal** (owner) | totals at cost and at list price (% of sales), by reason, by who authorized, by employee, by product |
| Rentabilidad | cortesías and staff consumption are **their own cost lines** in net profit (no longer hidden in product margins — comped lines left the sales view) |
| Inicio (owner) / daily email | "Cortesías / personal" at cost; email section "🎁 Sin venta (a costo)" |
| Purchase forecast / variance | both count as real usage, not as shrinkage |
| **Ajustes → Límites** (owner) | cortesías above $X need the owner's PIN (0 = any manager); free staff consumption per employee per day (0 = no limit; above it the owner authorizes the close); purchase-forecast margin % |

Cash close still requires every open order closed — staff orders included. An empty staff order (opened by mistake) shows **🗑 Cancelar consumo de personal (vacío)** instead of the close button.

## Files

Backend: `migrations/sql/054_comps_staff_consumption.sql` (+ manifest), `app/services/comp_svc.py` (new),
`app/api/tickets.py` (comp / uncomp / staff open / staff close / staff-members; void & discount reasons;
STAFF never paid), `app/models/ticket.py`, `app/analytics_views.py` (`v_consumo_sin_venta`, Rentabilidad),
`app/api/analytics.py` (`/analytics/comps`, profitability), `app/api/home.py`, `app/api/settings.py`,
`app/services/email_report_svc.py`, `tests/test_comps_staff.py` (new), `tests/test_honest_voids.py`.

Frontend: `components/{ReasonDialog,StaffOrderDialog,OwnerLimits}.tsx` (new),
`pages/manager/CompsPanel.tsx` (new), `pages/TicketPage.tsx`, `pages/FloorMapPage.tsx`,
`pages/manager/{ReportsHub,AnalyticsPage,ManagerDashboard,SettingsPage}.tsx`.

## Deploy

- **Phase 3:** pending list ends with **`054`**.
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler`, then `up -d`.
- **After:** reload every tablet (the void dialog changed; an old page sending "Void" gets refused).
- **Rehearsal (Mac):** `tests.test_comps_staff` → `31 passed, 0 failed`.

## Smoke test

1. Ticket → a beer → 🎁 Cortesía → Cumpleaños → PIN: the line shows ~~$45~~ $0 · 🎁 Cumpleaños.
2. Floor → 🍽 Consumo de personal → employee + Bebida de turno → PIN → add a soda → send → "Cerrar consumo".
3. Owner → Reportes → Personal y riesgos → Cortesías y personal: both appear, at cost.
4. Void a line: the dialog asks for a reason from the list.

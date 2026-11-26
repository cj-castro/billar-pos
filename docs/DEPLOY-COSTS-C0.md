# Cost entry done right (batch C0) — deploying to the Windows POS

Same mechanics as `DEPLOY-WINDOWS.md`. Ships with inventory batch 1 and
analytics A/B; this page lists only what C0 adds.

## What changes for the owner

| | Before | After |
|---|---|---|
| **New item** | "Costo inicial (por unidad base)": divide the invoice yourself | Pick *how you buy it* (caja, botella…), type the **price per case** and units per case; the screen shows "= $14.58 por lata" and the system divides |
| **Costos** (first cost) | Per base unit | Per case, units per case editable for that entry (12 one week, 24 the next) |
| **Wrong costs** | Could only be "fixed" by restocking, which blends the wrong cost in forever | **Costos a revisar** lists suspicious costs (counted items under $1 — e.g. *Marlboro Blanco Caja* $0.91, *Pan HotDog* $0.13 — and products that cost more than they sold for). **Corregir costo**: owner only, reason required, audited (`INVENTORY_COST_CORRECTED`). A bottle's correction re-prices its shots. Past sales keep their cost |
| **Precision** | Whole centavos per base unit: catsup 3.1746 ¢/ml stored as 3 (5.5% low), cheap ingredients as $0 | 4 decimals of a centavo; money totals still rounded once to the centavo. A 30 ml portion of that catsup now costs 95 ¢, not 90 ¢ |
| **Reabastecer** | Already per case | Unchanged; its preview now shows the exact per-unit cost |

## Files

- `backend/migrations/sql/044_exact_unit_cost.sql` (+ manifest line). Changes
  `unit_cost_cents` to NUMERIC(14,4) on inventory_items / inventory_movements /
  sale_item_costs, saving and rebuilding the 13 views that depend on them, and
  re-creates `fn_convert_stock` with numeric math. Safe to run twice.
- `backend/app/models/inventory.py`, `services/inventory_svc.py`, `services/cost_svc.py`,
  `services/audit_svc.py` (Decimal-safe audit — **without it a restock crashes**),
  `api/inventory.py`, `api/analytics.py`, `api/tickets.py`, `analytics_views.py`
- `frontend/src/components/CostEntry.tsx` (new), `utils/money.ts`,
  `pages/manager/InventoryPage.tsx`, `pages/manager/AnalyticsPage.tsx`
- `backend/tests/test_costs_exact.py` (new), `backend/tests/test_money_columns.py`
  (now allows exactly the three per-unit cost columns to be numeric(14,4))

## Differences from the earlier runbooks

- **Phase 3:** pending list ends with **`044`** (5 pending if everything ships together: 040–044).
  044 takes a few seconds: it drops and re-creates 13 views inside one transaction.
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler telegram-bot`, then `up -d`.
- **Rehearsal (Mac):** on a fresh scratch copy with 040–044: `tests.test_costs_exact` → `19 passed`,
  `tests.test_money_columns` → `11/11`.

## Smoke test

1. Inventario → Nuevo artículo → Unidad de compra *Caja*, `$350` por caja de `24` → shows "= $14.58 por lata"; save → the item shows $14.5833/lata.
2. Reabastecer any item → completes (this is the path the audit fix protects).
3. Analítica → Costos → *Costos a revisar* lists the sub-$1 items; *Corregir costo* without a reason is refused, with a reason it saves.

## After the deploy (owner)

In **Costos → Costos a revisar**, correct the flagged items first (they are
wrong today), then fill **Costos faltantes** by case price, then **Recalcular
histórico** once.

# Analytics batch B ("honest margins") — deploying to the Windows POS

Same mechanics as `DEPLOY-BATCH1-INVENTORY.md` / `DEPLOY-WINDOWS.md`. Normally
deployed together with inventory batch 1 and analytics batch A; this page lists
only what B adds. Background: `INVENTORY-ANALYTICS-REVIEW.md` §3.

## What changes for the owner

| Screen | Before | After |
|---|---|---|
| Analítica → Resumen / Rentabilidad / Personal | Profit and margin computed over every sale, so items with no cost counted as 100% margin (96–100% "margins") | Margin measured only on sales whose **every ingredient** has a cost. Profit is shown only when ≥ **80%** of item sales are fully costed; otherwise "—" with *Sin costo suficiente (X% de ventas con costo)* and a link to capture costs |
| Menú (matrix) | 69 of 92 products at 100% margin; median 100%; zero-cost items called *Estrella* | Only products ≥ 80% costed are classified; the rest are **Sin costo**. Medians over reliable products only |
| Recomendaciones | "Push high-margin items" listed items with unknown cost | Only products ≥ 80% fully costed |
| Costos | A list + "run `flask restate-costs`" | **Costos faltantes**: type the cost per unit and *Guardar* (a bottle also prices its shots); **Recalcular histórico** applies those costs to past $0 sales after a preview. Restated sales are marked as estimates (*X% usa el costo actual*) |
| Ganancias | Separate page with its own cost formula (disagreed with Analítica) | Retired; the menu link opens **Analítica → Rentabilidad** |

Rules for costs:
- *Guardar* only sets a **first** cost (item at $0). After that, cost changes only via **Reabastecer** at the real price (weighted average), as before. ADMIN only; audited (`INVENTORY_COST_SET`).
- *Recalcular histórico* never overwrites a cost that was captured at sale time; it only fills $0 rows, stamps them (`sale_item_costs.cost_restated_at`) and is audited (`COSTS_RESTATED`).
- Categories with no cost by nature (damage recovery, misc income) are now a setting: `menu_categories.exenta_costo`. 043 flags Bola8's *Daños* and *INGRESOS*.

## Files

- `backend/migrations/sql/043_honest_margins.sql` (+ manifest line)
- `backend/app/analytics_views.py`, `backend/app/api/analytics.py`, `backend/app/api/inventory.py` (set-cost)
- `backend/app/services/cost_svc.py` (new), `backend/app/__init__.py` (CLI uses it; Earnings blueprint removed)
- `backend/app/migrations_runner.py` — rebuilds the analytics views **after** migrations (see below)
- **Deleted:** `backend/app/api/earnings.py`, `frontend/src/pages/manager/EarningsPage.tsx`
- `frontend/src/pages/manager/AnalyticsPage.tsx`, `frontend/src/App.tsx`, `frontend/src/components/NavBar.tsx`, `frontend/src/pages/manager/ManagerDashboard.tsx`
- `backend/tests/test_analytics_batch_b.py`

## Why the first boot is now correct

`flask init-db` rebuilds the Python analytics views **before** migrations run.
B's views read `costo_estado`, which only exists after 043, so on the first boot
that rebuild fails (caught: the old views stay). `apply-migrations` now rebuilds
the views once more after applying anything, so the new logic is live on the
first boot instead of the second.

## Differences from the earlier runbooks

- **Phase 3:** pending list ends with **`043`** (4 pending if everything ships together: 040–043).
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler telegram-bot`, then `up -d`.
- **Phase 5:** in the backend log, after `Migrations: … applied`, there must be no
  `analytics views not rebuilt after migrations` line.
- **Rehearsal (Mac):** with 040–043 on a scratch copy, `tests.test_analytics_batch_b` → `26 passed, 0 failed` (it writes: run it on its own fresh copy).

## Smoke test

1. Analítica → Resumen: *Utilidad bruta* shows "—" with the coverage note (until costs are captured).
2. Menú: a **Sin costo** tile; no zero-cost product in Estrella.
3. Costos: enter a cost for the first item → it disappears from the list and coverage goes up.
4. *Ver qué cambiaría* → shows how many past sales get a cost; *Recalcular* → Resumen shows *X% usa el costo actual*.
5. The **Ganancias** link opens Analítica → Rentabilidad.

## After the deploy (owner, ~20–30 min)

Capture costs top-down in **Costos** until coverage passes 80%, then press
**Recalcular histórico** once. From then on the profit numbers appear by themselves.

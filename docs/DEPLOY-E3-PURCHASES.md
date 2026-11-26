# Batch E3 (weekly purchase forecast: screen, email, Telegram) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. One migration (`051`, drops the old
forecast view). Ships after E2 (`050`). **This batch also changes the Telegram
bot** — rebuild it too.

## What it does

Every **Sunday at 10:00** (bar time) the owner gets **what to buy for the coming
week (Mon–Sun)** by **email** and **Telegram**, and the same list is always on
**Reportes → Inventario → Compras y rotación**. In Telegram, **/compras** sends it
on demand.

How the numbers are made:

| | |
|---|---|
| Based on | **what sold** in the last 4 weeks (up to the last closed sale), through each product's recipe: sales − voids returned + waste thrown away |
| Bottles & boxes | shots sold (ml) are converted to bottles, loose cigarettes to boxes; open bottles count as stock. Opening a bottle is never "usage" |
| Forecast | the 4-week weekly average; if the last week ran higher, the average of the two |
| Safety margin | +20% (setting `purchasing.safety_pct`) and never below the item's minimum |
| Quantity | what is missing, **rounded up to whole cases** when the item has a case size ("2 cajas (48 botellas)") |
| Cost | at each item's unit cost; items without a cost are counted and named, not guessed |
| Groups | 🔴 Urgente (runs out within 7 days) · 🟡 Comprar · ⚪ Por tu mínimo (only the minimum asks for it). The email groups by supplier |
| Warnings | products sold without a recipe (they can't be forecast) and items that would last over a year (wrong recipe or phantom stock) |

The old forecast is gone: it counted opening a bottle as consumption, suggested
buying shots in ml, ignored waste and case sizes and always aimed at 2 weeks.

### Also fixed

- The Telegram bot's scheduled messages ran in **UTC**: the "09:00" daily report
  arrived at **03:00** Mexico time and Monday's weekly summary at 02:00. They
  now run in bar time.
- The report scheduler reads the venue's timezone (Ajustes → Negocio) instead of
  a hard-coded Mexico City.

## Owner to-do (makes the list better)

The forecast is only as good as the item data. In Inventario:
1. **Case size** (Unidad de compra + piezas por caja) for anything bought by the
   case — beer, sodas — so the list says "2 cajas".
2. **Costs** — the total only includes items that have one.
3. **Supplier** — the email groups by it.
4. Check flagged recipes: e.g. "Clamato Preparado" deducts **1 ml** of Clamato.

## Settings

| Variable (`.env`) | Default | |
|---|---|---|
| `PURCHASE_FORECAST_HOUR` | `10` | Sunday hour (bar time), scheduler and bot |
| `SCHEDULED_REPORTS` | `on` | `off` = this install emails nothing (test / copy machines) |

Both are already passed by the updated `docker-compose.yml` — make sure the
bundle includes it.

## Files

Backend: `migrations/sql/051_drop_old_purchase_forecast.sql` (+ manifest),
`app/analytics_views.py` (`v_purchase_forecast`), `app/services/purchase_svc.py` (new),
`app/api/analytics.py` (`/analytics/inventory`), `app/__init__.py` (`flask purchase-forecast [--send]`),
`scheduler.py`, `tests/test_purchase_forecast.py` (new), `tests/test_analytics_batch_a.py`.

Frontend: `pages/manager/AnalyticsPage.tsx` (Compras y rotación).

Telegram bot: `telegram-bot/bot.py` (`/compras`, Sunday job, bar-time scheduler).

Root: `docker-compose.yml`.

## Deploy

- **Phase 3:** pending list ends with **`051`**.
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler telegram-bot`, then `up -d`.
- **Phase 5:** scheduler log: `Scheduler ready (America/Mexico_City) — daily report 08:00; purchase forecast Sundays 10:00`.
- **Try it without waiting for Sunday:** `docker compose exec backend flask purchase-forecast`
  prints it; `... purchase-forecast --send` emails it now. In Telegram: `/compras`.
- **Rehearsal (Mac):** `tests.test_purchase_forecast` → `17 passed, 0 failed` (never sends email).

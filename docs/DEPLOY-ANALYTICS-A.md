# Analytics batch A ("the numbers are right") — deploying to the Windows POS

Same mechanics as `DEPLOY-BATCH1-INVENTORY.md` / `DEPLOY-WINDOWS.md` (bundle,
backup, apply, rebuild, rollback). Normally deployed **together with inventory
batch 1**; this page lists only what batch A adds. Findings and evidence:
`INVENTORY-ANALYTICS-REVIEW.md` §2.

## What changes for the owner

| Screen | Before | After |
|---|---|---|
| Analytics → Flujo de caja | Invented "sobrantes" (8 nights, $35.8k; 2026-05-24 showed +$17,923) | Same result as the Caja close screen, every session (100/100 within $0.36). Safe pickups shown for reference only |
| Analytics → Pagos / Reports → Pagos & Personal | Split tickets counted tips as sales (+$3,606 in July); a cash tip on a card payment was filed under card | Methods add up exactly to revenue; tips by where they were actually collected |
| Earnings (Ganancias) | Last day of every range missing; a single day = $0; "today" wrong after 6 pm | Whole range, bar-local dates (page later merged into Analítica in batch B) |
| Telegram bot | Reported the previous day's sales as today's | Bar's calendar day |
| Analytics → Inventario / purchase list | "Below minimum" items never listed (garbled labels); bottles never showed consumption | Listed, with a suggestion that at least restores the minimum; bottle opening counts as consumption |
| Analytics → Riesgos | Cancelled tickets with served items and force-closes invisible | New types: *Tickets cancelados con consumo*, *Cierres forzados sin cobro* |
| Reports → Exportar CSV | Always failed (no login token); most tabs empty | Works on every table tab; Excel opens accents correctly |
| Horas pico (Analytics + Reports) | Revenue on the hour the tab was PAID | On the hour it was ordered / the table started |
| Recomendaciones | "Push high-margin items" listed items with no cost | Only items with a known cost |

## Files

- `backend/migrations/sql/042_analytics_correct_numbers.sql` (+ manifest line)
- `backend/app/analytics_views.py` — re-created by `flask init-db` on every start, so no migration is needed for these views; restarting the backend applies them
- `backend/app/api/{reports,analytics}.py` (`earnings.py` was also fixed here, then retired in batch B)
- `telegram-bot/bot.py`
- `frontend/src/utils/dates.ts`, `frontend/src/pages/manager/{AnalyticsPage,EarningsPage,ReportsPage,SafeCollectionsPage}.tsx`
- `backend/tests/test_analytics_batch_a.py`

## Differences from the batch 1 runbook

- **Encoding:** 042 contains accented text (`mínimo`, `Operación`). Copy it with
  `docker cp` / the bundle — **never** through a PowerShell pipeline (trap 2).
  042 refuses to finish if any view still contains mojibake.
- **Phase 3 (apply):** pending list ends with **`042`** (3 pending if batch 1 is
  deployed at the same time: 040, 041, 042).
- **Phase 4 (rebuild):** `docker compose build --no-cache backend frontend scheduler telegram-bot`
  then `docker compose up -d`. The bot changed.
- **Rehearsal (Mac):** after 040–042 on the scratch copy,
  `python -m tests.test_analytics_batch_a` → `22 passed, 0 failed`.

## Smoke test

1. Analytics → Flujo de caja → the nights that showed big *Sobrante* now match Caja.
2. Ganancias → pick yesterday only → not $0.
3. Reportes → Pagos → Exportar CSV downloads a file that opens in Excel.
4. Telegram `/todaysales` after 6 pm → today’s sales, not yesterday’s.
5. Analytics → Inventario → items below their minimum appear under *por comprar*.

**Rollback:** as in batch 1 (restore the pre-deploy dump + previous code zip).

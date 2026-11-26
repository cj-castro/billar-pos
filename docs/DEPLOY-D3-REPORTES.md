# Batch D3 (Reportes: six pages) + D4 (dead code) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. **No new migration in D3** (D4's `047`
ships with D1, see `DEPLOY-D1-VENUE.md`). Ships after D1.

## What changes

| | Before | After |
|---|---|---|
| Owner's numbers | Two screens that overlapped: **Analítica** (9 tabs) and **Reportes** (11 tabs), plus Ganancias and Caja fuerte in the nav bar | One **Reportes** screen with six pages and a few sub-tabs each, one date bar, one address scheme `/manager/reportes/<page>/<sub>` |
| Ventas | split across both | Resumen · Tendencia · Productos · Pagos · Horas pico · Modificadores · **Promociones** (new: what each promotion gave away; the report existed but no screen showed it) |
| Billar | split | Mesas y ocupación · Sesiones |
| Rentabilidad | Analítica tabs | Resultado · Menú · Costos |
| Caja | Analítica tab + separate Caja fuerte screen | Flujo de caja · Caja fuerte (uses the shared date bar), link to the drawer screen |
| Inventario | split | Compras y rotación · Artículos eliminados, link to Inventario |
| Personal y riesgos | split | Desempeño · Ventas y propinas · Riesgos · Anulaciones · Menú eliminado |
| Inicio (owner) | 3 tiles: Reportes, Ganancias, Analítica | 6 tiles, one per page |
| Nav bar (owner) | 🔐 Caja · 💹 Ganancias | 🔐 Caja fuerte · 📊 Reportes |
| Cigarros tab | read the retired cigarette-box system; matched categories named "cigar" | **removed** (tab, endpoint and CSV export) |

**Old addresses still work**: `/manager/analytics?tab=…`, `/manager/reports`,
`/manager/earnings`, `/manager/safe` redirect to their new page (keeping the
date range), so bookmarks don't break. Managers' screens are unchanged —
Reportes is owner-only, as Analítica was.

### Bug fixed: safe pickups landed on the wrong day

The Caja fuerte list compared dates as UTC (the database runs in UTC), so a
pickup made after 6 pm Mexico time showed on the **next** day's list and total.
It now uses the same business-day rule as every report. Past pickups are not
changed — they simply show on the right day now.

## Files

Backend: `app/api/safe.py` (business-day dates), `app/api/reports.py` (cigarettes
report removed), `tests/test_analytics_batch_a.py`, `tests/test_venue.py`.

Frontend: `pages/manager/ReportsHub.tsx` (new), `pages/manager/AnalyticsPage.tsx`
and `ReportsPage.tsx` (now panels inside the hub), `pages/manager/SafeCollectionsPage.tsx`,
`pages/manager/ManagerDashboard.tsx`, `components/NavBar.tsx`, `App.tsx`.

## Deploy

- **Phase 3:** nothing new beyond D1 (pending list ends with `047`).
- **Phase 4:** `docker compose build --no-cache backend frontend`, then `up -d`.
- **Rehearsal (Mac):** fresh scratch copy: `tests.test_venue` → `23 passed, 0 failed`;
  `tests.test_analytics_batch_a` → `22 passed, 0 failed`.

## Smoke test (owner login)

1. Nav bar → **📊 Reportes** opens Ventas → Resumen with the date bar.
2. Click each of the six pages; each opens its first sub-tab with data.
3. Rentabilidad → Resultado → "corregir costos" jumps to Rentabilidad → Costos.
4. Caja → Caja fuerte: pick **Hoy** in the date bar — today's pickups, including evening ones.
5. Open an old bookmark `/manager/analytics?tab=riesgos` → lands on Personal y riesgos → Riesgos.
6. Log in as a manager: no Reportes link; `/manager/reportes` sends them to the floor.

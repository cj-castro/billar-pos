# Batch E2 step 1 (opened spirits in ml) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. One migration (`049`). Ships after E1 (`048`).

## What changes

| | Before | After |
|---|---|---|
| An opened bottle | became 15 whole "shots" | becomes **750 ml**; the shot item is stocked in ml and knows its **standard pour** (50 ml) |
| Recipes | whole shots only: Azulito took a **full shot of Curazao** | any amount in ml: a 50 ml shot, a 100 ml double, a **20 ml splash** |
| Bottle setup (Inventario) | "Shots por botella" | **Tamaño de botella (ml)** + **Shot estándar (ml)**, showing "Rinde N shots" |
| Inventario row | "↳ 15 shots abiertos" | "↳ 15 shots abiertos · 750 ml"; under a shot: "Quedan 20 ml (menos de un shot) — abre otra" |
| "¿abrir otra?" | asked whenever anything was left | asked while **at least one shot** is left: "Todavía quedan 2 shots (100 ml)". Less than a shot left opens straight away; the next shot finishes the old bottle from the new one |
| Recipe editor (Menú → 📦) | quantity in shots | picking a spirit pre-fills one shot (50 ml), with buttons **1 shot · Doble · Medio · Chorrito (20 ml)**; saved lines read "20 ml · 0.4 shots" |
| Waiters / bartenders | — | **nothing changes**: same buttons, same screens |
| 2x1 / promotions | — | unchanged: a promo changes the price, never the pour (2 shots = 100 ml) |

### The migration converts history exactly

For each shot item: stock, every past movement, every sale's cost row, recipes
and the low-stock threshold × 50; unit costs ÷ 50. **Every peso total is
unchanged**, the ledger still ties out, and an audit row
`INVENTORY_UNIT_TO_ML` is written per item. Idempotent.

**Assumption: bottles are 750 ml** (15 shots × 50 ml). For any bottle of another
size (e.g. Red Label 700 ml, a 1 L), the owner sets **Inventario → ✏️ →
Tamaño de botella** after deploy; it applies to bottles opened from then on.

### After deploy — owner to-do

1. Check each bottle's size in Inventario (750 ml unless changed).
2. **Azulito:** Menú → Azulito → 📦 → Curazao: set the real splash (e.g. 20 ml).
   Until then it keeps deducting 50 ml, exactly as before.
3. Same for any other mixed drink whose pours aren't a full shot.

## Files

Backend: `migrations/sql/049_spirits_in_ml.sql` (+ manifest), `app/services/inventory_svc.py`
(configure_yield in ml + pour, open prompt by whole shots), `app/api/inventory.py`
(`bottle_ml` / `pour_ml`; old clients' `shots_per_bottle` still accepted = shots × 50 ml),
`app/models/inventory.py` (`portion_size`, `pour_ml`, `bottle_ml`), `app/api/home.py`,
`tests/test_spirits_ml.py` (new), `tests/test_inventory_batch1.py` (assertions now in ml).

Frontend: `pages/manager/InventoryPage.tsx`, `pages/manager/MenuManagementPage.tsx`.

## Deploy

- **Phase 3:** pending list ends with **`049`**. Log: `049: 5 open-spirit item(s) converted to ml`.
- **Phase 4:** `docker compose build --no-cache backend frontend`, then `up -d`.
- **Rehearsal (Mac):** fresh scratch copy with 040–049: `tests.test_spirits_ml` → `21 passed, 0 failed`.

## Smoke test

1. Inventario → Tequila Blanco: "↳ N shots abiertos · X ml".
2. Sell one Tequila Blanco Shot: the open stock drops by 50 ml.
3. Edit a bottle: size and pour fields show "Rinde 15 shots".
4. Open a bottle with shots left: "Todavía quedan N shots (X ml), ¿abrir otra?".

---

# Step 2 (open-bottle records + blind bar count) — migration `050`

Ships with or after step 1 (`049`).

## What changes

| | Before | After |
|---|---|---|
| Opening a bottle | always the product's size | the dialog asks **"Tamaño de esta botella (ml)"**, pre-filled (750). Sizes vary between purchases: a 1 L bottle opens as 1000 ml, for that bottle only |
| Open bottles | a pooled number | **one record per opened bottle**: product, size, who, when. Inventario shows "· 2 botellas abiertas" when more than one is open. Bottles the books say are empty are closed when the next one is opened |
| End of shift | no inventory step | **🍾 Conteo de barra** (Inventario header, and a reminder above "Cerrar Bar" in Caja): per spirit, each open bottle → **Vacía / ¼ / ½ / ¾ / Llena** (or exact ml), plus sealed bottles on the shelf |
| Blind | — | the closer never sees what the system expects. A manager gets "Conteo guardado"; **only the owner** sees the differences |
| Differences | invisible | written to the ledger (COUNT_ADJUSTMENT "Conteo de barra …"), valued at cost, per spirit and in total. Owner: **Reportes → Inventario → Conteos de barra** — every count (who, when, $) and what is open right now with the system's estimate per bottle |

Sales are unchanged: they draw from each spirit's total ml, oldest bottle first.

**First count after deploy matters:** the books still carry old phantom stock
(e.g. Tequila Blanco: 19 sealed on the books). The first count sets them to
what is really on the shelf, and the difference shows once, in pesos.

## Files

Backend: `migrations/sql/050_open_bottles_bar_count.sql` (+ manifest; tables
`open_bottles`, `bar_counts`, `bar_count_lines`; `fn_convert_stock` gains a
per-bottle size), `app/services/bar_count_svc.py` (new), `app/services/inventory_svc.py`,
`app/api/inventory.py` (`/bar-count` GET/POST, `/bar-counts` owner-only,
`size_ml` on open), `app/models/inventory.py`, `tests/test_bar_count.py` (new),
`tests/test_money_columns.py`.

Frontend: `pages/manager/BarCountPage.tsx` (new), `pages/manager/BarCountsPanel.tsx` (new),
`pages/manager/InventoryPage.tsx`, `pages/manager/ReportsHub.tsx`,
`pages/manager/CashSessionPage.tsx`, `App.tsx`.

## Deploy

- **Phase 3:** pending list ends with **`050`**.
- **Rehearsal (Mac):** `tests.test_bar_count` → `21 passed, 0 failed`.

## Smoke test

1. Inventario → 🍾 on a bottle: the size field shows 750; change to 1000 → opens 1000 ml.
2. Inventario → **🍾 Conteo de barra** as a manager: no expected amounts anywhere; save → "Conteo guardado".
3. Owner → Reportes → Inventario → Conteos de barra: the count, who did it, the $ difference.

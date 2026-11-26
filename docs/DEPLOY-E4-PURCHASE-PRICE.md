# Batch E4 (every purchase carries its price) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. Two migrations (`052`, `053`: data clean-up). Ships after E3.

## What changes

| | Before | After |
|---|---|---|
| Reabastecer (cases / bottles) | price could be left at $0 | **price required (> $0)**; the button reads "Falta el precio" until it's typed |
| Reabastecer (food batches) | total cost defaulted to $0 when missing | **total cost required** |
| New item with starting stock | no price needed | **price required** (without stock it's optional: it comes with the first purchase) |
| Goods that came free | indistinguishable from a forgotten price | **"Entró sin costo (cortesía del proveedor)"** — owner only, reason required; recorded paid $0 on purpose, audited as `INVENTORY_RESTOCK_FREE`. Free goods correctly lower the average cost |
| Typos | $4,500 instead of $450 went straight into the average cost | a price **more than 3× or under ⅓ of the last one** asks: "Este precio es 10.2× más de lo que pagaste la última vez ($18.65 por unidad, ahora $190.00). ¿Es correcto?" → **Sí, el precio es correcto**. Confirmed prices are marked in the audit |

The quantity is validated before the price question, so a wrong quantity is
reported first.

### Purchase unit vs stock unit (no silent "1")

The new-item form defaulted "how many per case" to **1**: stocked by Botella,
bought by Caja, $380 became "$380 por botella". Now:

- **Different units** (Botella / Caja): "¿Cuántas botellas trae la caja?" is
  required, starts empty, and must be more than 1; the per-bottle cost appears
  once it is filled ($380 / 24 = $15.83). Create, edit, cost correction and
  restock all refuse a "case of 1".
- **Same unit** (Caja / Caja, or none): just "Costo por caja", no pack field;
  a pack other than 1 is refused when creating or changing an item.
- "Cant. Inicial" shows its unit ("Cant. Inicial (botella)").

**Migration 052** cleans the existing data (units only — stock and costs untouched, audited `INVENTORY_UNIT_FIX`):
- items "bought by the caja of 1 pieza" become "bought as stocked" (same math as
  before): Marlboro Blanco Caja, Marlboro Gold, Tequila Blanco Shot;
- Curazao Azul Bottle was stocked in *caballito*; now *botella* like every bottle
  that opens. Its 0.01 in stock came from a 0.01 restock entered before whole
  numbers were enforced — the next bar count sets it right.

**Migration 053** — *Papas Doradas Caseras* was stocked by caja, bought by caja
"of 60", while its recipes deduct 1 pieza: the quantities were already pieces
(1 case restocked = +60; $800 / 60 = $13.33 per piece), only the label was
wrong. Owner confirmed: 60 individual packages per case. Rule (not a name): a
same-unit pack > 1 whose recipes all deduct one other unit is stocked in that
unit. Now: stocked by **pieza**, bought by **caja of 60**; stock and cost unchanged.

Why: 82% of cost rows were $0 — mostly purchases entered without a price — so
margins couldn't be trusted and the Sunday purchase list couldn't be priced
(18 of 20 items had no cost). From now on every purchase prices itself, and the
gap closes as products are restocked.

## Files

Backend: `migrations/sql/052_purchase_unit_sanity.sql`, `053_stock_unit_from_recipes.sql` (+ manifest), `app/api/inventory.py` (restock, create, edit),
`app/services/inventory_svc.py` (`assert_pack`), `app/services/cost_svc.py`, `tests/test_purchase_price.py` (new),
`tests/test_inventory_batch1.py`.

Frontend: `components/CostEntry.tsx`, `pages/manager/InventoryPage.tsx` (restock dialog, new/edit item checks).

Root: `docker-compose.yml` — the scheduler no longer runs the web health check it
inherited from the backend image (it always showed "unhealthy" while working).

## Deploy

- **Phase 3:** pending list ends with **`053`**.
- **Phase 4:** `docker compose build --no-cache backend frontend`, then `up -d`.
- **Rehearsal (Mac):** `tests.test_purchase_price` → `28 passed, 0 failed`.

## Smoke test

1. Inventario → Reabastecer: leave the price empty → button says "Falta el precio".
2. Type 10× the usual price → the dialog asks; "Sí, el precio es correcto" saves it.
3. As a manager: no "sin costo" option. As owner: tick it → a reason is required.

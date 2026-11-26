# Inventory hotfix (batch 1) — deploying to the Windows POS

Branch `fix/inventory-bottle-batch1`. Two new migrations (`040`, `041`), backend code,
and one frontend screen (Inventario → new/edit item). The mechanics (bundle, backup, apply, rebuild,
rollback) are identical to `DEPLOY-WINDOWS.md`; this page only lists what is
different. **Read the "Five traps" section of that runbook first** — especially
"do not rename the folder" and "never pipe SQL through PowerShell".

---

## What changes

| Area | Before | After |
|---|---|---|
| Creating a bottle / cigarette box | Had to create the Shot / Suelto item first and link it by hand; left on "Sin vincular" the bottle could never be opened | Type "Shots por botella" (or "Cigarros por caja") and the bottle can be opened right away. If no shot item is picked, one is created automatically ("Mezcal Bottle" → "Mezcal Shot"). Yield changes are audited (`INVENTORY_YIELD_SET`) |
| "Abrir botella" | Used `shots_per_bottle` / `yields_item_id`, which were wrong in the data (Red Label → Agua Mineral; Tequila Blanco Shot → Tequila Blanco **Bottle**) | Uses `inventory_conversions`, the same path as auto-conversion |
| Cost of shots | Opening a bottle never moved its cost to the shots → spirits sold at $0 COGS | Bottle cost is split across the shots it produces |
| Adding shots / loose cigarettes | Restock, "+N" adjustment or an upward count all created shots without opening a bottle | **Only "Abrir botella" / "Abrir caja" adds them.** Restock and "+N" are refused for everyone; an upward *count* is allowed for the owner (ADMIN) only, audited. Counting *down* is allowed for managers |
| Selling a shot | Refused at 0 shots — unless auto-convert was on, which silently opened a bottle | Refused at 0 shots and shown as blocked on the sales screen. Auto-convert stays **off**. The database also refuses negative stock on any shot / loose item, whatever `negative_stock_mode` says |
| Concurrent stock writes | A lock could return a stale value (lost update) | Every lock re-reads the row |
| "Abrir caja" on long names | Failed for any box name over 16 characters (e.g. *Marlboro Blanco Caja*) | Works |
| Auto-opened bottles | Not linked to the order that opened them | `reference_id` = the line item |
| Send order with a missing item | HTTP 500 | 422 "Sin inventario suficiente", nothing sent |
| Decimals on bottles, shots, pieces | Any decimal accepted (a restock of 0.01 Curazao went onto the books) | Counted units take **whole numbers** on restock, waste, count, adjustment and initial stock. Measured units (ml, litro, gramo, kilogramo, onza, taza) still accept decimals. Set per unit (`unit_catalog.allows_fraction`, migration 041) |
| Opening a bottle while shots remain | Opened silently | Asks **"Todavía quedan N shots, ¿abrir otra?"** (same for boxes / loose cigarettes); opens only on "Sí, abrir otra" |
| Shot / loose items on the inventory screen | Own row with Reabastecer, "+/-", etc. | Folded into the bottle/box row: "↳ N shots abiertos" with only Merma and Conteo. The way to add shots is the bottle's 🍾 button |
| Changing an item's unit | Allowed any time — 1 botella silently became 1 caballito | Only while stock is 0 and no recipe uses the old unit |

Migration `040` changes **metadata only** (item type, yield columns, a unique
index, the `fn_convert_stock` function). It does **not** change any stock
quantity. Every row it touches is logged in `audit_log` as
`MIGRATION_040_ITEM_FIX` with before/after values.

**Tell the staff:** shots only appear when a bottle is opened. When a shot
shows as blocked on the sales screen, a manager opens a bottle (Inventario →
🍾 Abrir botella) and the shot becomes sellable. Restocking or "+N" on a Shot
item shows an error — that is intended.

---

## Before you start: one pre-check on production

040 refuses to run if any item has two active conversions. Check (bar can be open):

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
docker compose exec postgres psql -U billiard -d billiardbar -tA -c `
  "SELECT from_item_id, count(*) FROM inventory_conversions WHERE is_active GROUP BY 1 HAVING count(*) > 1;"
```

Expect no rows. If there are any, send them to CJ before going further.

---

## Phase 0 — Rehearse on the Mac (recommended)

Same as `DEPLOY-WINDOWS.md` Phase 0.1–0.3 (dump on Windows, copy, load into a
scratch database **whose name contains `scratch`**). Then:

```bash
docker exec -i billar-pos-postgres-1 psql -U billiard -d <scratch_db> \
    < backend/migrations/sql/040_bottle_conversion_fixes.sql
docker exec -i billar-pos-postgres-1 psql -U billiard -d <scratch_db> \
    < backend/migrations/sql/041_whole_number_units.sql
docker run --rm --entrypoint python --network billar-pos_billiardbar_net \
    -v "$PWD/backend:/app" -w /app \
    -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/<scratch_db> \
    billar-pos-backend -m tests.test_inventory_batch1
```

Expect `NOTICE: 040_bottle_conversion_fixes: OK`, `NOTICE: 041_whole_number_units: OK` and `54 passed, 0 failed`.
(The test uses Bola8's item names; it is a rehearsal for *this* database.)
`--entrypoint python` matters: without it the image runs init-db, seed and
gunicorn against the scratch DB and never reaches the test.

---

## Phases 1–5 on Windows

Follow `DEPLOY-WINDOWS.md` with these differences:

- **Phase 1 (bundle):** same. Verify `040_bottle_conversion_fixes.sql` and
  `041_whole_number_units.sql` exist in `backend\migrations\sql\` and `manifest.txt`
  ends with those two lines.
- **Phase 2 (backup):** use `-Label pre-040`.
- **Phase 3 (apply):** the dry run should show **2 pending: `040`, `041`**. If it shows
  `001` as pending too, stop and send CJ the output — that means the squash
  baseline was never recorded on this machine.
- **Phase 4 (rebuild):** `docker compose build --no-cache backend frontend`
  then `docker compose up -d`. Both images changed.
- **Phase 5 (verify):** in addition to the usual checks:

```powershell
# Every bottle now matches its conversion (expect 0 rows)
docker compose exec postgres psql -U billiard -d billiardbar -c `
  "SELECT i.name, i.item_type, i.shots_per_bottle, y.name AS yields FROM inventory_items i LEFT JOIN inventory_items y ON y.id = i.yields_item_id WHERE i.item_type = 'BOTTLE' AND NOT EXISTS (SELECT 1 FROM inventory_conversions c WHERE c.from_item_id = i.id AND c.is_active AND c.to_item_id = i.yields_item_id);"

# What 040 changed (keep this output)
docker compose exec postgres psql -U billiard -d billiardbar -c `
  "SELECT entity_id, before_state, after_state FROM audit_log WHERE action = 'MIGRATION_040_ITEM_FIX' ORDER BY id;"
```

Smoke test in the browser:
1. Inventario → *Whisky Red Label Bottle* → Abrir botella → *Shot Whisky Red label* goes up by 15; *Agua Mineral* does not change.
2. Inventario → try to restock *Tequila Blanco Shot* → error message pointing to the bottle.
3. Inventario → *Marlboro Blanco Caja* → Abrir caja → works.
4. Inventario → Nuevo artículo → Tipo *Botella (licor)*, "Shots por botella" 15,
   leave *Copa/Shot que produce* on "— Crear automáticamente —" → save → the 🍾
   button appears and opening it adds 15 to the new "… Shot" item. Delete the
   test items afterwards (they are soft-deleted; no stock was sold).
5. Open the same bottle again while it still has shots → the dialog shows
   "Todavía quedan 15 shots, ¿abrir otra?"; Cancelar leaves stock unchanged.
6. Reabastecer any bottle with **0.5** → refused ("usa un número entero").
7. Shot items no longer have their own row: each bottle shows "↳ N shots
   abiertos" with only Merma / Conteo (and 🍽️ Vender shots if the shot is not on
   the menu yet). Searching a shot's name shows its bottle.

**Rollback:** `DEPLOY-WINDOWS.md` Phase 6 with the `pre-040` dump and the
pre-deploy code zip.

---

## After the deploy: manual steps (code cannot do these)

### 1. Count the spirits — Tequila Blanco first

On 2026-07-30 the misconfigured *Tequila Blanco Shot* was "opened" and added
15 bottles to *Tequila Blanco Bottle* (4 → 19). Those bottles almost certainly
do not exist. Count every spirit bottle (sealed) and enter each count with
**Ajuste por conteo físico**. For the shot items, estimate what is left in the
open bottle (e.g. half a bottle = 7 shots) and enter that the same way.

**Log in as the owner (ADMIN) for the shot counts.** A manager can lower a
shot count but not raise it; only ADMIN can enter a count higher than the
system shows.

Do not fix this with SQL or by replaying history — the count adjustment is the
audited way, and it is what the ledger expects.

### 2. Enter real bottle costs

Every bottle and shot item currently has a cost of $0, so cost and margin
reports show $0 for spirits. The next time bottles are received, enter the real
price in the restock form. The cost then flows to the shots automatically.

### 3. Leave spirits auto-convert OFF

Policy (CJ, 2026-11-24): a shot can only be sold from a bottle someone has
deliberately opened. `spirits.auto_convert_enabled` must stay `false` — when
`true`, a shot sale opens a sealed bottle by itself. Confirm:

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -tA -c `
  "SELECT key, value FROM settings WHERE key LIKE '%auto_convert%';"
```

Both rows should read `false`.

---

## Not in this batch

Voids that return poured/opened product to stock (batch 2), and the inventory
redesign (volume-based bottles with open-bottle tracking, comps, shift counts,
variance) are planned separately.

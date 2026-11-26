# Batch E8 (portioning in house: raw kg → packs) — deploying

Same mechanics as `DEPLOY-WINDOWS.md`. One migration (`056`). Ships after E6/E7.

## Why

Fried products (alitas, boneless, tenders, papas a la francesa, dedos de queso,
aros de cebolla…) arrive by the case (~15 kg) and are portioned on arrival. The
POS only knew the packs, restocked by hand at $0: purchases (kg) couldn't be
reconciled with sales (packs), a case's real yield was unknown, and so was the
cost of a pack.

## What changes

| | |
|---|---|
| **Raw item** | e.g. "Alitas crudas": stock unit **Kilogramo**, bought by **Caja** of 15 (kg), priced per case. Restocked like anything else (price required, E4) |
| **Pack items** | Edit a pack ("Alitas 300gr") → **Se porciona de**: Alitas crudas, **Peso por paquete**: 300 g. It becomes "paquete", keeps its count, and **can't be restocked**: it comes only from portioning ("🔪 de Alitas crudas" instead of Reabastecer) |
| **🔪 Porcionar** (on the raw item's row) | kg used (pre-filled with one case) and packs out per size. Shows as you type: kg in packs, waste, **yield %**; the owner also sees the cost per pack. Refuses more grams out than in (2% scale tolerance), more raw than there is, half packs |
| Cost per pack | the raw's cost for what was used, **spread by weight** — waste included. Example: 15 kg at $1,500 → 14×700 g + 12×300 g = 13.4 kg (89.33%) → 700 g pack **$78.36**, 300 g **$33.58** (not $70 / $30) |
| Ledger | PRODUCTION_CONSUME (raw, −kg) and PRODUCTION_YIELD (each pack, +n) — an internal move, never "usage". Sales keep deducting 1 pack, now at its real cost |
| Purchase forecast | packs are not purchase lines; their sales roll up into the raw item (packs × weight → kg → **cases**), and packs on hand count as raw stock |
| **Reportes → Inventario → Porcionado** (owner) | yield per product; each batch: kg in → in packs, waste, yield, cost, packs out with cost each, who, notes |

Managers can portion but never see costs.

## Owner set-up (once per product)

For each fried product:
1. **Nuevo artículo**: "Alitas crudas" · Unidad base **Kilogramo** · Unidad de compra **Caja**,
   **15** kg por caja · categoría Comida. (Starting stock needs its price.)
2. Edit the **raw item** → section **🔪 Paquetes que salen de este producto** → pick each
   pack (Alitas 300gr, Alitas 700gr…) + its weight → **Agregar**. (Or, from a pack:
   **Se porciona de** → the raw item → **Peso por paquete**.)
3. On delivery: Reabastecer the raw item (cases, price per case) → **🔪 Porcionar**.

Repeat for Boneless, Tenders, Papas a la francesa, Papas gajo, Dedos de queso, Aros de cebolla
(checklist with the exact items: `SETUP-PORTIONING-BOLA8.md`).
The first batches average with packs already in stock at $0, so pack costs
converge to the real value as the old packs sell.

## Files

Backend: `migrations/sql/056_portioning.sql` (+ manifest; unit "paquete",
`inventory_items.portion_source_id`, `portion_batches`, `portion_batch_outputs`),
`app/services/portion_svc.py` (new), `app/services/inventory_svc.py` (packs not restockable),
`app/api/inventory.py` (`/portion`, `/portioning`, link on edit), `app/models/inventory.py`,
`app/analytics_views.py` (forecast roll-up), `tests/test_portioning.py` (new),
`tests/test_money_columns.py`.

Frontend: `components/PortionDialog.tsx` (new), `pages/manager/PortioningPanel.tsx` (new),
`pages/manager/InventoryPage.tsx`, `pages/manager/ReportsHub.tsx`.

## Deploy

- **Phase 3:** pending list ends with **`056`**.
- **Phase 4:** `docker compose build --no-cache backend frontend scheduler`, then `up -d`.
- **Rehearsal (Mac):** `tests.test_portioning` → `21 passed, 0 failed`.

## Smoke test

1. Create "Alitas crudas" (kg, caja de 15) and restock 1 case with its price.
2. Link Alitas 300gr / 700gr to it (300 / 700 g): their rows show "🔪 de Alitas crudas".
3. 🔪 Porcionar: 15 kg → e.g. 14 + 12 packs → yield shown → Registrar.
4. Owner → Reportes → Inventario → Porcionado: the batch with yield and cost per pack.

# Bola 8 — portioning set-up checklist (production, after E8 / migration 056)

All in the screens, as owner. Linking **converts the existing pack items in
place**: same item, same stock, same menu recipes and history; only the unit
becomes "paquete" and Reabastecer is replaced by 🔪 Porcionar.

## Products

Fill in the blanks before starting (case weight, price per case, pack weights).

| # | Raw item to create | Case (kg) | Price / case | Existing pack(s) to link → weight (g) | Sold in |
|---|---|---|---|---|---|
| 1 | Caja Alitas Congeladas | 15 | $1,100 | Alitas 300gr → 300 · Alitas 700gr → 700 | Alitas |
| 2 | Boneless crudo | ___ | $____ | Boneless → ___ | Boneless, Sampler |
| 3 | Tenders crudo | ___ | $____ | Tenders → ___ | Tenders |
| 4 | Aros de cebolla (caja) | ___ | $____ | Aros de Cebolla → ___ | Aros de Cebolla, Sampler |
| 5 | Dedos de queso (caja) | ___ | $____ | Dedos de Queso → ___ | Dedos de Queso, Sampler |
| 6 | Papas a la francesa (caja) | ___ | $____ | Papas Francesa → ___ | Papas Francesa, Salchipulpos+Francesas, Hamburguesa Pollo |
| 7 | Papas gajo (caja) | ___ | $____ | Papas Gajo → ___ | Papas Gajo |

**Do not link:** Papas Doradas Caseras (arrive as individual packages, 60 per case — stays
bought by caja of 60, counted in pieces), Cebolla, Queso Amarillo.

## For each product

1. **Inventario → + Agregar artículo**: name · Categoría **Comida** · Unidad base **Kilogramo** ·
   Unidad de compra **Caja**, kg por caja · Proveedor.
   **Cant. inicial = only the cases NOT yet portioned** (usually 0). Packs already made keep
   their own stock — don't count them again here. If you enter stock, enter its price.
2. Edit the raw item → **🔪 Paquetes que salen de este producto** → pick the pack, type its
   weight → **Agregar** (repeat per size).
   ✓ The pack's row now says "🔪 de <raw item>"; the raw item's row shows **🔪 Porcionar**.
3. On the next delivery: **Reabastecer** the raw item (cases, price per case) → **🔪 Porcionar**
   (kg used, packs out per size) → check the yield → Registrar.

## After the first week

- Reportes → Inventario → **Porcionado**: yield per product. Below ~85% is worth a look
  (ice glaze, trimming, heavy portions).
- Packs that were in stock before had cost $0; the first batches average with them, so
  pack costs reach their real value as the old packs sell.
- The Sunday purchase list now asks for **cases** of each raw item.

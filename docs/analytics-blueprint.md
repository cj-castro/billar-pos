# BOLA 8 BILLAR & BAR — Analytics Expansion Blueprint

**Status:** Phase 1 implemented (2026-08-04)
**Audience:** ADMIN role only
**Scope:** Profit-first analytics layer built exclusively on `v_bola8_*` PostgreSQL views

---

## 0. Ground rules

1. **Never query transactional tables from a dashboard.** Dashboard SQL reads only `v_bola8_*` views.
   New *views* may read base tables — that is how the existing thirteen work. Dashboards may not.
2. **All money is `NUMERIC(18,2)`.** Never `FLOAT` / `DOUBLE PRECISION`.
   Aggregate in integer `_cents`, divide by 100 and cast **once** at the outermost projection.
   Rounding sub-aggregates and then summing them produces cent drift.
3. **Profit, not revenue.** Every analysis carries margin, COGS or utility.
4. **No duplicate reports.** If an existing view answers the question, reuse it.
5. **Timezone.** Every date derivation uses `AT TIME ZONE 'America/Mexico_City'` before casting to
   `::date`. A UTC-based date silently pushes post-18:00 local revenue — most of a bar's night — onto
   the following day.

---

## 1. The real column contract

The views use a **hybrid Spanish/English** contract. Money is stored as integer cents with
pre-cast `NUMERIC(18,2)` MXN companions.

| Concept | Actual columns |
|---|---|
| Date / hour / weekday | `fecha_mx`, `hora_mx`, `dia_semana_iso`, `dia_semana` |
| Product | `menu_item_id`, `producto`, `categoria` |
| Money (cents) | `total_cents`, `net_sales_cents`, `gross_profit_cents`, `total_cost_cents`, `pool_time_cents`, `tip_cents`, `discount_cents` |
| Money (MXN, `NUMERIC(18,2)`) | `total_mxn`, `net_sales_mxn`, `utilidad_mxn`, `costo_mxn`, `tip_mxn`, `pool_time_mxn`, `descuento_mxn` |
| Payment | `payment_type`, `payment_type_2` (type only — no amounts) |

There is **no** `fecha`, `id_producto`, `total`, `id_mesero`, `tipo_pago`, `propina`, or
`estado_ticket`. Anything written against those names will not run.

---

## 2. Only two views are date-filterable

| View | Window | Date-ranged dashboards? |
|---|---|---|
| `v_bola8_tickets_cerrados` | none — ticket grain | ✅ **Foundation** |
| `v_bola8_lineas_venta` | none — line grain, voids excluded | ✅ **Foundation** |
| `v_bola8_kpis_diarios` | per-day grain | ✅ day grain, **no profit** |
| `v_bola8_kpis_ejecutivos` | **all history, single row** | ❌ |
| `v_bola8_top_productos` | **all history** | ❌ |
| `v_bola8_utilidad_producto` | **all history** | ❌ |
| `v_bola8_ventas_por_hora` | **all history** | ❌ |
| `v_bola8_ventas_por_dia_semana` | **all history** | ❌ |
| `v_bola8_productos_lentos` | hardcoded 30d | ⚠️ fixed |
| `v_bola8_forecast_semanal` | hardcoded 56d → next 7d | ⚠️ fixed |
| `v_bola8_forecast_compras` | hardcoded 28d | ⚠️ fixed |
| `v_bola8_promociones_activas` | config only | ⚠️ metadata |
| `v_bola8_recomendaciones` | all history, stacked 4 deep | ⚠️ narrative |

**Consequence:** `v_bola8_kpis_ejecutivos` cannot drive the Executive dashboard — it returns one
lifetime row. Every dashboard with a date picker is rebuilt from the two grain views via CTEs.
This is not duplication: the aggregate views remain correct for lifetime tiles and are reused there.

### 2.1 Revenue reconciliation rule

```
total_mxn (tickets)  ≈  net_sales_mxn (lineas)  +  pool_time_mxn
$656,116.92          ≈  $550,788.86             +  $105,283.06     (Δ $45.00 rounding)
```

Billiard table time is **16% of revenue**, exists only at ticket grain, and carries no COGS row.
Excluding it from profit understates contribution by six figures a year. Every profit surface must
state whether pool time is in scope. The analytics API includes it as a separate, ~100%-margin
revenue stream.

---

## 3. COGS: the dominant data-quality problem

`v_bola8_lineas_venta` reports a **97.2% gross margin**. That is not real.

### 3.1 Root cause — it is missing *unit costs*, not missing recipes

The deduction engine works. It resolves recipes, finds inventory items, and multiplies by a unit
cost of **zero**.

| Bucket | Lines | % | Cause |
|---|---|---|---|
| ✅ Real cost | 909 | 15.5% | working |
| 🔴 **Cost row exists, `total_cost_cents = 0`** | **3,582** | **61.0%** | **64 of 76 active inventory items have `unit_cost_cents = 0`** |
| 🟡 No cost row at all | 1,379 | 23.5% | 17 menu items without recipe, plus legitimately costless items |

**$468,419.70 of $550,788.86 line revenue (85%) flows through inventory items priced at zero.**

`purchase_cost_cents` is also `0` on all 64, so nothing can be derived automatically. The numbers
must be entered by hand.

### 3.2 Top cost gaps by revenue exposure

| Inventory item | Category | Revenue exposed |
|---|---|---|
| Corona | beer | $63,071.20 |
| Victoria | beer | $47,574.00 |
| Pacifico | beer | $43,496.00 |
| Boneless | food | $34,627.60 |
| Alitas 700gr | food | $30,049.00 |
| XX Lager | beer | $26,021.00 |
| Papas Francesa | food | $19,538.30 |
| Salchica HotDog | food | $12,789.00 |
| Dedos de Queso | food | $12,649.00 |
| Papas Doradas Caseras | food | $11,627.30 |

**The top 10 items cover roughly $301,000 — 55% of line revenue.** This is an afternoon of data
entry, not a quarter of recipe engineering.

Live worklist: `GET /api/v1/analytics/cost-coverage` returns these ranked by exposure.

### 3.3 Beer buckets deduct through modifiers, not recipes

`Cubeta Cerveza Premium` ($106,902 — the largest single revenue item) has **no**
`menu_item_ingredients` row, yet 252 of its 322 lines *do* have `sale_item_costs` rows. Buckets
deduct via `modifier_inventory_rules` on the "Bucket Beers" modifier groups. Their zero cost comes
from the underlying beer inventory items, not from a missing recipe. Pricing Corona, Victoria,
Pacifico and XX Lager fixes the buckets automatically.

### 3.4 Legitimately costless — exclude, don't chase

| Category | Items | Verdict |
|---|---|---|
| `Daños` | Bola Dañada, Paño Manchado, Taco Dañado | zero COGS — damage recovery |
| `INGRESOS` | BIDÓN DE ACEITE | zero COGS — misc income |
| `BARRA` | Papas Doradas Caseras, Carne Seca, Platillo Botanero | **not** exempt — real food, needs costs |

Without an exclusion list, coverage can never reach 100% and the team stops trusting the metric.
`v_bola8_cobertura_costo` excludes `Daños` and `INGRESOS` from the denominator.

### 3.5 Remediation order

| Step | Action | Unlocks | Effort |
|---|---|---|---|
| **0.1** | Enter `unit_cost_cents` for 64 inventory items (top 10 first) | 61% of lines | ~3 h |
| **0.2** | `flask restate-costs` — recompute historical `sale_item_costs` | 90 days of history | run once |
| **0.3** | Recipe the 3 BARRA food items + 14-item tail | ~4% | backlog |
| **0.4** | Guardrail: block activating a menu item whose recipe hits a zero-cost inventory item | **prevents recurrence** | small |

Step 0.4 matters most long-term. Without it this state returns with every new product.

### 3.6 Knock-on effect: menu quadrants are unusable until costs land

With coverage at 15.8%, the **median product margin across the period is 100.0%**, so the
Star/Plowhorse/Puzzle/Dog split (30 / 12 / 29 / 11) is currently an artefact of missing costs rather
than a measurement. The UI flags every product whose margin is not backed by ≥50% cost coverage
(`margen_confiable: false`) and the coverage banner sits above the matrix, but the classification
only becomes meaningful after step 0.1. This is expected, and it self-corrects.

### 3.7 Restatement caveat

`flask restate-costs` applies **today's** unit cost to past sales. It is a *current-cost
restatement*, not true historical cost. Acceptable over a 90-day window with stable supplier
pricing; it must stay labelled. Every API response carrying margin also carries
`cobertura_costo_pct` so a 97% margin can never be read without its coverage next to it.

---

## 4. Confirmed defect: payment-mix double-counting

`v_bola8_kpis_diarios` adds the **full ticket total** to cash if either payment slot is CASH, and
again to card if either is CARD.

| Metric | Value |
|---|---|
| `ventas_mxn` | $656,116.92 |
| `ventas_con_efectivo_mxn` + `ventas_con_tarjeta_mxn` | $749,658.02 |
| **Over-count** | **$93,541.10 (14.3%)** |

### 4.1 What the tendered fields actually mean

Initially this looked like over-tendered cash with change due. It isn't. Verified across all 96
split tickets:

```
tendered_cents + tendered_cents_2  =  total_cents + tip_cents
```

**94 of 96 match exactly, and 0 tickets exceed it.** The two tendered fields are exact applied
amounts that *include the tip* — there is no change component. Every split is `CASH + CARD`
(other combos: single CARD 513, single CASH 489, EXTERNAL 4).

### 4.2 Tip attribution uses `tip_source`, not estimation

`tip_cash_cents` / `tip_card_cents` are populated on only **4 of 889** tipped tickets — dead fields.
But `tip_source` **is** populated on 1,010 of 1,102 closed tickets (`CARD` 482, `CASH` 462,
`SPLIT` 62, `EXTERNAL` 4, null 92). So:

| `tip_source` | Rule |
|---|---|
| matches a leg's method | whole tip sits on that leg |
| `SPLIT` or null | apportioned by tendered share, flagged `propina_es_estimada` |

Only **129 of 1,116 legs (11.6%)** need estimation. Sales per leg = tendered − that leg's tip, with
leg 2 clamped to `[0, total]` and leg 1 taking the remainder, so reconciliation holds even on bad
rows.

### 4.3 Verified result

| | Sales | Tips |
|---|---|---|
| `v_bola8_pagos_desglosados` | $656,116.92 | $74,851.03 |
| `v_bola8_tickets_cerrados` | $656,116.92 | $74,851.03 |
| **Difference** | **$0.00** | **$0.00** |

Corrected mix (all history) vs. the double-counted figures:

| Method | Correct sales | Tips | `kpis_diarios` claimed |
|---|---|---|---|
| CARD | $431,100.24 | $46,514.14 | $466,613.78 |
| CASH | $224,419.68 | $28,336.89 | $283,044.24 |
| EXTERNAL | $597.00 | $0.00 | — |

Cash was overstated by **$58,624.56**, card by **$35,513.54**.

One deliberate edge case: a zero-total ticket carrying a $40 tip keeps its payment leg, otherwise
tips stop reconciling.

### 4.4 The drawer equation must subtract the daily tip payout

**House policy (confirmed by the owner):** staff are paid their tips **daily, in cash, out of the
drawer** — including tips left on card. So:

* cash tips **arrive** in the drawer with the payment, then **leave** again → they cancel
* card tips **never arrive** (they settle with the processor) but still **leave**

```
esperado = fondo + ventas_efectivo + propinas_efectivo − propinas_totales − gastos − retiros
         ≡ fondo + ventas_efectivo − propinas_tarjeta − gastos − retiros
```

The net drawer drain from tips is the **card** tips — $46,514.14 over 90 days.

Omitting this term produced an apparent persistent shortfall. It was a missing term, not a leak.
Measured before and after:

| Drawer model | Sessions within ±$50 | Median difference |
|---|---|---|
| Without tip payout | 12 / 99 | −$299.92 |
| **With tip payout** | **74 / 99** | **$0.00** |

Diagnostic distribution after the correction:

| | Before | After |
|---|---|---|
| OK | 14 | **77** |
| Sobrante | 13 | 18 |
| Faltante | 41 | **3** |
| Faltante grave | 31 | **1** |

`efectivo_esperado_sin_pago_propinas_mxn` is retained for days when tips were *not* paid out at
close — 5 of the 18 surpluses match the day's tips almost exactly, and the UI labels those
"≈ propinas no pagadas". The remaining 13 surpluses (median $1,208.87) are still unexplained and are
the genuine open question — a surplus is a smaller worry than a shortfall, but it usually means a
partial payout or a float top-up that nothing records.

**No conclusion about any employee is supported by this data.** All four remaining shortfalls were
closed by the person who closes 73 of 100 sessions — a 5.5% exception rate, against 0 of 26 for
everyone else. The sample is far too small to mean anything.

---

## 5. New derived views

| View | Grain | Unlocks |
|---|---|---|
| `v_bola8_pagos_desglosados` | ticket × payment leg | Cash Flow, Executive payment mix (fixes §4) |
| `v_bola8_flujo_caja` | cash session | Drawer variance, expenses, safe drops |
| `v_bola8_cobertura_costo` | inventory item | COGS remediation worklist (§3) |
| `v_bola8_varianza_inventario` | inventory item | Shrinkage, waste, unexplained adjustments |
| `v_bola8_personal_desempeno` | ticket × staff | Staffing, per-server risk |
| `v_bola8_anomalias_operativas` | event | Voids, reopens, manual discounts, post-close edits |
| `v_bola8_promo_redenciones` | promo application | Promotion effectiveness |

Created idempotently by **STEP 25** of `flask init-db` (`backend/app/analytics_views.py`).
`CREATE OR REPLACE VIEW` — safe to re-run. **The thirteen pre-existing views are never modified.**

> ⚠️ **Deployment note.** The thirteen original `v_bola8_*` views exist only in the live database —
> they are not defined anywhere in this repository. STEP 25 depends on
> `v_bola8_lineas_venta` and `v_bola8_tickets_cerrados` and **skips gracefully** if they are absent,
> logging a warning. Before deploying to the bar machine, confirm those two exist there.

---

## 6. Dashboard dependency map

### Phase 1 — implemented

| Dashboard | Views consumed | New views |
|---|---|---|
| **Executive** | `kpis_diarios`, `lineas_venta`, `tickets_cerrados`, `forecast_semanal`, `pagos_desglosados` | — |
| **Cash Flow** | `pagos_desglosados`, `flujo_caja` | 2 |
| **Inventory Intelligence** | `forecast_compras` (reused whole), `productos_lentos`, `varianza_inventario`, `cobertura_costo` | 2 |
| **Menu Engineering** | `lineas_venta` (date-ranged), `productos_lentos` | — |

### Phase 2 — views shipped, dashboards pending

| Dashboard | Views | Blocker |
|---|---|---|
| Staffing | `personal_desempeno` | none — UI only |
| Risk Detection | `anomalias_operativas` | none — UI only |
| Promotion Effectiveness | `promo_redenciones` | **0 redemption rows** — needs 4–6 weeks of history |
| Forecasting | `forecast_semanal`, `forecast_compras` | none — UI only |
| Demand & Channel Intelligence | `tickets_cerrados` | rescoped, see §7 |
| Owner Action Center | all of the above | depends on everything |

### Dependency chain

```
unit costs entered ──→ flask restate-costs ──┐
                                             ▼
v_bola8_lineas_venta ──┬─→ Menu Engineering ─┼─→ Profit Leakage email
                       ├─→ Executive ────────┤
                       └─→ varianza_inventario ─→ Inventory ─→ Inventory Risk email
v_bola8_tickets_cerrados ─┬─→ pagos_desglosados ─┬─→ Cash Flow
                          ├─→ flujo_caja ────────┘
                          ├─→ personal_desempeno ─→ Staffing
                          └─→ anomalias_operativas ─→ Risk Detection
                                                        │
       Executive + Cash Flow + Inventory + Menu + Risk ──┴─→ Owner Action Center
                                                         └─→ Daily Executive Summary email
```

---

## 7. Permanent data gaps

| Gap | Why no view can fix it | What it needs |
|---|---|---|
| **Customer retention** (repeat rate, RFM, cohorts, CLV) | No customer key exists — only free-text `customer_name` and `rappi_order_id` | **Product change:** capture phone or loyalty code at ticket open. ~2 months of accumulation before analysis is meaningful. Ships meanwhile as channel / table / daypart intelligence. |
| **Labor cost %** | No schedule, shift or wage table | **New table.** Until then Staffing measures output per server, not cost efficiency. |
| **Budget variance** | No targets table | Small new table; Executive currently compares against prior period and trailing same-weekday. |
| **Tip split by method** | Source fields populated 4 / 889 | Allocated proportionally and flagged as derived. |
| **Promo ROI** | Schema ready, `line_item_promotions` empty | Accumulate history. Verify on production — 0 rows may be a dev artifact. |

### 7.1 Promo discounts bypass `discount_cents`

Promotions write to `line_item_promotions`, **not** `tickets.discount_cents` (only 41 tickets carry
a manual discount). Therefore `allocated_discount_cents` in `v_bola8_lineas_venta` **excludes promo
discounts**. Once promos run at volume, discounted lines will overstate both net sales and profit —
a second inflation on top of COGS, growing with promo adoption.
`v_bola8_promo_redenciones` makes it visible; netting it out of the line view is a separate decision
because that view must not be modified.

---

## 8. Performance & index strategy

**The dataset is small:** 1,102 closed tickets, 5,870 line items, 90 days, 100 cash sessions. Every
query here runs in single-digit milliseconds. No index program is warranted yet, and unused indexes
cost write throughput on a POS whose hot path is order entry at peak hours.

**The real risk is view stacking, not missing indexes.** `v_bola8_recomendaciones` sits four levels
deep over `lineas_venta` (5 joins, 2 CTEs, a window function over all history). No intermediate view
accepts a date filter, so **predicates cannot push down** — "last week" still materialises
everything. Free at 5,870 rows; not at 70,000. Mitigation is architectural, not an index.

Already present from earlier migrations (STEP 11d / 17) — do not duplicate:
`idx_tickets_status`, `idx_tli_ticket_status`, `idx_sale_item_costs_line_item`,
`idx_sale_item_costs_inventory_item`, `idx_inventory_movements_item_created`,
`idx_inventory_movements_event_type`.

Added by STEP 25, chosen to match the new views' actual access paths:

| Index | Serves |
|---|---|
| `idx_tickets_closed_at_closed` (partial, `status='CLOSED'`) | every date-ranged dashboard |
| `idx_tickets_closed_by` / `idx_tickets_opened_by` | `personal_desempeno` |
| `idx_tli_voided_at` (partial, `voided_at IS NOT NULL`) | `anomalias_operativas` |
| `idx_expenses_session` | `flujo_caja` |
| `idx_safe_collections_created` | `flujo_caja` |
| `idx_lip_ticket` / `idx_lip_promotion` | `promo_redenciones` |
| `idx_cash_sessions_opened_at` | `flujo_caja` |

All use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` where run outside a transaction; STEP 25 runs
inside `init-db`'s transaction, so it uses plain `IF NOT EXISTS` and documents the concurrent form
for production application.

### Refresh strategy

| Tier | Latency | Mechanism | Applies to |
|---|---|---|---|
| Live | on request | plain views | everything at current volume |
| Cached | 5–15 min | HTTP cache on analytics endpoints | Executive, Owner Action Center |
| Materialized | nightly ~04:00 | matviews + unique index for `REFRESH CONCURRENTLY` | **trigger: p95 > 2 s, or `lineas_venta` > 50,000 rows** |

Target: **< 500 ms p95** per endpoint at 3× current volume.

---

## 9. Access control

Analytics is **ADMIN only** — cost structure, supplier pricing, per-employee performance and drawer
variance. `MANAGER` is deliberately excluded.

| Layer | Control |
|---|---|
| API | `require_admin()` on every route in `analytics.py`; role read from JWT claims server-side |
| UI | `<RequireAuth roles={['ADMIN']}>` on `/manager/analytics`; tile hidden for non-admins |
| Roles present | `ADMIN` ×3, `MANAGER` ×3, `WAITER` ×3, `BAR_STAFF` ×1, `KITCHEN_STAFF` ×1 |

This mirrors the existing treatment of `/manager/reports`, `/manager/earnings` and `/manager/safe`.

---

## 10. Automated emails

Extends the existing `email_report_svc.py` + APScheduler container. **An email is a scheduled render
of a dashboard query, never its own report** — if email and dashboard disagree, both lose trust.

| Email | Schedule | Views | Notes |
|---|---|---|---|
| **Daily Executive Summary** | 08:00 daily | `kpis_diarios`, `lineas_venta`, `tickets_cerrados`, `forecast_semanal`, **`pagos_desglosados`** | Uses the corrected payment mix, never `kpis_diarios`' double-counted columns. Carries `cobertura_costo_pct` beside profit. |
| **Inventory Risk Alert** | 07:00, **conditional** | `forecast_compras`, `productos_lentos`, `varianza_inventario` | **Suppress on empty.** A daily "all fine" email gets filtered, and then the one that matters gets filtered too. |
| **Profit Leakage Report** | Mon 08:00 weekly | `lineas_venta`, `anomalias_operativas`, `flujo_caja`, `varianza_inventario`, later `promo_redenciones` | One ranked table, every leak in MXN, largest first. **Do not partially ship** — missing the cash or inventory leg systematically under-reports. |

Cross-cutting: every figure deep-links to its dashboard with the date range pre-filtered; recipients
are admins only; idempotent by report date so a container restart cannot double-send; failures alert
rather than fail silently.

---

## 11. Implementation roadmap

| Wave | Content | Status |
|---|---|---|
| **0** | Unit costs, restatement, cost-coverage guardrail | 🔧 tooling shipped, **data entry pending** |
| **1** | 7 views, analytics API, Menu Engineering, Executive, Cash Flow, Inventory | ✅ shipped |
| **2** | Staffing + Risk Detection UI (views already shipped) | ⏳ |
| **3** | Forecasting UI + forecast accuracy backtest | ⏳ |
| **4** | Demand & Channel Intelligence (rescoped) | ⏳ pending §7 decision |
| **5** | Promotion Effectiveness | ⏳ blocked on history |
| **6** | Owner Action Center + 3 emails | ⏳ |

**Minimum viable set if budget is tight:** Menu Engineering + Cash Flow + Daily Executive Summary.
That covers profit visibility, the $93,541 payment correction, and drawer variance — the three
places where a wrong number costs real pesos.

---

## 12. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Who enters the 64 unit costs, by when? | Highest-ROI hour in the program. Needs a name and a date. |
| 2 | Approve current-cost restatement of history? | Yes, labelled. Turns 90 dead days into analysable data. |
| 3 | Customer identity capture at POS? | Required for real retention. Product change, not analytics. |
| 4 | Targets/budget table? | Small effort, high owner value. |
| 5 | Verify promo rows + COGS state on production? | Before Phase 2 design. |
| 6 | Do the 13 original views exist on the bar machine? | **Blocks deployment** — verify first. |

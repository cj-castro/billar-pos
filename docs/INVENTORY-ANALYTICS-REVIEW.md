# billar-pos — Inventory & Analytics Review

**Date:** 2026-11-24 · **Data:** local `billiardbar` (sales through 2026-07-31) · **Code:** branch `fix/inventory-bottle-batch1`

Tags: **[V]** verified (query run or exact code read) · **[S]** suspected.

---

## 0. The short version

1. **Inventory mechanics are now sound** (batch 1): one opening path, cost carried to shots, shots only from opened bottles, whole numbers, row locks that actually lock, a ledger that would catch drift. What remains is **data** and **two missing features** (honest voids; per-bottle tracking).
2. **Margins in every report are mostly fiction.** 76 of 93 active stock items have no cost, and **82% of July's cost rows are $0** [V]. Several screens still present those as 100%-margin "stars" and even recommend pushing them.
3. **Some numbers the owner sees are simply wrong** — not cosmetic: the cash-flow dashboard invents **$35.8k of drawer overages** (one night shows +$17,923 that never happened) [V]; Earnings drops the last day of every range [V]; the Telegram bot reports yesterday's sales as today's [V]; payment-method totals count split-ticket tips as sales [V].
4. **The screens overlap** (Analytics / Reports / Earnings each compute revenue and margin their own way and disagree), the landing page shows no numbers, and none of the analytics screens are translated or free of Bola 8 specifics.
5. **Recommended order:** fix the wrong numbers → make margins honest → owner home + one date bar → restructure pages → inventory batch 2/3. Details in §4.

---

## 1. Inventory — rundown

### 1.1 How it works today

| Step | Mechanism |
|---|---|
| Stock items | `inventory_items` in a base unit (botella, caballito, pieza, ml…). Counted units take whole numbers on manual entry (041). |
| What a sale uses | Menu item recipe (`insumos_base`) + per-modifier rules (`modifier_inventory_rules`, e.g. bottle-service mixers). |
| When stock moves | When the item is **added to the ticket** (not at payment). One `SALE_DEDUCTION` movement + one `sale_item_costs` row per ingredient, priced at the weighted average cost at that moment. |
| Bottles → shots, boxes → loose | `inventory_conversions` (one active per parent). Only "Abrir botella / caja" adds shots; asks "Todavía quedan N, ¿abrir otra?". Auto-open on sale is **off by policy**. |
| Corrections | Waste, physical count, manual ±; restock blocked on shots; shots go up only by opening (owner can raise a count). |
| Integrity | Every change writes an `inventory_movements` row with who/when/after-balance; triggers detect chain breaks; shots can never go negative. Ledger trustworthy from 2026-06-01. |

### 1.2 Data health (live numbers)

| Check | Value | Meaning |
|---|---|---|
| Active items with **no cost** | **76 / 93** [V] | Margin and COGS reports can't be right until costs are entered. |
| July cost rows at $0 | **2,387 / 2,917 (82%)** [V] | Same, at sale level. |
| Active menu items **without a recipe** | **12 / 86** [V] | They sell without touching stock. |
| Items with no movement since June | 24 [V] | Dead or never-counted items. |
| Negative stock / open ledger violations | 0 / 0 [V] | Good. |
| Movements with NULL timestamp | 60 [V] | Pre-ledger legacy; excluded from windows. |
| Voided lines since June | 206 of 3,025 (**6.8%**), ≈ **$59.7k MXN** [V] | High. Attribution before the August PIN fix is unreliable (see memory note on the manager-PIN bypass) — investigate before drawing conclusions about people. |
| Tequila Blanco Bottle | 19 on the books, ~15 phantom [V] | Needs a physical count. |

### 1.3 Still open (from the original review)

| # | Issue | Plan |
|---|---|---|
| 1 | A void returns poured/opened product to stock | **Batch 2**: void asks "¿Se devolvió o se tiró?" (default *tirado* once sent) |
| 13 | Quantity edit reverses + re-sells the whole line; churns the ledger and credits the sale to the manager | Batch 2: move only the difference |
| 4, 11 | No record per open bottle; no ml; over-pouring undetectable | **Batch 3** redesign (volume + open bottles) |
| 8 | No comps / staff drinks with a reason | Batch 3 |
| 9 | Shift close has no inventory step | Batch 3 (count sheet tied to the cash session) |
| 10 | Variance report: rolling 28 days, ignores conversions, units not $ | Batch 3 (and partially Analytics batch B) |
| 14 | Ticket screen stops live-updating after a reconnect | Analytics batch C (shared socket fix) |
| 16 | "Bottle Service – Tequila Reposado" deducts *Cristalino* | Owner to confirm |

---

## 2. Analytics — wrong numbers (fix first)

| # | Where | What's wrong | Evidence |
|---|---|---|---|
| A1 | `v_bola8_flujo_caja` | Subtracts every safe pickup logged inside the session's time window — including pickups after the count or logged days later — so the dashboard shows overages that never happened. | 2026-05-24: POS −$0.04, dashboard **+$17,923.48 "Sobrante"**; 8 sessions, **$35,852 fake** [V] |
| A2 | `v_bola8_pagos_desglosados` | Ignores `tip_source` on single-payment tickets; assigns tickets to sessions by close time while the POS uses open time. | 3 tickets / $315.85 misfiled; 2 false surpluses [V] |
| A3 | `earnings.py:30-33` + `EarningsPage.tsx:12` | `to=YYYY-MM-DD` read as midnight at the **start** of that day; "today" built in UTC. | Jul 1–31 drops Jul 31 (24 tickets, $16,476); single day = $0 [V] |
| A4 | `telegram-bot/bot.py` (13 queries) | `AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'` on a timestamptz shifts the wrong way. | 2026-07-26 bot: $9,205 (really the 25th); real: $4,903 [V] |
| A5 | `reports.py:206-228, 322-333` | Payment and staff reports use `tendered_cents` (includes tip) on split tickets. | July methods sum $3,606 above revenue [V] |
| A6 | `v_bola8_forecast_compras` / `productos_lentos` / `recomendaciones` | Labels stored as mojibake (`m├¡nimo`), so `analytics.py:575` never matches: below-minimum items never reach the shopping list. | [V] |
| A7 | `v_bola8_anomalias_operativas` | Cancelled tickets that had served items/pool time are invisible. | 9 tickets, $1,726 items + $1,399 pool [V] |
| A8 | Several views | `CURRENT_DATE` / `date_trunc` in UTC: after 18:00 "today" is tomorrow; forecasts average only days with sales. | [V] |
| A9 | `AnalyticsPage.tsx:56-59` | Default date range computed in UTC. | [V] |
| A10 | `ReportsPage.tsx:73` | CSV export opens a tab without the auth token → 401; 6 tabs export empty files; `pool` ≠ backend `pool-time`. | [V] |
| A11 | Hourly charts | Use ticket close time; 87% of lines land in a different hour than ordered (median tab 107 min). | [V] |
| A12 | `v_bola8_forecast_compras` | Ignores bottle use (`CONVERSION_OUT`) and production consumption. | [V code] |

**Tip policy:** `cash_session.py` correctly subtracts all tips (card included) from expected cash. The wrong drawer numbers come from A1/A2/A5.

## 3. Analytics — misleading, missing, structure

**Misleading**
- Earnings has its own COGS model, no coverage %, and colors margin ≥60% green: July shows ~96% margin while 1,316 of 1,684 lines have no cost [V]. Analytics and Earnings show two different "ganancia bruta" for the same range [V].
- Menu engineering classifies 69/92 products at 100% margin; a product with a real cost can never be a "star" [V]. `v_bola8_recomendaciones` tells the owner to push the zero-cost items [V].
- Staff profit, Telegram margins and period-over-period profit ignore cost coverage.

**Screens** (ManagerDashboard, Analytics, Reports, Earnings, Cash)
- Landing page = 13 link tiles, no numbers. Three different default date ranges. No error states (a 500 shows "Sin datos"). No i18n on any analytics screen. Wide tables clipped on tablets. "Bola 8", the timezone and deploy commands visible in the UI.
- Cash close: expected cash shown **before** the count (not blind); overage shown green; history in UTC and without over/short.
- Exists but has no UI: fixed-costs editor (`PUT /analytics/fixed-costs/<id>`), promotions report.

**Missing, data already supports it**
- Table utilization (hours played ÷ hours open) and $ per table-hour heatmap (weekday × hour).
- Shrinkage in **$** by item with trend; theoretical vs actual usage per count period.
- Voids / discounts / cancellations as **% of each person's sales**.
- Drawer over/short history by cashier.
- Promotion ROI.

**Blocking sale to other halls**
- `America/Mexico_City`, MXN and "Bola 8" hard-coded (views, `reports.py`, bot, receipt, login, navbar); `Config.CURRENCY` defaults to USD while views emit `_mxn`.
- `v_bola8_*` names; business day = calendar day (29% of sessions cross midnight — needs a configurable cutoff).
- Fixed costs have no effective dates (editing rent rewrites history).

**Dead / duplicated**
- ~25 views used by nothing (several dashboard views, most audit/inventory views).
- Four places compute revenue/margin, three compute staff, two compute the drawer — and they disagree.

---

## 4. Plan

| Batch | Scope | Size |
|---|---|---|
| **A. Correct numbers** | A1–A12: drawer view (safe pickups by session, tip_source, one session rule), Earnings end-of-day + local "today", Telegram timezone, payments/staff from the split view, UTF-8 view rebuild, cancelled tickets in anomalies, local dates everywhere, CSV export with auth, hourly by order time, forecast counts bottle use. Regression tests against the scratch DB comparing each view to the POS. | M |
| **B. Honest margins** | One COGS source (`sale_item_costs`); every margin shows coverage; items without cost show "sin costo", are excluded from menu matrix / recommendations / "stars"; Earnings merged into Analytics. A "Costos faltantes" checklist that links to Reabastecer. | M |
| **C. Owner home & basics** | Inicio with today vs same weekday last week, revenue split pool/bar/kitchen, drawer status, alerts; one date bar (Hoy/Ayer/Semana/Mes/Mes pasado, URL state, comparison); shared loading/error state; blind cash close; tablet layout; fixed-costs editor; ticket-socket reconnect fix. | M |
| **D. Structure & product-ready** | Pages: Inicio · Ventas · Billar · Rentabilidad · Caja · Inventario · Personal y Riesgos. Full i18n. Business settings: name/logo, timezone, currency, business-day cutoff; neutral view names; retire dead views/endpoints. | L |
| **E. Inventory** | Batch 2 (honest voids, qty-change delta) → Batch 3 redesign (volume + open bottles, comps, shift count, variance in $, purchase suggestions). | M → L |

**Owner tasks (no code):** enter costs for the 76 items (the "Costos faltantes" list in B makes this a 20-minute job), add recipes to the 12 menu items, count spirits (Tequila Blanco first), confirm the Reposado/Cristalino bottle service.

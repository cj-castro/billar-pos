"""
Analytics layer — new derived views (STEP 26 of `flask init-db`).

These extend the thirteen pre-existing `v_bola8_*` views. **The originals are never
modified.** Everything here is `CREATE OR REPLACE VIEW`, so re-running init-db is safe.

Design rules (see docs/analytics-blueprint.md):
  * Money aggregates in integer `_cents`, then divides by 100 and casts to
    NUMERIC(18,2) ONCE at the outermost projection. Rounding sub-aggregates and
    summing them produces cent drift.
  * Never FLOAT / DOUBLE PRECISION.
  * Every date derivation goes through AT TIME ZONE 'America/Mexico_City' before
    ::date. A UTC-based date pushes post-18:00 local revenue — most of a bar's
    night — onto the following day.
  * Views MAY read base tables (that is how the original thirteen work).
    Dashboard queries may not — they read only v_bola8_* views.

DEPENDENCY WARNING
    v_bola8_lineas_venta and v_bola8_tickets_cerrados are NOT defined anywhere in
    this repository — they exist only in the live database. `ensure_analytics_views`
    checks for them and skips with a warning rather than failing init-db.
"""

TZ = "America/Mexico_City"

# Views these definitions depend on. If missing, STEP 26 is skipped.
REQUIRED_VIEWS = ("v_bola8_lineas_venta", "v_bola8_tickets_cerrados")


# ─────────────────────────────────────────────────────────────────────────────
# 1. v_bola8_pagos_desglosados — ticket × payment leg
#
#    Fixes the double-count in v_bola8_kpis_diarios, which adds the FULL ticket
#    total to cash if either slot is CASH and again to card if either is CARD.
#    Measured over 90 days that inflates cash+card by $93,541.10 (14.3%).
#
#    HOW SPLIT TICKETS ACTUALLY WORK (verified against all 96 in the data):
#        tendered_cents + tendered_cents_2 = total_cents + tip_cents   (94 of 96 exact,
#        0 tickets exceed it). So the two tendered fields are NOT over-tendered cash
#        with change due — they are exact applied amounts that INCLUDE the tip.
#        Every split is CASH+CARD.
#
#    Tip attribution uses tickets.tip_source ('CASH' / 'CARD' / 'SPLIT' / NULL),
#    which is populated on 1,010 of 1,102 closed tickets. That beats estimating:
#      * tip_source matches a leg's method  -> the whole tip sits on that leg
#      * 'SPLIT' or NULL                    -> apportioned by tendered share
#    tip_cash_cents / tip_card_cents are NOT used: populated on 4 of 889 tipped
#    tickets, effectively dead.
#
#    Sales per leg = tendered - that leg's tip. leg 2 is clamped to [0, total] and
#    leg 1 takes the remainder, so cash + card reconcile EXACTLY to ventas_mxn
#    regardless of any bad row.
# ─────────────────────────────────────────────────────────────────────────────
V_PAGOS_DESGLOSADOS = f"""
CREATE OR REPLACE VIEW public.v_bola8_pagos_desglosados AS
WITH base AS (
    SELECT
        v.ticket_id,
        v.closed_at,
        v.fecha_mx,
        v.hora_mx,
        v.dia_semana_iso,
        v.ticket_type,
        v.total_cents,
        v.tip_cents,
        v.payment_type,
        v.payment_type_2,
        COALESCE(t.tendered_cents,   0) AS tendered_1,
        COALESCE(t.tendered_cents_2, 0) AS tendered_2,
        t.tip_source
    FROM v_bola8_tickets_cerrados v
    JOIN tickets t ON t.id = v.ticket_id
),
split AS (
    SELECT
        b.*,
        -- Tip belonging to leg 2 (the second payment method).
        CASE
            WHEN b.payment_type_2 IS NULL                 THEN 0
            WHEN b.tip_source = b.payment_type_2          THEN b.tip_cents
            WHEN b.tip_source = b.payment_type            THEN 0
            WHEN (b.tendered_1 + b.tendered_2) > 0
                THEN round(b.tip_cents::numeric * b.tendered_2
                           / (b.tendered_1 + b.tendered_2))
            ELSE 0
        END::integer AS leg2_tip_cents,
        -- TRUE when the tip had to be apportioned rather than read off tip_source.
        (b.payment_type_2 IS NOT NULL
         AND b.tip_cents > 0
         AND (b.tip_source IS NULL
              OR b.tip_source NOT IN (b.payment_type, b.payment_type_2))) AS tip_estimado
    FROM base b
),
alloc AS (
    SELECT
        s.*,
        -- Sales on leg 2 = its tendered amount minus its tip, clamped into range.
        LEAST(GREATEST(s.tendered_2 - s.leg2_tip_cents, 0), s.total_cents)::integer
            AS leg2_sales_cents
    FROM split s
),
legs AS (
    -- Leg 1 always exists; it absorbs whatever leg 2 did not take, so the two
    -- legs always sum to total_cents.
    SELECT ticket_id, closed_at, fecha_mx, hora_mx, dia_semana_iso, ticket_type,
           total_cents, tip_estimado,
           1                                              AS orden_pago,
           payment_type                                   AS metodo_pago,
           (total_cents - CASE WHEN payment_type_2 IS NULL
                               THEN 0 ELSE leg2_sales_cents END)::integer AS monto_cents,
           (tip_cents - CASE WHEN payment_type_2 IS NULL
                             THEN 0 ELSE leg2_tip_cents END)::integer     AS propina_cents,
           (payment_type_2 IS NOT NULL)                   AS es_split
    FROM alloc
    UNION ALL
    SELECT ticket_id, closed_at, fecha_mx, hora_mx, dia_semana_iso, ticket_type,
           total_cents, tip_estimado,
           2, payment_type_2, leg2_sales_cents, leg2_tip_cents, TRUE
    FROM alloc
    WHERE payment_type_2 IS NOT NULL
      AND (leg2_sales_cents > 0 OR leg2_tip_cents > 0)
)
SELECT
    ticket_id,
    closed_at,
    fecha_mx,
    hora_mx,
    dia_semana_iso,
    ticket_type,
    COALESCE(metodo_pago, 'DESCONOCIDO')::varchar          AS metodo_pago,
    orden_pago,
    es_split,
    monto_cents,
    (round(monto_cents::numeric / 100, 2))::numeric(18,2)  AS monto_mxn,
    GREATEST(propina_cents, 0)                             AS propina_cents,
    (round(GREATEST(propina_cents, 0)::numeric / 100, 2))::numeric(18,2) AS propina_mxn,
    tip_estimado                                           AS propina_es_estimada
FROM legs
-- A zero-total ticket that still carries a tip must keep its leg, or tips stop
-- reconciling against v_bola8_tickets_cerrados.
WHERE monto_cents > 0 OR propina_cents > 0
"""


# ─────────────────────────────────────────────────────────────────────────────
# 2. v_bola8_flujo_caja — one row per cash session (drawer variance)
#
#    safe_collections has no session_id, and tickets have no session_id, so both
#    are attributed by time window [opened_at, COALESCE(closed_at, now())).
#
#    TIP PAYOUT — the term that makes the drawer balance.
#    House policy: staff are paid their tips DAILY IN CASH, out of the drawer.
#    That applies to tips earned on card as well as on cash, so:
#        * cash tips arrive in the drawer with the payment, then leave again
#        * card tips NEVER arrive (they settle with the processor) but still leave
#    Net drawer drain from tips is therefore the CARD tips:
#        esperado = fondo + ventas_efectivo + propinas_efectivo - propinas_totales
#                          - gastos - retiros
#                 ≡ fondo + ventas_efectivo - propinas_tarjeta - gastos - retiros
#
#    Verified: without this term only 12 of 99 closed sessions reconciled within
#    ±$50 and the median was -$299.92. With it, 74 of 99 reconcile and the median
#    is exactly $0.00. The apparent "persistent cash shortfall" was a missing term,
#    not a leak.
#
#    efectivo_esperado_sin_pago_propinas_mxn is kept for days when tips were NOT
#    paid out at close, which would otherwise read as a large surplus.
# ─────────────────────────────────────────────────────────────────────────────
V_FLUJO_CAJA = f"""
CREATE OR REPLACE VIEW public.v_bola8_flujo_caja AS
WITH sess AS (
    SELECT
        cs.id                                                    AS session_id,
        cs.date                                                  AS fecha_sesion,
        (cs.opened_at AT TIME ZONE '{TZ}')::date                 AS fecha_mx,
        cs.status,
        cs.opened_at,
        cs.closed_at,
        COALESCE(cs.opening_fund_cents, 0)                       AS fondo_inicial_cents,
        cs.closing_cash_counted_cents,
        uo.name                                                  AS abierta_por,
        uc.name                                                  AS cerrada_por
    FROM cash_sessions cs
    LEFT JOIN users uo ON uo.id = cs.opened_by
    LEFT JOIN users uc ON uc.id = cs.closed_by
),
ventas AS (
    SELECT
        s.session_id,
        SUM(CASE WHEN p.metodo_pago = 'CASH' THEN p.monto_cents   ELSE 0 END) AS efectivo_ventas_cents,
        SUM(CASE WHEN p.metodo_pago = 'CARD' THEN p.monto_cents   ELSE 0 END) AS tarjeta_ventas_cents,
        SUM(CASE WHEN p.metodo_pago NOT IN ('CASH','CARD') THEN p.monto_cents ELSE 0 END) AS otros_ventas_cents,
        SUM(CASE WHEN p.metodo_pago = 'CASH' THEN p.propina_cents ELSE 0 END) AS propinas_efectivo_cents,
        SUM(CASE WHEN p.metodo_pago <> 'CASH' THEN p.propina_cents ELSE 0 END) AS propinas_tarjeta_cents,
        SUM(p.propina_cents)                                                  AS propinas_totales_cents,
        SUM(p.monto_cents)                                                    AS ventas_totales_cents,
        COUNT(DISTINCT p.ticket_id)                                           AS tickets
    FROM sess s
    JOIN v_bola8_pagos_desglosados p
      ON p.closed_at >= s.opened_at
     AND p.closed_at <  COALESCE(s.closed_at, now())
    GROUP BY s.session_id
),
gastos AS (
    SELECT session_id,
           SUM(COALESCE(amount_cents, 0)) AS gastos_cents,
           COUNT(*)                       AS num_gastos
    FROM expenses
    GROUP BY session_id
),
retiros AS (
    SELECT s.session_id,
           SUM(COALESCE(sc.amount_cents, 0)) AS retiros_cents,
           COUNT(*)                          AS num_retiros
    FROM sess s
    JOIN safe_collections sc
      ON sc.created_at >= s.opened_at
     AND sc.created_at <  COALESCE(s.closed_at, now())
    GROUP BY s.session_id
),
calc AS (
    SELECT
        s.*,
        COALESCE(v.efectivo_ventas_cents, 0)   AS efectivo_ventas_cents,
        COALESCE(v.tarjeta_ventas_cents, 0)    AS tarjeta_ventas_cents,
        COALESCE(v.otros_ventas_cents, 0)      AS otros_ventas_cents,
        COALESCE(v.propinas_efectivo_cents, 0) AS propinas_efectivo_cents,
        COALESCE(v.propinas_tarjeta_cents, 0)  AS propinas_tarjeta_cents,
        COALESCE(v.propinas_totales_cents, 0)  AS propinas_totales_cents,
        COALESCE(v.ventas_totales_cents, 0)    AS ventas_totales_cents,
        COALESCE(v.tickets, 0)                 AS tickets,
        COALESCE(g.gastos_cents, 0)            AS gastos_cents,
        COALESCE(g.num_gastos, 0)              AS num_gastos,
        COALESCE(r.retiros_cents, 0)           AS retiros_cents,
        COALESCE(r.num_retiros, 0)             AS num_retiros
    FROM sess s
    LEFT JOIN ventas  v ON v.session_id = s.session_id
    LEFT JOIN gastos  g ON g.session_id = s.session_id
    LEFT JOIN retiros r ON r.session_id = s.session_id
)
SELECT
    session_id,
    fecha_sesion,
    fecha_mx,
    status,
    opened_at,
    closed_at,
    abierta_por,
    cerrada_por,
    tickets,
    num_gastos,
    num_retiros,
    (round(fondo_inicial_cents::numeric      / 100, 2))::numeric(18,2) AS fondo_inicial_mxn,
    (round(efectivo_ventas_cents::numeric    / 100, 2))::numeric(18,2) AS efectivo_ventas_mxn,
    (round(tarjeta_ventas_cents::numeric     / 100, 2))::numeric(18,2) AS tarjeta_ventas_mxn,
    (round(otros_ventas_cents::numeric       / 100, 2))::numeric(18,2) AS otros_ventas_mxn,
    (round(ventas_totales_cents::numeric     / 100, 2))::numeric(18,2) AS ventas_totales_mxn,
    (round(propinas_efectivo_cents::numeric  / 100, 2))::numeric(18,2) AS propinas_efectivo_mxn,
    (round(propinas_tarjeta_cents::numeric   / 100, 2))::numeric(18,2) AS propinas_tarjeta_mxn,
    (round(propinas_totales_cents::numeric   / 100, 2))::numeric(18,2) AS propinas_pagadas_mxn,
    (round(gastos_cents::numeric             / 100, 2))::numeric(18,2) AS gastos_mxn,
    (round(retiros_cents::numeric            / 100, 2))::numeric(18,2) AS retiros_caja_fuerte_mxn,
    -- Cash tips come in with the payment and go straight back out to staff, so
    -- they cancel; the net drain is the tips earned on card.
    (round((fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
            - propinas_totales_cents - gastos_cents - retiros_cents)::numeric / 100, 2))::numeric(18,2)
        AS efectivo_esperado_mxn,
    -- For days when tips were NOT paid out at close.
    (round((fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
            - gastos_cents - retiros_cents)::numeric / 100, 2))::numeric(18,2)
        AS efectivo_esperado_sin_pago_propinas_mxn,
    CASE WHEN closing_cash_counted_cents IS NULL THEN NULL
         ELSE (round(closing_cash_counted_cents::numeric / 100, 2))::numeric(18,2)
    END AS efectivo_contado_mxn,
    -- Positive = drawer over, negative = drawer short
    CASE WHEN closing_cash_counted_cents IS NULL THEN NULL
         ELSE (round((closing_cash_counted_cents
                      - (fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
                         - propinas_totales_cents - gastos_cents - retiros_cents))::numeric / 100, 2))::numeric(18,2)
    END AS diferencia_mxn,
    -- Tolerance is the greater of $50 or 2% of expected cash; 'Faltante grave'
    -- needs >= $500 or >= 10%. With the tip-payout term in place the median
    -- difference is $0.00, so anything flagged here is a genuine exception.
    CASE
        WHEN closing_cash_counted_cents IS NULL THEN 'Sesión abierta'
        WHEN abs(closing_cash_counted_cents
                 - (fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
                    - propinas_totales_cents - gastos_cents - retiros_cents))
             <= GREATEST(5000, (fondo_inicial_cents + efectivo_ventas_cents
                                + propinas_efectivo_cents - propinas_totales_cents
                                - gastos_cents - retiros_cents) * 2 / 100)
            THEN 'OK'
        WHEN closing_cash_counted_cents
             < (fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
                - propinas_totales_cents - gastos_cents - retiros_cents)
            THEN CASE
                WHEN (fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
                      - propinas_totales_cents - gastos_cents - retiros_cents
                      - closing_cash_counted_cents)
                     >= GREATEST(50000, (fondo_inicial_cents + efectivo_ventas_cents
                                         + propinas_efectivo_cents - propinas_totales_cents
                                         - gastos_cents - retiros_cents) * 10 / 100)
                    THEN 'Faltante grave'
                ELSE 'Faltante'
            END
        ELSE 'Sobrante'
    END AS diagnostico_caja
FROM calc
"""


# ─────────────────────────────────────────────────────────────────────────────
# 3. v_bola8_cobertura_costo — the COGS remediation worklist
#
#    84.5% of sold lines carry zero cost, but NOT because recipes are missing —
#    the deduction engine runs and multiplies by a unit cost of zero. 64 of 76
#    active inventory items have unit_cost_cents = 0, and $468,419.70 of line
#    revenue flows through them. purchase_cost_cents is also 0 on all 64, so
#    nothing can be derived; the numbers must be entered by hand.
#
#    Categorías 'Daños' and 'INGRESOS' are legitimately costless (damage recovery
#    and misc income) and are excluded from the coverage denominator downstream —
#    otherwise coverage can never reach 100% and the metric stops being trusted.
# ─────────────────────────────────────────────────────────────────────────────
V_COBERTURA_COSTO = """
CREATE OR REPLACE VIEW public.v_bola8_cobertura_costo AS
WITH exposicion AS (
    -- one row per (insumo, línea) so a line with 3 ingredients is not triple counted
    SELECT DISTINCT inventory_item_id, ticket_line_item_id
    FROM sale_item_costs
),
rev AS (
    SELECT e.inventory_item_id,
           SUM(l.net_sales_cents) AS ventas_expuestas_cents,
           COUNT(*)               AS lineas_expuestas,
           MAX(l.fecha_mx)        AS ultima_venta
    FROM exposicion e
    JOIN v_bola8_lineas_venta l ON l.line_item_id = e.ticket_line_item_id
    GROUP BY e.inventory_item_id
)
SELECT
    ii.id                                   AS inventory_item_id,
    ii.name                                 AS insumo,
    ii.category,
    ii.unit,
    ii.supplier,
    COALESCE(ii.unit_cost_cents, 0)         AS unit_cost_cents,
    (round(COALESCE(ii.unit_cost_cents, 0)::numeric / 100, 2))::numeric(18,2) AS unit_cost_mxn,
    (COALESCE(ii.unit_cost_cents, 0) > 0)   AS tiene_costo,
    COALESCE(r.lineas_expuestas, 0)         AS lineas_expuestas,
    (round(COALESCE(r.ventas_expuestas_cents, 0)::numeric / 100, 2))::numeric(18,2)
                                            AS ventas_expuestas_mxn,
    r.ultima_venta,
    CASE
        WHEN COALESCE(ii.unit_cost_cents, 0) > 0                THEN 'OK'
        WHEN COALESCE(r.ventas_expuestas_cents, 0) >= 2000000   THEN 'Crítico — capturar costo ya'
        WHEN COALESCE(r.ventas_expuestas_cents, 0) > 0          THEN 'Pendiente — costo faltante'
        ELSE 'Sin ventas — baja prioridad'
    END AS prioridad
FROM inventory_items ii
LEFT JOIN rev r ON r.inventory_item_id = ii.id
WHERE COALESCE(ii.is_active, TRUE)
ORDER BY (COALESCE(ii.unit_cost_cents, 0) > 0),
         COALESCE(r.ventas_expuestas_cents, 0) DESC
"""


# ─────────────────────────────────────────────────────────────────────────────
# 4. v_bola8_varianza_inventario — shrinkage / waste, 28-day window
#
#    Matches the 28-day window used by v_bola8_forecast_compras so the two read
#    consistently. Theoretical usage (sale deductions net of void reversals) is
#    separated from everything that is NOT a sale — waste and manual/count
#    adjustments — which is where shrinkage hides.
# ─────────────────────────────────────────────────────────────────────────────
V_VARIANZA_INVENTARIO = """
CREATE OR REPLACE VIEW public.v_bola8_varianza_inventario AS
WITH mov AS (
    SELECT
        m.inventory_item_id,
        SUM(CASE WHEN m.event_type IN ('SALE_DEDUCTION','SALE_CONSUMPTION')
                 THEN abs(m.quantity_delta) ELSE 0 END)              AS consumo_ventas,
        SUM(CASE WHEN m.event_type = 'VOID_REVERSAL'
                 THEN abs(m.quantity_delta) ELSE 0 END)              AS reversas_void,
        SUM(CASE WHEN m.event_type = 'WASTE'
                 THEN abs(m.quantity_delta) ELSE 0 END)              AS merma_declarada,
        SUM(CASE WHEN m.event_type = 'MANUAL_ADJUSTMENT'
                 THEN m.quantity_delta ELSE 0 END)                   AS ajuste_manual,
        SUM(CASE WHEN m.event_type = 'COUNT_ADJUSTMENT'
                 THEN m.quantity_delta ELSE 0 END)                   AS ajuste_conteo,
        SUM(CASE WHEN m.event_type = 'RESTOCK'
                 THEN abs(m.quantity_delta) ELSE 0 END)              AS reabastecimiento,
        COUNT(*) FILTER (WHERE m.event_type IN
                 ('MANUAL_ADJUSTMENT','COUNT_ADJUSTMENT','WASTE'))    AS eventos_no_venta
    FROM inventory_movements m
    WHERE m.created_at >= now() - interval '28 days'
    GROUP BY m.inventory_item_id
),
calc AS (
    SELECT
        ii.id, ii.name, ii.category, ii.unit,
        COALESCE(ii.unit_cost_cents, 0) AS unit_cost_cents,
        COALESCE(m.consumo_ventas,     0) AS consumo_ventas,
        COALESCE(m.reversas_void,      0) AS reversas_void,
        COALESCE(m.merma_declarada,    0) AS merma_declarada,
        COALESCE(m.ajuste_manual,      0) AS ajuste_manual,
        COALESCE(m.ajuste_conteo,      0) AS ajuste_conteo,
        COALESCE(m.reabastecimiento,   0) AS reabastecimiento,
        COALESCE(m.eventos_no_venta,   0) AS eventos_no_venta,
        -- Shrinkage = declared waste + any NEGATIVE net adjustment. A positive
        -- net adjustment means stock was found, not lost, so it is not shrinkage.
        COALESCE(m.merma_declarada, 0)
            + GREATEST(-(COALESCE(m.ajuste_manual, 0) + COALESCE(m.ajuste_conteo, 0)), 0)
          AS merma_total_unidades
    FROM inventory_items ii
    LEFT JOIN mov m ON m.inventory_item_id = ii.id
    WHERE COALESCE(ii.is_active, TRUE)
)
SELECT
    id AS inventory_item_id,
    name AS insumo,
    category,
    unit,
    (round(consumo_ventas      - reversas_void, 2))::numeric(18,2) AS consumo_neto_28d,
    (round(merma_declarada,     2))::numeric(18,2)                 AS merma_declarada_28d,
    (round(ajuste_manual,       2))::numeric(18,2)                 AS ajuste_manual_28d,
    (round(ajuste_conteo,       2))::numeric(18,2)                 AS ajuste_conteo_28d,
    (round(reabastecimiento,    2))::numeric(18,2)                 AS reabastecimiento_28d,
    eventos_no_venta,
    (round(merma_total_unidades, 2))::numeric(18,2)                AS merma_total_unidades,
    (round(merma_total_unidades * unit_cost_cents::numeric / 100, 2))::numeric(18,2)
        AS merma_valorizada_mxn,
    CASE WHEN (consumo_ventas - reversas_void) > 0
         THEN (round(100.0 * merma_total_unidades
                     / NULLIF(consumo_ventas - reversas_void, 0), 2))::numeric(18,2)
         ELSE NULL
    END AS merma_pct_sobre_consumo,
    CASE
        WHEN unit_cost_cents = 0 AND merma_total_unidades > 0
            THEN 'Merma sin valorizar — falta costo unitario'
        WHEN merma_total_unidades = 0                       THEN 'Sin merma'
        WHEN (consumo_ventas - reversas_void) > 0
             AND merma_total_unidades
                 / NULLIF(consumo_ventas - reversas_void, 0) > 0.10
            THEN 'Merma alta — investigar'
        WHEN merma_total_unidades > 0                       THEN 'Merma normal'
        ELSE 'Sin datos'
    END AS diagnostico_merma
FROM calc
ORDER BY (merma_total_unidades * unit_cost_cents::numeric / 100) DESC,
         merma_total_unidades DESC
"""


# ─────────────────────────────────────────────────────────────────────────────
# 5. v_bola8_personal_desempeno — ticket × staff
#
#    opened_by / closed_by are TICKET actors, not per-line servers. Attribution
#    to whoever opened the ticket is a documented approximation, not ground truth.
#    No schedule or wage table exists, so labour COST % is not computable — this
#    measures output per server, not cost efficiency.
# ─────────────────────────────────────────────────────────────────────────────
V_PERSONAL_DESEMPENO = """
CREATE OR REPLACE VIEW public.v_bola8_personal_desempeno AS
WITH lineas AS (
    SELECT
        ticket_id,
        SUM(quantity)                                                     AS unidades,
        SUM(net_sales_cents)                                              AS net_cents,
        SUM(total_cost_cents)                                             AS costo_cents,
        SUM(gross_profit_cents)                                           AS utilidad_cents,
        SUM(CASE WHEN total_cost_cents > 0 THEN net_sales_cents ELSE 0 END) AS net_con_costo_cents,
        COUNT(*)                                                          AS lineas
    FROM v_bola8_lineas_venta
    GROUP BY ticket_id
)
SELECT
    v.ticket_id,
    v.fecha_mx,
    v.hora_mx,
    v.dia_semana_iso,
    v.ticket_type,
    v.resource_name,
    v.resource_type,
    t.opened_by,
    uo.name                                  AS abrio,
    uo.role                                  AS rol_abrio,
    t.closed_by,
    uc.name                                  AS cerro,
    uc.role                                  AS rol_cerro,
    COALESCE(ur.name, NULL)                  AS reabrio,
    COALESCE(t.was_reopened, FALSE)          AS fue_reabierto,
    v.edited_after_close,
    v.manual_discount_pct,
    COALESCE(l.lineas, 0)                    AS lineas,
    COALESCE(l.unidades, 0)                  AS unidades,
    (round(v.total_cents::numeric          / 100, 2))::numeric(18,2) AS total_mxn,
    (round(v.pool_time_cents::numeric      / 100, 2))::numeric(18,2) AS billar_mxn,
    (round(v.tip_cents::numeric            / 100, 2))::numeric(18,2) AS propina_mxn,
    (round(v.discount_cents::numeric       / 100, 2))::numeric(18,2) AS descuento_mxn,
    (round(COALESCE(l.net_cents, 0)::numeric      / 100, 2))::numeric(18,2) AS venta_articulos_mxn,
    (round(COALESCE(l.costo_cents, 0)::numeric    / 100, 2))::numeric(18,2) AS costo_mxn,
    (round(COALESCE(l.utilidad_cents, 0)::numeric / 100, 2))::numeric(18,2) AS utilidad_mxn,
    -- Share of this ticket's item revenue that has a real cost behind it.
    CASE WHEN COALESCE(l.net_cents, 0) > 0
         THEN (round(100.0 * COALESCE(l.net_con_costo_cents, 0)
                     / NULLIF(l.net_cents, 0), 2))::numeric(18,2)
         ELSE NULL
    END AS cobertura_costo_pct,
    CASE WHEN v.tip_cents > 0 AND v.total_cents > 0
         THEN (round(100.0 * v.tip_cents / NULLIF(v.total_cents, 0), 2))::numeric(18,2)
         ELSE 0.00::numeric(18,2)
    END AS propina_pct,
    (round(EXTRACT(epoch FROM (v.closed_at - v.opened_at))::numeric / 60, 2))::numeric(18,2)
        AS duracion_min
FROM v_bola8_tickets_cerrados v
JOIN tickets t   ON t.id = v.ticket_id
LEFT JOIN users uo ON uo.id = t.opened_by
LEFT JOIN users uc ON uc.id = t.closed_by
LEFT JOIN users ur ON ur.id = t.reopened_by
LEFT JOIN lineas l ON l.ticket_id = v.ticket_id
"""


# ─────────────────────────────────────────────────────────────────────────────
# 6. v_bola8_anomalias_operativas — the deliberate inverse of the revenue views
#
#    v_bola8_lineas_venta excludes voided lines by design (correct for revenue,
#    blind for risk). This surfaces exactly what the revenue views drop, plus
#    reopens, manual discounts and post-close edits, each with an actor.
# ─────────────────────────────────────────────────────────────────────────────
V_ANOMALIAS_OPERATIVAS = f"""
CREATE OR REPLACE VIEW public.v_bola8_anomalias_operativas AS
-- Voided line items (invisible to every revenue view)
SELECT
    'VOID_LINEA'::text                                              AS tipo,
    li.id                                                           AS referencia_id,
    t.id                                                            AS ticket_id,
    (COALESCE(li.voided_at, t.closed_at) AT TIME ZONE '{TZ}')::date AS fecha_mx,
    li.voided_at                                                    AS ocurrido_en,
    COALESCE(li.item_name, mi.name)                                 AS detalle,
    li.void_reason                                                  AS motivo,
    u.name                                                          AS usuario,
    u.role                                                          AS rol_usuario,
    (round((li.quantity * li.unit_price_cents)::numeric / 100, 2))::numeric(18,2) AS monto_mxn
FROM ticket_line_items li
JOIN tickets t     ON t.id = li.ticket_id
LEFT JOIN menu_items mi ON mi.id = li.menu_item_id
LEFT JOIN users u  ON u.id = li.voided_by
WHERE li.voided_at IS NOT NULL
   OR COALESCE(li.status, '') = 'VOIDED'

UNION ALL

-- Tickets reopened after close
SELECT
    'TICKET_REABIERTO'::text,
    t.id,
    t.id,
    (COALESCE(t.reopened_at, t.closed_at) AT TIME ZONE '{TZ}')::date,
    t.reopened_at,
    'Ticket reabierto tras cierre'::varchar,
    t.notes,
    u.name,
    u.role,
    (round(COALESCE(t.total_cents, 0)::numeric / 100, 2))::numeric(18,2)
FROM tickets t
LEFT JOIN users u ON u.id = t.reopened_by
WHERE COALESCE(t.was_reopened, FALSE) = TRUE

UNION ALL

-- Manual percentage discounts
SELECT
    'DESCUENTO_MANUAL'::text,
    t.id,
    t.id,
    (t.closed_at AT TIME ZONE '{TZ}')::date,
    t.closed_at,
    ('Descuento manual ' || COALESCE(t.manual_discount_pct, 0)::text || '%')::varchar,
    t.notes,
    u.name,
    u.role,
    (round(COALESCE(t.discount_cents, 0)::numeric / 100, 2))::numeric(18,2)
FROM tickets t
LEFT JOIN users u ON u.id = t.closed_by
WHERE COALESCE(t.manual_discount_pct, 0) > 0
  AND t.status = 'CLOSED'
  AND t.closed_at IS NOT NULL

UNION ALL

-- Edited after close
SELECT
    'EDITADO_POST_CIERRE'::text,
    t.id,
    t.id,
    (t.closed_at AT TIME ZONE '{TZ}')::date,
    t.closed_at,
    'Ticket editado después del cierre'::varchar,
    t.notes,
    u.name,
    u.role,
    (round(COALESCE(t.total_cents, 0)::numeric / 100, 2))::numeric(18,2)
FROM tickets t
LEFT JOIN users u ON u.id = t.closed_by
WHERE COALESCE(t.edited_after_close, FALSE) = TRUE
  AND t.status = 'CLOSED'
  AND t.closed_at IS NOT NULL
"""


# ─────────────────────────────────────────────────────────────────────────────
# 7. v_bola8_promo_redenciones — promotion applications
#
#    NOTE: line_item_promotions is EMPTY in dev (0 rows). This view is
#    instrumentation — it will report nothing until promos accumulate history.
#
#    Promo discounts write here and NOT to tickets.discount_cents, so
#    allocated_discount_cents in v_bola8_lineas_venta EXCLUDES them. Promo-
#    discounted lines therefore overstate net sales and profit, and the error
#    grows with promo adoption. This view makes the gap measurable.
# ─────────────────────────────────────────────────────────────────────────────
V_PROMO_REDENCIONES = f"""
CREATE OR REPLACE VIEW public.v_bola8_promo_redenciones AS
SELECT
    lip.id                                                       AS redencion_id,
    lip.ticket_id,
    lip.line_item_id,
    lip.promotion_id,
    p.name                                                       AS promocion,
    p.promo_type,
    p.discount_type,
    lip.applied_at,
    (lip.applied_at AT TIME ZONE '{TZ}')::date                   AS fecha_mx,
    (EXTRACT(hour FROM (lip.applied_at AT TIME ZONE '{TZ}')))::integer AS hora_mx,
    l.producto,
    l.categoria,
    l.quantity,
    lip.discount_cents,
    (round(lip.discount_cents::numeric / 100, 2))::numeric(18,2) AS descuento_mxn,
    (round(COALESCE(l.net_sales_cents, 0)::numeric / 100, 2))::numeric(18,2) AS venta_linea_mxn,
    (round(COALESCE(l.gross_profit_cents, 0)::numeric / 100, 2))::numeric(18,2) AS utilidad_linea_mxn,
    -- Profit after the promo discount is charged against the line
    (round((COALESCE(l.gross_profit_cents, 0) - lip.discount_cents)::numeric / 100, 2))::numeric(18,2)
        AS utilidad_neta_promo_mxn,
    d.decision,
    d.decided_at,
    ud.name AS decidio_por
FROM line_item_promotions lip
LEFT JOIN promotions p            ON p.id = lip.promotion_id
LEFT JOIN v_bola8_lineas_venta l  ON l.line_item_id = lip.line_item_id
LEFT JOIN ticket_promo_decisions d
       ON d.ticket_id = lip.ticket_id AND d.promotion_id = lip.promotion_id
LEFT JOIN users ud                ON ud.id = d.decided_by
"""


# ─────────────────────────────────────────────────────────────────────────────
# 8. v_bola8_costos_fijos — monthly fixed operating costs
#
#    Seeded by STEP 25 and editable from Analítica → Rentabilidad. These are the
#    costs that exist whether or not a ticket is sold, so they are what turns
#    GROSS profit into NET profit.
#
#    30.4167 = 365 / 12, the average month length. Fixed costs accrue every
#    CALENDAR day, including days the bar is closed — allocating them only across
#    trading days would understate the daily nut.
# ─────────────────────────────────────────────────────────────────────────────
V_COSTOS_FIJOS = """
CREATE OR REPLACE VIEW public.v_bola8_costos_fijos AS
SELECT
    id,
    concepto,
    COALESCE(categoria, 'OTROS')                                   AS categoria,
    monto_cents,
    (round(monto_cents::numeric / 100, 2))::numeric(18,2)          AS monto_mensual_mxn,
    (round(monto_cents::numeric / 100 / 30.4167, 2))::numeric(18,2) AS monto_diario_mxn,
    (round(monto_cents::numeric / 100 * 12, 2))::numeric(18,2)     AS monto_anual_mxn,
    is_active,
    notas,
    updated_at
FROM fixed_costs
WHERE COALESCE(is_active, TRUE)
ORDER BY monto_cents DESC
"""


# ─────────────────────────────────────────────────────────────────────────────
# 9. v_bola8_billar_por_mesa — pool-time earnings, table × day
#
#    Built on pool_timer_sessions (real metered seconds) rather than the ticket's
#    pool_time_cents, so utilisation is measurable and not just revenue.
#    Reconciles to within $13.20 of v_bola8_tickets_cerrados.pool_time_cents over
#    90 days (one still-ACTIVE session).
#
#    Cancelled sessions are excluded — all 25 carry charge_cents = 0 anyway, but
#    counting them would deflate revenue-per-session.
#
#    Pool time consumes NO inventory, so every peso here is contribution margin.
#    That is the point of the report: it is the cleanest revenue in the business.
# ─────────────────────────────────────────────────────────────────────────────
V_BILLAR_POR_MESA = f"""
CREATE OR REPLACE VIEW public.v_bola8_billar_por_mesa AS
SELECT
    pts.resource_id,
    r.code                                                        AS mesa_codigo,
    r.name                                                        AS mesa_nombre,
    (t.closed_at AT TIME ZONE '{TZ}')::date                       AS fecha_mx,
    (EXTRACT(isodow FROM (t.closed_at AT TIME ZONE '{TZ}')))::integer AS dia_semana_iso,
    COUNT(*)                                                      AS sesiones,
    COUNT(DISTINCT pts.ticket_id)                                 AS tickets,
    SUM(COALESCE(pts.duration_seconds, 0))                        AS segundos,
    (round(SUM(COALESCE(pts.duration_seconds, 0))::numeric / 3600, 2))::numeric(18,2)
                                                                  AS horas,
    (round(SUM(COALESCE(pts.promo_free_seconds, 0))::numeric / 60, 2))::numeric(18,2)
                                                                  AS minutos_gratis_promo,
    SUM(COALESCE(pts.charge_cents, 0))                            AS ingreso_cents,
    (round(SUM(COALESCE(pts.charge_cents, 0))::numeric / 100, 2))::numeric(18,2)
                                                                  AS ingreso_mxn,
    -- Revenue per metered hour: the comparable rate across tables.
    CASE WHEN SUM(COALESCE(pts.duration_seconds, 0)) > 0
         THEN (round(SUM(COALESCE(pts.charge_cents, 0))::numeric / 100
                     / (SUM(COALESCE(pts.duration_seconds, 0))::numeric / 3600), 2))::numeric(18,2)
         ELSE NULL
    END                                                           AS ingreso_por_hora_mxn,
    COUNT(*) FILTER (WHERE pts.is_manual_edit)                    AS sesiones_editadas
FROM pool_timer_sessions pts
JOIN resources r ON r.id = pts.resource_id
JOIN tickets   t ON t.id = pts.ticket_id
WHERE t.status = 'CLOSED'
  AND t.closed_at IS NOT NULL
  AND pts.cancelled_at IS NULL
  AND COALESCE(pts.status, '') <> 'CANCELLED'
GROUP BY pts.resource_id, r.code, r.name,
         (t.closed_at AT TIME ZONE '{TZ}')::date,
         (EXTRACT(isodow FROM (t.closed_at AT TIME ZONE '{TZ}')))::integer
"""


# ─────────────────────────────────────────────────────────────────────────────
# 10. v_bola8_rentabilidad_diaria — gross profit minus the daily fixed-cost nut
#
#     The first view in the platform that reports NET profit. Structure:
#
#         utilidad_bruta = utilidad_articulos + billar   (billar has no COGS)
#         utilidad_neta  = utilidad_bruta - costo_fijo_diario
#
#     costo_fijo_diario is the whole monthly fixed cost / 30.4167, charged on every
#     day the bar traded. Closed days still accrue fixed cost in reality; the
#     period endpoint accounts for that by charging the full CALENDAR span, so
#     this daily view is for shape, and /analytics/profitability for the true total.
#
#     cobertura_costo_pct rides along because utilidad_articulos is inflated while
#     inventory unit costs are missing — net profit inherits that error directly,
#     and at these fixed-cost levels the error decides profit vs loss.
# ─────────────────────────────────────────────────────────────────────────────
V_RENTABILIDAD_DIARIA = """
CREATE OR REPLACE VIEW public.v_bola8_rentabilidad_diaria AS
WITH fijo AS (
    SELECT COALESCE(SUM(monto_cents), 0)::numeric AS mensual_cents
    FROM fixed_costs WHERE COALESCE(is_active, TRUE)
),
tick AS (
    SELECT fecha_mx,
           COUNT(*)               AS tickets,
           SUM(total_cents)       AS ventas_cents,
           SUM(pool_time_cents)   AS billar_cents,
           SUM(tip_cents)         AS propinas_cents,
           SUM(discount_cents)    AS descuentos_cents
    FROM v_bola8_tickets_cerrados
    GROUP BY fecha_mx
),
lin AS (
    SELECT fecha_mx,
           SUM(net_sales_cents)    AS articulos_cents,
           SUM(total_cost_cents)   AS cogs_cents,
           SUM(gross_profit_cents) AS utilidad_art_cents,
           SUM(CASE WHEN total_cost_cents > 0 THEN net_sales_cents ELSE 0 END)
                                   AS art_con_costo_cents
    FROM v_bola8_lineas_venta
    GROUP BY fecha_mx
)
SELECT
    t.fecha_mx,
    t.tickets,
    (round(t.ventas_cents::numeric      / 100, 2))::numeric(18,2) AS ventas_mxn,
    (round(t.billar_cents::numeric      / 100, 2))::numeric(18,2) AS billar_mxn,
    (round(t.propinas_cents::numeric    / 100, 2))::numeric(18,2) AS propinas_mxn,
    (round(t.descuentos_cents::numeric  / 100, 2))::numeric(18,2) AS descuentos_mxn,
    (round(COALESCE(l.articulos_cents, 0)::numeric   / 100, 2))::numeric(18,2) AS articulos_mxn,
    (round(COALESCE(l.cogs_cents, 0)::numeric        / 100, 2))::numeric(18,2) AS cogs_mxn,
    (round(COALESCE(l.utilidad_art_cents, 0)::numeric / 100, 2))::numeric(18,2)
        AS utilidad_articulos_mxn,
    -- Billiard time carries no ingredient cost, so it is pure contribution.
    (round((COALESCE(l.utilidad_art_cents, 0) + t.billar_cents)::numeric / 100, 2))::numeric(18,2)
        AS utilidad_bruta_mxn,
    (round(f.mensual_cents / 100 / 30.4167, 2))::numeric(18,2) AS costo_fijo_diario_mxn,
    (round(((COALESCE(l.utilidad_art_cents, 0) + t.billar_cents)::numeric
            - f.mensual_cents / 30.4167) / 100, 2))::numeric(18,2)
        AS utilidad_neta_mxn,
    -- Revenue needed that day just to cover the fixed nut, at the day's own margin.
    CASE WHEN (COALESCE(l.utilidad_art_cents, 0) + t.billar_cents) > 0
         THEN (round((f.mensual_cents / 30.4167)
                     / (COALESCE(l.utilidad_art_cents, 0) + t.billar_cents)::numeric
                     * t.ventas_cents / 100, 2))::numeric(18,2)
         ELSE NULL
    END AS punto_equilibrio_ventas_mxn,
    CASE WHEN COALESCE(l.articulos_cents, 0) > 0
         THEN (round(100.0 * COALESCE(l.art_con_costo_cents, 0)
                     / NULLIF(l.articulos_cents, 0), 2))::numeric(18,2)
         ELSE NULL
    END AS cobertura_costo_pct
FROM tick t
LEFT JOIN lin l ON l.fecha_mx = t.fecha_mx
CROSS JOIN fijo f
"""


ANALYTICS_VIEWS = [
    ("v_bola8_costos_fijos",        V_COSTOS_FIJOS),
    ("v_bola8_billar_por_mesa",     V_BILLAR_POR_MESA),
    ("v_bola8_rentabilidad_diaria", V_RENTABILIDAD_DIARIA),
    ("v_bola8_pagos_desglosados",   V_PAGOS_DESGLOSADOS),
    ("v_bola8_flujo_caja",          V_FLUJO_CAJA),
    ("v_bola8_cobertura_costo",     V_COBERTURA_COSTO),
    ("v_bola8_varianza_inventario", V_VARIANZA_INVENTARIO),
    ("v_bola8_personal_desempeno",  V_PERSONAL_DESEMPENO),
    ("v_bola8_anomalias_operativas", V_ANOMALIAS_OPERATIVAS),
    ("v_bola8_promo_redenciones",   V_PROMO_REDENCIONES),
]


# Indexes matched to the new views' actual access paths.
#
# The dataset is small today (1,102 closed tickets / 5,870 lines / 90 days), so
# these are pre-emptive rather than curative. They are deliberately few: unused
# indexes cost write throughput on a POS whose hot path is order entry at peak.
#
# Already created by STEP 11d / STEP 17 — do NOT duplicate:
#   idx_tickets_status, idx_tli_ticket_status, idx_sale_item_costs_line_item,
#   idx_sale_item_costs_inventory_item, idx_inventory_movements_item_created,
#   idx_inventory_movements_event_type
#
# init-db runs inside a transaction, so plain IF NOT EXISTS is used here. To add
# them on a live production database without locking writes, run the same
# statements manually with CONCURRENTLY:
#   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_closed_at_closed
#       ON tickets (closed_at) WHERE status = 'CLOSED';
ANALYTICS_INDEXES = [
    ("tickets.closed_at (partial CLOSED) — every date-ranged dashboard",
     "CREATE INDEX IF NOT EXISTS idx_tickets_closed_at_closed "
     "ON tickets (closed_at) WHERE status = 'CLOSED'"),

    ("tickets.closed_by — personal_desempeno",
     "CREATE INDEX IF NOT EXISTS idx_tickets_closed_by ON tickets (closed_by)"),

    ("tickets.opened_by — personal_desempeno",
     "CREATE INDEX IF NOT EXISTS idx_tickets_opened_by ON tickets (opened_by)"),

    ("ticket_line_items.voided_at (partial) — anomalias_operativas",
     "CREATE INDEX IF NOT EXISTS idx_tli_voided_at "
     "ON ticket_line_items (voided_at) WHERE voided_at IS NOT NULL"),

    ("expenses.session_id — flujo_caja",
     "CREATE INDEX IF NOT EXISTS idx_expenses_session ON expenses (session_id)"),

    ("safe_collections.created_at — flujo_caja time-window attribution",
     "CREATE INDEX IF NOT EXISTS idx_safe_collections_created "
     "ON safe_collections (created_at)"),

    ("cash_sessions.opened_at — flujo_caja",
     "CREATE INDEX IF NOT EXISTS idx_cash_sessions_opened_at "
     "ON cash_sessions (opened_at)"),

    ("line_item_promotions.ticket_id — promo_redenciones",
     "CREATE INDEX IF NOT EXISTS idx_lip_ticket ON line_item_promotions (ticket_id)"),

    ("line_item_promotions.promotion_id — promo_redenciones",
     "CREATE INDEX IF NOT EXISTS idx_lip_promotion ON line_item_promotions (promotion_id)"),
]


def ensure_analytics_views(db):
    """Create/replace the analytics views and their supporting indexes.

    Idempotent. Skips with a warning if the two foundation views are absent —
    they are not defined in this repository, so a fresh database will not have
    them and init-db must not hard-fail because of it.
    """
    from sqlalchemy import text

    present = {
        r[0] for r in db.session.execute(text(
            "SELECT table_name FROM information_schema.views "
            "WHERE table_schema = 'public' AND table_name = ANY(:names)"
        ), {"names": list(REQUIRED_VIEWS)}).fetchall()
    }
    missing = [v for v in REQUIRED_VIEWS if v not in present]
    if missing:
        print(f"STEP 26: SKIPPED — foundation views missing: {', '.join(missing)}")
        print("         The original v_bola8_* views are not defined in this repo; "
              "restore them on this database first.")
        return False

    # CREATE OR REPLACE VIEW cannot add, remove or reorder columns — Postgres
    # rejects it with "cannot change name of view column". Since these views are
    # ours and evolve, drop them all first (reverse dependency order) and rebuild.
    # DDL is transactional in Postgres, so a failure rolls the whole set back and
    # never leaves the analytics layer half-dropped.
    for name, _ in reversed(ANALYTICS_VIEWS):
        db.session.execute(text(f"DROP VIEW IF EXISTS public.{name} CASCADE"))

    for name, ddl in ANALYTICS_VIEWS:
        try:
            db.session.execute(text(ddl))
            print(f"STEP 26: view {name} ready")
        except Exception as exc:                       # noqa: BLE001
            db.session.rollback()
            print(f"STEP 26: view {name} FAILED — {exc}")
            raise

    for label, ddl in ANALYTICS_INDEXES:
        try:
            db.session.execute(text(ddl))
        except Exception as exc:                       # noqa: BLE001
            # An index failure must not take down init-db.
            print(f"STEP 26: index skipped ({label}) — {exc}")

    db.session.commit()
    print(f"STEP 26: analytics layer ready "
          f"({len(ANALYTICS_VIEWS)} views, {len(ANALYTICS_INDEXES)} indexes)")
    return True

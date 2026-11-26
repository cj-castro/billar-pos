"""
Analytics layer — new derived views (STEP 26 of `flask init-db`).

These extend the thirteen pre-existing `v_bola8_*` views. **The originals are never
modified.** Everything here is `CREATE OR REPLACE VIEW`, so re-running init-db is safe.

Design rules (see docs/analytics-blueprint.md):
  * Money aggregates in integer `_cents`, then divides by 100 and casts to
    NUMERIC(18,2) ONCE at the outermost projection. Rounding sub-aggregates and
    summing them produces cent drift.
  * Never FLOAT / DOUBLE PRECISION.
  * Every DATE / weekday goes through fn_bar_business_ts() (venue timezone minus the
    closing-hour cutoff, migration 046); hour-of-day uses AT TIME ZONE fn_bar_tz(). Before
    ::date. A UTC-based date pushes post-18:00 local revenue — most of a bar's
    night — onto the following day.
  * Views MAY read base tables (that is how the original thirteen work).
    Dashboard queries may not — they read only v_bola8_* views.

DEPENDENCY WARNING
    v_bola8_lineas_venta and v_bola8_tickets_cerrados are NOT defined anywhere in
    this repository — they exist only in the live database. `ensure_analytics_views`
    checks for them and skips with a warning rather than failing init-db.
"""

# The bar's timezone comes from settings via fn_bar_tz() (migration 045);
# never hard-code it here. (Kept for any external import of the old name.)
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
#    tip_cash_cents / tip_card_cents are used when present (SPLIT tips), exactly
#    as the POS does. Single-payment tickets also honour tip_source: a cash tip
#    on a card payment is reported under CASH, where the drawer sees it.
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
        t.tip_source,
        t.tip_cash_cents,
        t.tip_card_cents
    FROM v_bola8_tickets_cerrados v
    JOIN tickets t ON t.id = v.ticket_id
),
alloc AS (
    SELECT
        b.*,
        -- SINGLE-payment ticket: the cash part of the tip, by where it was
        -- actually collected (tip_source), exactly as cash_session._build_summary
        -- does. A card payment can carry a cash tip and vice versa.
        CASE
            WHEN b.tip_source = 'CASH'  THEN b.tip_cents
            WHEN b.tip_source = 'CARD'  THEN 0
            WHEN b.tip_source = 'SPLIT' THEN b.tip_cents / 2       -- integer floor, = Python //
            WHEN b.payment_type = 'CASH' THEN b.tip_cents
            ELSE 0
        END AS single_cash_tip,
        -- SPLIT ticket: tip on leg 2, same precedence as the POS.
        CASE
            WHEN b.payment_type_2 IS NULL                 THEN 0
            WHEN b.tip_source = b.payment_type_2          THEN b.tip_cents
            WHEN b.tip_source = b.payment_type            THEN 0
            WHEN b.tip_source = 'SPLIT' AND b.tip_cash_cents IS NOT NULL
                THEN b.tip_cents - CASE WHEN b.payment_type = 'CASH'
                                        THEN COALESCE(b.tip_cash_cents, 0)
                                        ELSE COALESCE(b.tip_card_cents, 0) END
            WHEN (b.tendered_1 + b.tendered_2) > 0
                THEN round(b.tip_cents::numeric * b.tendered_2
                           / (b.tendered_1 + b.tendered_2))
            ELSE 0
        END::integer AS split_leg2_tip
    FROM base b
),
alloc2 AS (
    SELECT a.*,
           -- Sales on leg 2 = its tendered amount minus its tip, clamped into range.
           -- If leg 2's amount was never recorded (payment_type_2 set but
           -- tendered_cents_2 empty -- it happens), trust leg 1 instead: the cash
           -- that was tendered is what reached the drawer, as the POS assumes.
           CASE WHEN a.tendered_2 > 0 OR a.tendered_1 = 0
                THEN LEAST(GREATEST(a.tendered_2 - a.split_leg2_tip, 0), a.total_cents)
                ELSE a.total_cents
                     - LEAST(GREATEST(a.tendered_1 - (a.tip_cents - a.split_leg2_tip), 0),
                             a.total_cents)
           END::integer AS split_leg2_sales
    FROM alloc a
),
per AS (
    -- One row per ticket describing both legs. For a single-payment ticket,
    -- leg 2 is "the part of the tip collected on the other side" (sales 0), so
    -- a cash tip on a card payment lands under CASH where the drawer sees it.
    SELECT
        ticket_id, closed_at, fecha_mx, hora_mx, dia_semana_iso, ticket_type, total_cents,
        (payment_type_2 IS NOT NULL) AS es_split,
        (payment_type_2 IS NOT NULL
         AND tip_cents > 0
         AND (tip_source IS NULL
              OR (tip_source NOT IN (payment_type, payment_type_2)
                  AND NOT (tip_source = 'SPLIT' AND tip_cash_cents IS NOT NULL)))) AS tip_estimado,
        payment_type AS m1,
        CASE WHEN payment_type_2 IS NULL THEN total_cents
             ELSE total_cents - split_leg2_sales END                         AS monto1,
        CASE WHEN payment_type_2 IS NULL
             THEN CASE WHEN payment_type = 'CASH' THEN single_cash_tip
                       ELSE tip_cents - single_cash_tip END
             ELSE tip_cents - split_leg2_tip END                             AS tip1,
        CASE WHEN payment_type_2 IS NULL
             THEN CASE WHEN payment_type = 'CASH' THEN 'CARD' ELSE 'CASH' END
             ELSE payment_type_2 END::varchar                                AS m2,
        CASE WHEN payment_type_2 IS NULL THEN 0 ELSE split_leg2_sales END    AS monto2,
        CASE WHEN payment_type_2 IS NULL
             THEN CASE WHEN payment_type = 'CASH' THEN tip_cents - single_cash_tip
                       ELSE single_cash_tip END
             ELSE split_leg2_tip END                                         AS tip2
    FROM alloc2
),
legs AS (
    -- Leg 1 always exists and absorbs whatever leg 2 did not take, so sales
    -- always sum to total_cents and tips to tip_cents.
    SELECT ticket_id, closed_at, fecha_mx, hora_mx, dia_semana_iso, ticket_type,
           total_cents, tip_estimado, 1 AS orden_pago, m1 AS metodo_pago,
           monto1::integer AS monto_cents, tip1::integer AS propina_cents, es_split
    FROM per
    UNION ALL
    SELECT ticket_id, closed_at, fecha_mx, hora_mx, dia_semana_iso, ticket_type,
           total_cents, tip_estimado, 2, m2, monto2::integer, tip2::integer, es_split
    FROM per
    WHERE monto2 > 0 OR tip2 > 0
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
#    MUST give the same answer as the POS close screen (cash_session._build_summary).
#    It used not to, and showed $35.8k of drawer "sobrantes" that never happened.
#    The rules, all copied from the POS:
#      * a ticket belongs to the session in which it was OPENED (not closed);
#      * only CASH expenses leave the drawer;
#      * safe pickups (safe_collections) are NOT part of tonight's expected cash.
#        They are logged after the count, or days later, and have no session id;
#        subtracting them by time window is what invented the overages. They are
#        still reported (retiros_caja_fuerte_mxn) for information.
#
#    TIP PAYOUT — house policy: ALL tips, card included, are paid to staff in cash
#    from the drawer at close, so
#        esperado = fondo + ventas_efectivo + propinas_efectivo - propinas_totales
#                   - gastos_efectivo
#    efectivo_esperado_sin_pago_propinas_mxn is kept for days when tips were NOT
#    paid out at close, which would otherwise read as a large surplus.
# ─────────────────────────────────────────────────────────────────────────────
V_FLUJO_CAJA = f"""
CREATE OR REPLACE VIEW public.v_bola8_flujo_caja AS
WITH sess AS (
    SELECT
        cs.id                                                    AS session_id,
        cs.date                                                  AS fecha_sesion,
        fn_bar_business_ts(cs.opened_at)::date                 AS fecha_mx,
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
    JOIN tickets t
      ON t.opened_at >= s.opened_at
     AND (s.closed_at IS NULL OR t.opened_at <= s.closed_at)
    JOIN v_bola8_pagos_desglosados p ON p.ticket_id = t.id
    GROUP BY s.session_id
),
gastos AS (
    SELECT session_id,
           SUM(COALESCE(amount_cents, 0))                                          AS gastos_cents,
           SUM(CASE WHEN payment_method = 'CASH' THEN COALESCE(amount_cents, 0) ELSE 0 END)
                                                                                   AS gastos_efectivo_cents,
           COUNT(*)                                                                AS num_gastos
    FROM expenses
    GROUP BY session_id
),
retiros AS (
    -- Informational only (see header): never subtracted from expected cash.
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
        COALESCE(g.gastos_efectivo_cents, 0)   AS gastos_efectivo_cents,
        COALESCE(g.num_gastos, 0)              AS num_gastos,
        COALESCE(r.retiros_cents, 0)           AS retiros_cents,
        COALESCE(r.num_retiros, 0)             AS num_retiros
    FROM sess s
    LEFT JOIN ventas  v ON v.session_id = s.session_id
    LEFT JOIN gastos  g ON g.session_id = s.session_id
    LEFT JOIN retiros r ON r.session_id = s.session_id
),
expected AS (
    SELECT c.*,
           (fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
            - propinas_totales_cents - gastos_efectivo_cents)            AS esperado_cents,
           (fondo_inicial_cents + efectivo_ventas_cents + propinas_efectivo_cents
            - gastos_efectivo_cents)                                     AS esperado_sin_propinas_cents
    FROM calc c
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
    (round(gastos_efectivo_cents::numeric    / 100, 2))::numeric(18,2) AS gastos_efectivo_mxn,
    (round(retiros_cents::numeric            / 100, 2))::numeric(18,2) AS retiros_caja_fuerte_mxn,
    (round(esperado_cents::numeric           / 100, 2))::numeric(18,2) AS efectivo_esperado_mxn,
    (round(esperado_sin_propinas_cents::numeric / 100, 2))::numeric(18,2)
        AS efectivo_esperado_sin_pago_propinas_mxn,
    CASE WHEN closing_cash_counted_cents IS NULL THEN NULL
         ELSE (round(closing_cash_counted_cents::numeric / 100, 2))::numeric(18,2)
    END AS efectivo_contado_mxn,
    -- Positive = drawer over, negative = drawer short (same sign as the POS)
    CASE WHEN closing_cash_counted_cents IS NULL THEN NULL
         ELSE (round((closing_cash_counted_cents - esperado_cents)::numeric / 100, 2))::numeric(18,2)
    END AS diferencia_mxn,
    -- Tolerance is the greater of $50 or 2% of expected cash; 'Faltante grave'
    -- needs >= $500 or >= 10%.
    CASE
        WHEN closing_cash_counted_cents IS NULL THEN 'Sesión abierta'
        WHEN abs(closing_cash_counted_cents - esperado_cents)
             <= GREATEST(5000, esperado_cents * 2 / 100)               THEN 'OK'
        WHEN closing_cash_counted_cents < esperado_cents THEN
            CASE WHEN (esperado_cents - closing_cash_counted_cents)
                      >= GREATEST(50000, esperado_cents * 10 / 100)    THEN 'Faltante grave'
                 ELSE 'Faltante' END
        ELSE 'Sobrante'
    END AS diagnostico_caja
FROM expected
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
    END AS prioridad,
    -- How the item is BOUGHT, so the cost can be typed as "price per case"
    -- and divided by the system (batch C0).
    ii.base_unit_key,
    COALESCE(bu.name_es, ii.base_unit_key)  AS unidad_base,
    ii.purchase_unit_key,
    pu.name_es                              AS unidad_compra,
    COALESCE(ii.purchase_pack_size, 1)      AS unidades_por_compra,
    ii.purchase_cost_cents                  AS ultimo_precio_compra_cents,
    -- A counted item (bottle, can, piece) costing under $1 each is almost
    -- always a case price typed as a unit price, or pesos typed as centavos.
    CASE
        WHEN COALESCE(ii.unit_cost_cents, 0) > 0
         AND ii.unit_cost_cents < 100
         AND NOT COALESCE(bu.allows_fraction, false)
            THEN 'Menos de $1 por ' || lower(COALESCE(bu.name_es, ii.base_unit_key))
                 || ': ¿se capturó mal (precio de caja o en centavos)?'
    END AS revisar_motivo
FROM inventory_items ii
LEFT JOIN rev r ON r.inventory_item_id = ii.id
LEFT JOIN unit_catalog bu ON bu.key = ii.base_unit_key
LEFT JOIN unit_catalog pu ON pu.key = ii.purchase_unit_key
WHERE COALESCE(ii.is_active, TRUE)
ORDER BY (COALESCE(ii.unit_cost_cents, 0) > 0),
         COALESCE(r.ventas_expuestas_cents, 0) DESC
"""


# ─────────────────────────────────────────────────────────────────────────────
# 4. v_bola8_varianza_inventario — shrinkage / waste, 28-day window
#
#    Matches the 28-day window used by v_purchase_forecast so the two read
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
        COALESCE(SUM(net_sales_cents)  FILTER (WHERE NOT exenta_costo), 0)          AS eval_cents,
        COALESCE(SUM(net_sales_cents)  FILTER (WHERE exenta_costo), 0)              AS exento_cents,
        COALESCE(SUM(net_sales_cents)  FILTER (WHERE costo_estado = 'COMPLETO'), 0) AS net_con_costo_cents,
        COALESCE(SUM(total_cost_cents) FILTER (WHERE costo_estado = 'COMPLETO'), 0) AS costo_con_costo_cents,
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
    -- Share of this ticket's evaluable item revenue whose every ingredient has a cost.
    CASE WHEN COALESCE(l.eval_cents, 0) > 0
         THEN (round(100.0 * COALESCE(l.net_con_costo_cents, 0)
                     / NULLIF(l.eval_cents, 0), 2))::numeric(18,2)
         ELSE NULL
    END AS cobertura_costo_pct,
    -- Raw cents so callers can aggregate coverage over many tickets correctly
    -- (an average of per-ticket percentages would weight a $20 ticket like a $2,000 one).
    COALESCE(l.eval_cents, 0)             AS articulos_evaluables_cents,
    COALESCE(l.exento_cents, 0)           AS articulos_exentos_cents,
    COALESCE(l.net_con_costo_cents, 0)    AS articulos_con_costo_cents,
    COALESCE(l.costo_con_costo_cents, 0)  AS costo_articulos_con_costo_cents,
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
    fn_bar_business_ts(COALESCE(li.voided_at, t.closed_at))::date AS fecha_mx,
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
    fn_bar_business_ts(COALESCE(t.reopened_at, t.closed_at))::date,
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
    fn_bar_business_ts(t.closed_at)::date,
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
    fn_bar_business_ts(t.closed_at)::date,
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

UNION ALL

-- Cancelled tickets that still carried served items or charged pool time.
-- Cancelling a tab after serving it is the classic way to pocket a payment, and
-- a CANCELLED ticket is invisible to every revenue view. (The cancel endpoint now
-- refuses tickets with active items, but history and future paths must show.)
SELECT
    'TICKET_CANCELADO'::text,
    t.id,
    t.id,
    fn_bar_business_ts(COALESCE(t.closed_at, t.opened_at))::date,
    t.closed_at,
    ('Ticket cancelado con ' || COALESCE(li.n, 0)::text || ' artículo(s) y '
       || COALESCE(ps.n, 0)::text || ' sesión(es) de billar')::varchar,
    t.notes,
    u.name,
    u.role,
    (round((COALESCE(li.cents, 0) + COALESCE(ps.cents, 0))::numeric / 100, 2))::numeric(18,2)
FROM tickets t
LEFT JOIN users u ON u.id = t.closed_by
LEFT JOIN (SELECT ticket_id, COUNT(*) AS n, SUM(quantity * unit_price_cents) AS cents
             FROM ticket_line_items
            WHERE COALESCE(status, '') <> 'VOIDED'
            GROUP BY ticket_id) li ON li.ticket_id = t.id
LEFT JOIN (SELECT ticket_id, COUNT(*) AS n, SUM(COALESCE(charge_cents, 0)) AS cents
             FROM pool_timer_sessions
            WHERE COALESCE(status, '') <> 'CANCELLED' AND COALESCE(charge_cents, 0) > 0
            GROUP BY ticket_id) ps ON ps.ticket_id = t.id
WHERE t.status = 'CANCELLED'
  AND (COALESCE(li.n, 0) > 0 OR COALESCE(ps.n, 0) > 0)

UNION ALL

-- Force-closed tickets: a manager closed a "stuck" ticket without taking a
-- payment. The ticket is recorded as CASH, so it also inflates expected cash.
SELECT
    'CIERRE_FORZADO'::text,
    t.id,
    t.id,
    fn_bar_business_ts(a.created_at)::date,
    a.created_at,
    'Ticket cerrado a la fuerza (sin cobro registrado)'::varchar,
    COALESCE(a.after_state::jsonb ->> 'reason', t.notes),
    u.name,
    u.role,
    (round(COALESCE(t.total_cents, 0)::numeric / 100, 2))::numeric(18,2)
FROM audit_log a
JOIN tickets t    ON t.id = a.entity_id
LEFT JOIN users u ON u.id = a.user_id
WHERE a.action = 'TICKET_FORCE_CLOSE'
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
    fn_bar_business_ts(lip.applied_at)::date                   AS fecha_mx,
    (EXTRACT(hour FROM (lip.applied_at AT TIME ZONE fn_bar_tz())))::integer AS hora_mx,
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
    fn_bar_business_ts(t.closed_at)::date                       AS fecha_mx,
    (EXTRACT(isodow FROM fn_bar_business_ts(t.closed_at)))::integer AS dia_semana_iso,
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
         fn_bar_business_ts(t.closed_at)::date,
         (EXTRACT(isodow FROM fn_bar_business_ts(t.closed_at)))::integer
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
           SUM(net_sales_cents)                                           AS articulos_cents,
           SUM(total_cost_cents)                                          AS cogs_cents,
           COALESCE(SUM(net_sales_cents)  FILTER (WHERE NOT exenta_costo), 0)            AS eval_cents,
           COALESCE(SUM(net_sales_cents)  FILTER (WHERE exenta_costo), 0)                AS exento_cents,
           COALESCE(SUM(net_sales_cents)  FILTER (WHERE costo_estado = 'COMPLETO'), 0)   AS cov_cents,
           COALESCE(SUM(total_cost_cents) FILTER (WHERE costo_estado = 'COMPLETO'), 0)   AS cov_cost_cents
    FROM v_bola8_lineas_venta
    GROUP BY fecha_mx
),
-- HONEST MARGIN (batch B). Item profit is the margin measured on lines whose
-- every ingredient has a cost, applied to all evaluable item sales, plus exempt
-- categories at 100%. It is reported ONLY when at least 80% of evaluable item
-- sales are fully costed (same threshold as analytics.MARGIN_RELIABLE_PCT);
-- below that the day's profit is NULL rather than a 100%-margin fiction.
lin2 AS (
    SELECT l.*,
           CASE WHEN l.eval_cents > 0 THEN 100.0 * l.cov_cents / l.eval_cents END AS cobertura,
           CASE
               WHEN l.eval_cents = 0 THEN l.exento_cents
               WHEN l.cov_cents > 0 AND 100.0 * l.cov_cents / l.eval_cents >= 80
                   THEN round(l.eval_cents::numeric * (l.cov_cents - l.cov_cost_cents) / l.cov_cents)
                        + l.exento_cents
           END AS utilidad_art_cents
    FROM lin l
),
-- Product given away (batch E5): its own cost lines, not hidden in margins.
regalo AS (
    SELECT fecha AS fecha_mx,
           SUM(costo_cents) FILTER (WHERE tipo = 'CORTESIA') AS cortesias_cents,
           SUM(costo_cents) FILTER (WHERE tipo = 'PERSONAL') AS personal_cents
      FROM v_consumo_sin_venta GROUP BY fecha
),
day AS (
    SELECT t.*, l.articulos_cents, l.cogs_cents, l.cobertura,
           COALESCE(r.cortesias_cents, 0) AS cortesias_cents,
           COALESCE(r.personal_cents, 0)  AS personal_cents,
           -- a day with no item lines at all has item profit 0, not unknown
           CASE WHEN l.fecha_mx IS NULL THEN 0 ELSE l.utilidad_art_cents END AS utilidad_art_cents
    FROM tick t
    LEFT JOIN lin2 l ON l.fecha_mx = t.fecha_mx
    LEFT JOIN regalo r ON r.fecha_mx = t.fecha_mx
)
SELECT
    t.fecha_mx,
    t.tickets,
    (round(t.ventas_cents::numeric      / 100, 2))::numeric(18,2) AS ventas_mxn,
    (round(t.billar_cents::numeric      / 100, 2))::numeric(18,2) AS billar_mxn,
    (round(t.propinas_cents::numeric    / 100, 2))::numeric(18,2) AS propinas_mxn,
    (round(t.descuentos_cents::numeric  / 100, 2))::numeric(18,2) AS descuentos_mxn,
    (round(COALESCE(t.articulos_cents, 0)::numeric   / 100, 2))::numeric(18,2) AS articulos_mxn,
    (round(COALESCE(t.cogs_cents, 0)::numeric        / 100, 2))::numeric(18,2) AS cogs_mxn,
    -- NULL = not enough cost data that day to state a profit.
    (round(t.utilidad_art_cents::numeric / 100, 2))::numeric(18,2) AS utilidad_articulos_mxn,
    -- Billiard time carries no ingredient cost, so it is pure contribution.
    (round((t.utilidad_art_cents + t.billar_cents)::numeric / 100, 2))::numeric(18,2)
        AS utilidad_bruta_mxn,
    (round(f.mensual_cents / 100 / 30.4167, 2))::numeric(18,2) AS costo_fijo_diario_mxn,
    (round(((t.utilidad_art_cents + t.billar_cents)::numeric
            - t.cortesias_cents - t.personal_cents
            - f.mensual_cents / 30.4167) / 100, 2))::numeric(18,2)
        AS utilidad_neta_mxn,
    -- Revenue needed that day just to cover the fixed nut, at the day's own margin.
    CASE WHEN (t.utilidad_art_cents + t.billar_cents) > 0
         THEN (round((f.mensual_cents / 30.4167)
                     / (t.utilidad_art_cents + t.billar_cents)::numeric
                     * t.ventas_cents / 100, 2))::numeric(18,2)
         ELSE NULL
    END AS punto_equilibrio_ventas_mxn,
    (round(t.cobertura, 2))::numeric(18,2) AS cobertura_costo_pct,
    (round(t.cortesias_cents::numeric / 100, 2))::numeric(18,2) AS cortesias_mxn,
    (round(t.personal_cents::numeric / 100, 2))::numeric(18,2)  AS consumo_personal_mxn
FROM day t
CROSS JOIN fijo f
"""



# ─────────────────────────────────────────────────────────────────────────────
# v_purchase_forecast — what to buy for next week (batch E3)
#
#    Based on what SOLD: net sales usage (sales - voids returned) plus declared
#    waste over the 28 days up to the last closed sale, from the ledger -- i.e. product sales through their
#    recipes. Shots / loose cigarettes are rolled up into the bottle / box you
#    actually buy (ml / ratio), packs into their raw item (packs x weight ->
#    kg, E8), and their stock counts as available.
#    Opening a bottle (CONVERSION_OUT) is an internal move, never "usage".
#
#    pronostico_semana  4-week weekly average; if the last 7 days ran higher,
#                       the average of the two (leans toward a rising trend)
#    objetivo           pronostico x (1 + purchasing.safety_pct%, default 20),
#                       never below the item's minimum
#    comprar_unidades   what is missing, rounded UP to whole cases when the
#                       item has a case size (purchase_pack_size > 1)
#    costo_estimado     at the item's unit cost; NULL when the cost is unknown
#    estado             URGENTE (runs out within 7 days) / COMPRAR / MINIMO
#                       (only the owner's minimum asks for it, not sales) /
#                       ALCANZA / SIN_VENTAS
# ─────────────────────────────────────────────────────────────────────────────
V_PURCHASE_FORECAST = """
CREATE OR REPLACE VIEW public.v_purchase_forecast AS
WITH params AS (
    SELECT COALESCE((SELECT CASE WHEN value ~ '^[0-9]+([.][0-9]+)?$' THEN value::numeric END
                       FROM settings WHERE key = 'purchasing.safety_pct'), 20) AS safety_pct,
           -- window end = the last closed sale (normally ~now; after a closure,
           -- the last 4 OPERATING weeks instead of a forecast of zero)
           LEAST(now(), COALESCE((SELECT max(closed_at) FROM tickets WHERE status = 'CLOSED'), now())) AS hasta
),
uso AS (
    SELECT m.inventory_item_id,
           SUM(-m.quantity_delta)                                                    AS uso_28d,
           SUM(-m.quantity_delta) FILTER (WHERE m.created_at > p.hasta - interval '7 days') AS uso_7d
      FROM inventory_movements m CROSS JOIN params p
     WHERE m.created_at >  p.hasta - interval '28 days'
       AND m.created_at <= p.hasta
       AND m.event_type IN ('SALE_DEDUCTION','SALE_CONSUMPTION','VOID_REVERSAL','WASTE')
     GROUP BY m.inventory_item_id
),
-- What a purchasable item turns into, with "child units per parent unit":
-- shots per bottle (ml), loose per box, and packs per kg of a raw item (E8).
link AS (
    SELECT c.from_item_id AS parent_id, c.to_item_id AS child_id, c.ratio
      FROM inventory_conversions c
     WHERE c.is_active AND c.conversion_type IN ('BOTTLE_TO_SHOT','PACK_TO_LOOSE')
    UNION ALL
    SELECT pk.portion_source_id, pk.id,
           (CASE rw.base_unit_key WHEN 'kilogramo' THEN 1000 WHEN 'litro' THEN 1000 ELSE 1 END)::numeric
             / pk.portion_size
      FROM inventory_items pk JOIN inventory_items rw ON rw.id = pk.portion_source_id
     WHERE pk.portion_source_id IS NOT NULL AND pk.portion_size > 0 AND COALESCE(pk.is_active, TRUE)
),
kids AS (
    SELECT l.parent_id,
           SUM(COALESCE(u.uso_28d, 0) / l.ratio)  AS uso_28d,
           SUM(COALESCE(u.uso_7d, 0) / l.ratio)   AS uso_7d,
           SUM(ch.stock_quantity / l.ratio)       AS stock,
           string_agg(ch.name, ', ' ORDER BY ch.name) AS nombres
      FROM link l
      JOIN inventory_items ch ON ch.id = l.child_id
      LEFT JOIN uso u ON u.inventory_item_id = l.child_id
     GROUP BY l.parent_id
),
base AS (
    SELECT p.id, p.name, p.category, NULLIF(btrim(p.supplier), '') AS supplier,
           p.base_unit_key, p.purchase_unit_key,
           GREATEST(COALESCE(p.purchase_pack_size, 1), 1)                    AS pack,
           COALESCE(p.unit_cost_cents, 0)                                     AS unit_cost_cents,
           COALESCE(p.low_stock_threshold, 0)                                 AS minimo,
           COALESCE(up.uso_28d, 0) + COALESCE(k.uso_28d, 0)                   AS uso_28d,
           COALESCE(up.uso_7d, 0)  + COALESCE(k.uso_7d, 0)                    AS uso_7d,
           p.stock_quantity + COALESCE(k.stock, 0)                            AS disponible,
           p.stock_quantity                                                   AS cerradas,
           k.nombres                                                          AS producto_abierto
      FROM inventory_items p
      LEFT JOIN kids k             ON k.parent_id = p.id
      LEFT JOIN uso up             ON up.inventory_item_id = p.id
     WHERE COALESCE(p.is_active, TRUE) AND COALESCE(p.stock_nature, 'SIMPLE') <> 'DERIVED'
       AND p.portion_source_id IS NULL                -- packs are made, not bought (E8)
),
calc AS (
    SELECT b.*,
           round(b.uso_28d / 4, 2)                                                AS semanal_4s,
           round(GREATEST(b.uso_28d / 4, (b.uso_28d / 4 + b.uso_7d) / 2), 2)      AS pronostico_semana
      FROM base b
),
need AS (
    SELECT c.*,
           c.pronostico_semana * (1 + (SELECT safety_pct FROM params) / 100)      AS por_ventas,
           GREATEST(c.pronostico_semana * (1 + (SELECT safety_pct FROM params) / 100), c.minimo) AS objetivo
      FROM calc c
),
buy AS (
    SELECT n.*,
           GREATEST(n.objetivo - n.disponible, 0)                                 AS faltante,
           CASE WHEN n.objetivo - n.disponible <= 0 THEN 0
                WHEN n.pack > 1 THEN ceil((n.objetivo - n.disponible) / n.pack) * n.pack
                ELSE ceil(n.objetivo - n.disponible) END                          AS comprar_unidades
      FROM need n
)
SELECT id AS inventory_item_id, name, category, supplier, base_unit_key, purchase_unit_key,
       pack AS purchase_pack_size, producto_abierto,
       round(uso_28d, 2)            AS uso_28d,
       round(uso_7d, 2)             AS uso_7d,
       semanal_4s, pronostico_semana,
       round(objetivo, 2)           AS objetivo,
       round(disponible, 2)         AS disponible,
       cerradas, minimo,
       comprar_unidades,
       CASE WHEN pack > 1 AND comprar_unidades > 0 THEN (comprar_unidades / pack)::int END AS comprar_paquetes,
       unit_cost_cents,
       CASE WHEN unit_cost_cents > 0 THEN round(comprar_unidades * unit_cost_cents)::bigint END AS costo_estimado_cents,
       CASE WHEN semanal_4s > 0 THEN round(disponible / (semanal_4s / 7), 1) END AS dias_cobertura,
       CASE WHEN comprar_unidades > 0 AND semanal_4s > 0 AND disponible / (semanal_4s / 7) < 7 THEN 'URGENTE'
            WHEN comprar_unidades > 0 AND minimo <= por_ventas                          THEN 'COMPRAR'
            WHEN comprar_unidades > 0                                                   THEN 'MINIMO'
            WHEN uso_28d <= 0                                                           THEN 'SIN_VENTAS'
            ELSE 'ALCANZA' END                                                          AS estado
       , (SELECT hasta FROM params) AS datos_hasta
  FROM buy
 ORDER BY CASE WHEN comprar_unidades > 0 AND semanal_4s > 0 AND disponible / (semanal_4s / 7) < 7 THEN 1
               WHEN comprar_unidades > 0 AND minimo <= por_ventas THEN 2 WHEN comprar_unidades > 0 THEN 3
               WHEN uso_28d > 0 THEN 4 ELSE 5 END,
          COALESCE(round(comprar_unidades * unit_cost_cents), 0) DESC, name
"""


# ─────────────────────────────────────────────────────────────────────────────
# v_consumo_sin_venta — product given away, by kind (batch E5)
#
#    CORTESIA  comped lines of closed customer tickets (out of sales since 054)
#    PERSONAL  items of closed staff orders (ticket_type STAFF / STAFF_DONE)
#    One row per line: business date, reason, who authorized, the employee
#    (staff), list value and the real cost from sale_item_costs.
# ─────────────────────────────────────────────────────────────────────────────
V_CONSUMO_SIN_VENTA = """
CREATE OR REPLACE VIEW public.v_consumo_sin_venta AS
WITH cost AS (
    SELECT ticket_line_item_id, SUM(COALESCE(total_cost_cents, 0))::bigint AS costo_cents,
           bool_or(COALESCE(unit_cost_cents, 0) = 0) AS sin_costo
      FROM sale_item_costs GROUP BY ticket_line_item_id
),
mods AS (
    SELECT line_item_id, SUM(COALESCE(price_cents, 0))::bigint AS m FROM line_item_modifiers GROUP BY line_item_id
)
SELECT 'CORTESIA'::text AS tipo, li.id AS line_item_id, t.id AS ticket_id,
       fn_bar_date(t.closed_at) AS fecha, t.closed_at,
       li.comp_reason AS motivo, li.comped_by AS autorizo_id, ua.name AS autorizo,
       NULL::varchar AS empleado_id, NULL::varchar AS empleado,
       COALESCE(li.item_name, mi.name) AS producto, li.quantity,
       COALESCE(li.comp_list_cents, 0)::bigint AS valor_lista_cents,
       COALESCE(c.costo_cents, 0) AS costo_cents, COALESCE(c.sin_costo, c.costo_cents IS NULL) AS costo_incompleto
  FROM ticket_line_items li
  JOIN tickets t           ON t.id = li.ticket_id
  LEFT JOIN menu_items mi  ON mi.id = li.menu_item_id
  LEFT JOIN users ua       ON ua.id = li.comped_by
  LEFT JOIN cost c         ON c.ticket_line_item_id = li.id
 WHERE t.status = 'CLOSED' AND li.comped_at IS NOT NULL AND COALESCE(li.status, '') <> 'VOIDED'
UNION ALL
SELECT 'PERSONAL', li.id, t.id, fn_bar_date(t.closed_at), t.closed_at,
       t.staff_reason, t.staff_authorized_by, ua.name,
       t.staff_user_id, ue.name,
       COALESCE(li.item_name, mi.name), li.quantity,
       (li.quantity * COALESCE(li.unit_price_cents, 0) + COALESCE(md.m, 0))::bigint,
       COALESCE(c.costo_cents, 0), COALESCE(c.sin_costo, c.costo_cents IS NULL)
  FROM ticket_line_items li
  JOIN tickets t           ON t.id = li.ticket_id
  LEFT JOIN menu_items mi  ON mi.id = li.menu_item_id
  LEFT JOIN users ua       ON ua.id = t.staff_authorized_by
  LEFT JOIN users ue       ON ue.id = t.staff_user_id
  LEFT JOIN mods md        ON md.line_item_id = li.id
  LEFT JOIN cost c         ON c.ticket_line_item_id = li.id
 WHERE t.ticket_type = 'STAFF' AND t.status = 'STAFF_DONE' AND COALESCE(li.status, '') <> 'VOIDED'
UNION ALL
-- Free table time given by a manager (055): a cortesía at the table's rate,
-- never more than what was actually played; no ingredient cost.
SELECT 'CORTESIA', ps.id, t.id, fn_bar_date(t.closed_at), t.closed_at,
       ps.manual_free_reason, ps.manual_free_by, ua.name,
       NULL::varchar, NULL::varchar,
       -- one "item" per gift; the minutes go in the name, never into item counts
       'Tiempo de billar ' || (ps.manual_free_seconds / 60) || ' min (' || COALESCE(r.code, '?') || ')', 1,
       round(LEAST(ps.manual_free_seconds, COALESCE(ps.duration_seconds, ps.manual_free_seconds))
             * ps.rate_cents / 3600.0)::bigint,
       0::bigint, FALSE
  FROM pool_timer_sessions ps
  JOIN tickets t       ON t.id = ps.ticket_id
  LEFT JOIN resources r ON r.id = ps.resource_id
  LEFT JOIN users ua   ON ua.id = ps.manual_free_by
 WHERE t.status = 'CLOSED' AND ps.status <> 'CANCELLED' AND ps.manual_free_seconds > 0
"""

ANALYTICS_VIEWS = [
    ("v_bola8_costos_fijos",        V_COSTOS_FIJOS),
    ("v_bola8_billar_por_mesa",     V_BILLAR_POR_MESA),
    ("v_consumo_sin_venta",         V_CONSUMO_SIN_VENTA),
    ("v_bola8_rentabilidad_diaria", V_RENTABILIDAD_DIARIA),
    ("v_bola8_pagos_desglosados",   V_PAGOS_DESGLOSADOS),
    ("v_bola8_flujo_caja",          V_FLUJO_CAJA),
    ("v_bola8_cobertura_costo",     V_COBERTURA_COSTO),
    ("v_bola8_varianza_inventario", V_VARIANZA_INVENTARIO),
    ("v_bola8_personal_desempeno",  V_PERSONAL_DESEMPENO),
    ("v_bola8_anomalias_operativas", V_ANOMALIAS_OPERATIVAS),
    ("v_bola8_promo_redenciones",   V_PROMO_REDENCIONES),
    ("v_purchase_forecast",         V_PURCHASE_FORECAST),
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

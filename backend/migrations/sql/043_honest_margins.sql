-- ============================================================================
-- 043_honest_margins.sql
-- Analytics batch B: a margin is only reported where cost is actually known.
--
-- THE PROBLEM
--
-- 76 of 93 active stock items had no cost, so ~82% of sale lines carried $0
-- cost -- and every profit figure counted those lines as 100% margin. The
-- dashboards showed 96-100% margins, the menu matrix called zero-cost items
-- "stars", and "covered" meant "any ingredient has a cost" (a bucket with one
-- costed beer counted as fully costed).
--
-- WHAT THIS ADDS
--
-- 1. menu_categories.exenta_costo -- categories that legitimately have no cost
--    (damage recovery, misc income). Replaces the hard-coded names 'Daños' /
--    'INGRESOS' in the API so another venue can mark its own. Bola8's two are
--    flagged here.
-- 2. sale_item_costs.cost_restated_at -- set when a $0 historical cost row is
--    filled in later with the item's current cost ("Recalcular histórico").
--    Those margins are current-cost estimates and must stay labelled as such.
-- 3. v_bola8_lineas_venta gains, at the END (existing columns untouched):
--      costo_estado       EXENTO | SIN_RECETA | COMPLETO | SIN_COSTO | PARCIAL
--                         COMPLETO = every ingredient deducted had a cost.
--      exenta_costo       the line's category is exempt
--      costo_reexpresado  at least one of its cost rows was restated
--    Only COMPLETO lines feed a margin; coverage = COMPLETO sales / non-exempt sales.
--
-- Depends on: 042
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('042') THEN RAISE EXCEPTION '042 must be applied before 043.'; END IF;
END $$;

ALTER TABLE menu_categories
    ADD COLUMN IF NOT EXISTS exenta_costo boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN menu_categories.exenta_costo IS
    'true = sales in this category have no cost of goods by nature (excluded from cost coverage)';

-- Bola8 data: the two categories the API used to hard-code.
UPDATE menu_categories SET exenta_costo = true
 WHERE btrim(name) IN ('Daños', 'INGRESOS') AND exenta_costo = false;

ALTER TABLE sale_item_costs
    ADD COLUMN IF NOT EXISTS cost_restated_at timestamptz;
COMMENT ON COLUMN sale_item_costs.cost_restated_at IS
    'Set when a $0 cost captured at sale time was later filled with the item''s current cost (estimate)';

CREATE OR REPLACE VIEW public.v_bola8_lineas_venta AS
 WITH modifier_totals AS (
         SELECT line_item_modifiers.line_item_id,
            sum(COALESCE(line_item_modifiers.price_cents, 0))::integer AS modifier_cents
           FROM line_item_modifiers
          GROUP BY line_item_modifiers.line_item_id
        ), cost_totals AS (
         SELECT sale_item_costs.ticket_line_item_id,
            sum(COALESCE(sale_item_costs.total_cost_cents, 0))::integer AS total_cost_cents,
            round(sum(COALESCE(sale_item_costs.quantity_deducted, 0::numeric)), 2)::numeric(18,2) AS quantity_deducted,
            count(*) AS cost_rows,
            count(*) FILTER (WHERE COALESCE(sale_item_costs.unit_cost_cents, 0) = 0) AS zero_rows,
            bool_or(sale_item_costs.cost_restated_at IS NOT NULL) AS restated
           FROM sale_item_costs
          GROUP BY sale_item_costs.ticket_line_item_id
        ), raw_lines AS (
         SELECT t.id AS ticket_id,
            t.closed_at,
            (t.closed_at AT TIME ZONE 'America/Mexico_City'::text)::date AS fecha_mx,
            EXTRACT(isodow FROM (t.closed_at AT TIME ZONE 'America/Mexico_City'::text))::integer AS dia_semana_iso,
            EXTRACT(hour FROM (t.closed_at AT TIME ZONE 'America/Mexico_City'::text))::integer AS hora_mx,
            t.ticket_type,
            t.payment_type,
            t.payment_type_2,
            COALESCE(t.discount_cents, 0) AS ticket_discount_cents,
            li.id AS line_item_id,
            li.menu_item_id,
            COALESCE(li.item_name, mi.name) AS producto,
            COALESCE(mc.name, 'Sin categoria'::character varying) AS categoria,
            li.quantity,
            li.unit_price_cents,
            COALESCE(mt.modifier_cents, 0) AS modifier_cents,
            COALESCE(ct.total_cost_cents, 0) AS total_cost_cents,
            COALESCE(ct.quantity_deducted, 0::numeric)::numeric(18,2) AS quantity_deducted,
            COALESCE(mc.exenta_costo, false) AS exenta_costo,
            COALESCE(ct.cost_rows, 0::bigint) AS cost_rows,
            COALESCE(ct.zero_rows, 0::bigint) AS zero_rows,
            COALESCE(ct.restated, false) AS restated,
            li.quantity * li.unit_price_cents + COALESCE(mt.modifier_cents, 0) AS gross_line_cents,
            sum(li.quantity * li.unit_price_cents + COALESCE(mt.modifier_cents, 0)) OVER (PARTITION BY t.id) AS ticket_items_gross_cents
           FROM tickets t
             JOIN ticket_line_items li ON li.ticket_id::text = t.id::text
             LEFT JOIN menu_items mi ON mi.id::text = li.menu_item_id::text
             LEFT JOIN menu_categories mc ON mc.id::text = mi.category_id::text
             LEFT JOIN modifier_totals mt ON mt.line_item_id::text = li.id::text
             LEFT JOIN cost_totals ct ON ct.ticket_line_item_id::text = li.id::text
          WHERE t.status::text = 'CLOSED'::text AND t.closed_at IS NOT NULL AND COALESCE(li.status, ''::character varying)::text <> 'VOIDED'::text AND li.voided_at IS NULL
        ), calculated AS (
         SELECT raw_lines.ticket_id,
            raw_lines.closed_at,
            raw_lines.fecha_mx,
            raw_lines.dia_semana_iso,
            raw_lines.hora_mx,
            raw_lines.ticket_type,
            raw_lines.payment_type,
            raw_lines.payment_type_2,
            raw_lines.ticket_discount_cents,
            raw_lines.line_item_id,
            raw_lines.menu_item_id,
            raw_lines.producto,
            raw_lines.categoria,
            raw_lines.quantity,
            raw_lines.unit_price_cents,
            raw_lines.modifier_cents,
            raw_lines.total_cost_cents,
            raw_lines.quantity_deducted,
            raw_lines.exenta_costo,
            raw_lines.cost_rows,
            raw_lines.zero_rows,
            raw_lines.restated,
            raw_lines.gross_line_cents,
            raw_lines.ticket_items_gross_cents,
                CASE
                    WHEN raw_lines.ticket_items_gross_cents > 0 THEN round(raw_lines.ticket_discount_cents::numeric * raw_lines.gross_line_cents::numeric / raw_lines.ticket_items_gross_cents::numeric)::integer
                    ELSE 0
                END AS allocated_discount_cents
           FROM raw_lines
        )
 SELECT calculated.ticket_id,
    calculated.closed_at,
    calculated.fecha_mx,
    calculated.dia_semana_iso,
    calculated.hora_mx,
    calculated.ticket_type,
    calculated.payment_type,
    calculated.payment_type_2,
    calculated.ticket_discount_cents,
    calculated.line_item_id,
    calculated.menu_item_id,
    calculated.producto,
    calculated.categoria,
    calculated.quantity,
    calculated.unit_price_cents,
    calculated.modifier_cents,
    calculated.total_cost_cents,
    calculated.quantity_deducted,
    calculated.gross_line_cents,
    calculated.ticket_items_gross_cents,
    calculated.allocated_discount_cents,
    calculated.gross_line_cents - calculated.allocated_discount_cents AS net_sales_cents,
    calculated.gross_line_cents - calculated.allocated_discount_cents - calculated.total_cost_cents AS gross_profit_cents,
    round(calculated.gross_line_cents::numeric / 100::numeric, 2)::numeric(18,2) AS gross_line_mxn,
    round((calculated.gross_line_cents - calculated.allocated_discount_cents)::numeric / 100::numeric, 2)::numeric(18,2) AS net_sales_mxn,
    round(calculated.total_cost_cents::numeric / 100::numeric, 2)::numeric(18,2) AS costo_mxn,
    round((calculated.gross_line_cents - calculated.allocated_discount_cents - calculated.total_cost_cents)::numeric / 100::numeric, 2)::numeric(18,2) AS utilidad_mxn,
        CASE
            WHEN calculated.exenta_costo THEN 'EXENTO'::text
            WHEN calculated.cost_rows = 0 THEN 'SIN_RECETA'::text
            WHEN calculated.zero_rows = 0 THEN 'COMPLETO'::text
            WHEN calculated.zero_rows = calculated.cost_rows THEN 'SIN_COSTO'::text
            ELSE 'PARCIAL'::text
        END AS costo_estado,
    calculated.exenta_costo,
    calculated.restated AS costo_reexpresado
   FROM calculated;

-- Recommendations: rank "high margin" on the honest rule (see above).
CREATE OR REPLACE VIEW public.v_bola8_recomendaciones AS
 WITH top_margin AS (
         -- Ranked on the honest rule: margin measured on fully-costed lines
         -- only, and only for products with >= 80% of their sales fully costed.
         -- (The 042 version used v_bola8_utilidad_producto, where one costed
         -- ingredient made a whole partially-costed product look high-margin.)
         SELECT v.producto,
                SUM(v.net_sales_cents) AS ventas_cents,
                (SUM(v.net_sales_cents - v.total_cost_cents) FILTER (WHERE v.costo_estado = 'COMPLETO'))::numeric
                  / NULLIF(SUM(v.net_sales_cents) FILTER (WHERE v.costo_estado = 'COMPLETO'), 0) AS margen
           FROM public.v_bola8_lineas_venta v
          WHERE NOT v.exenta_costo
          GROUP BY v.producto
         HAVING SUM(v.net_sales_cents) > 0
            AND COALESCE(SUM(v.net_sales_cents) FILTER (WHERE v.costo_estado = 'COMPLETO'), 0)
                >= 0.8 * SUM(v.net_sales_cents)
          ORDER BY 3 DESC, 2 DESC
         LIMIT 10
        ), peak_hours AS (
         SELECT v_bola8_ventas_por_hora.hora_mx,
            v_bola8_ventas_por_hora.ventas_mxn
           FROM public.v_bola8_ventas_por_hora
          ORDER BY v_bola8_ventas_por_hora.ventas_mxn DESC
         LIMIT 3
        ), slow AS (
         SELECT v_bola8_productos_lentos.producto,
            v_bola8_productos_lentos.categoria,
            v_bola8_productos_lentos.unidades_30d
           FROM public.v_bola8_productos_lentos
         LIMIT 10
        ), urgent_buy AS (
         SELECT v_bola8_forecast_compras.insumo,
            v_bola8_forecast_compras.dias_cobertura,
            v_bola8_forecast_compras.sugerido_comprar_unidades
           FROM public.v_bola8_forecast_compras
          WHERE (v_bola8_forecast_compras.recomendacion_compra = ANY (ARRAY['Comprar urgente'::text, 'Comprar esta semana'::text, 'Debajo de mínimo'::text]))
         LIMIT 10
        )
 SELECT 'Ventas'::text AS area,
    'Impulsar productos de alto margen'::text AS recomendacion,
    ('Prioriza combos y upsell con: '::text || COALESCE(string_agg((top_margin.producto)::text, ', '::text), 'Sin datos suficientes: registra el costo de tus productos'::text)) AS detalle
   FROM top_margin
UNION ALL
 SELECT 'Operación'::text AS area,
    'Alinear personal y cocina a horas pico'::text AS recomendacion,
    ('Horas con mayor venta histórica: '::text || COALESCE(string_agg(((peak_hours.hora_mx)::text || ':00'::text), ', '::text), 'Sin datos suficientes'::text)) AS detalle
   FROM peak_hours
UNION ALL
 SELECT 'Menú'::text AS area,
    'Revisar o promocionar productos lentos'::text AS recomendacion,
    ('Productos con baja rotación: '::text || COALESCE(string_agg((slow.producto)::text, ', '::text), 'Sin datos suficientes'::text)) AS detalle
   FROM slow
UNION ALL
 SELECT 'Compras'::text AS area,
    'Prevenir quiebres de inventario'::text AS recomendacion,
    ('Insumos a comprar: '::text || COALESCE(string_agg(((((urgent_buy.insumo)::text || ' ('::text) || (urgent_buy.sugerido_comprar_unidades)::text) || ')'::text), ', '::text), 'Sin compras urgentes'::text)) AS detalle
   FROM urgent_buy;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('043', 'honest_margins',
        'costo_estado per sale line; exempt categories as a setting; restated cost rows marked.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '043_honest_margins: OK'; END $done$;

COMMIT;

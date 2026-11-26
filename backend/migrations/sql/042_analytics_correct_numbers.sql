-- ============================================================================
-- 042_analytics_correct_numbers.sql
-- Analytics batch A: views that showed the owner wrong numbers.
-- (Views owned by app/analytics_views.py -- cash flow, payment split, anomalies
-- -- are fixed THERE, because `flask init-db` re-creates them on every start.
-- This file covers the views that exist only in the database.)
--
-- THE BUGS THIS FIXES
--
-- A6. Mojibake. These views were last created from a dump piped through
--     PowerShell, so their labels read 'Debajo de m├¡nimo', 'Operaci├│n'...
--     analytics.py filters on the correct spelling, so below-minimum items
--     NEVER reached the shopping list. This file is UTF-8: do not open or pipe
--     it through Windows PowerShell 5.1 (see DEPLOY-WINDOWS.md, trap 2).
--
-- A8. "Today" in UTC. The database runs in UTC, so CURRENT_DATE / date_trunc
--     are tomorrow after 18:00 in Mexico: the weekly forecast started on the
--     wrong day, slow-movers and active promos shifted, and audit summaries
--     filed evening events under the next day.
--
-- A12. The purchase forecast counted only sales, so items consumed by opening
--     (bottles -> shots: CONVERSION_OUT) or by production never showed any
--     consumption and were never suggested for purchase.
--
-- Also: the weekly sales forecast averaged only days WITH sales (closed days
-- were skipped, inflating the forecast) and included today's partial day; and
-- the "push high-margin products" recommendation ranked products whose cost
-- is unknown (=100% margin), i.e. exactly the ones we know nothing about.
--
-- Every view keeps its exact column list, so CREATE OR REPLACE is safe and no
-- dependent view or endpoint changes.
--
-- Depends on: 041
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('041') THEN RAISE EXCEPTION '041 must be applied before 042.'; END IF;
END $$;

-- The bar's calendar day. One definition so every view agrees.
-- TODO(multi-venue): read the timezone from venue settings.
CREATE OR REPLACE FUNCTION public.fn_bar_today() RETURNS date
    LANGUAGE sql STABLE AS $$
    SELECT (now() AT TIME ZONE 'America/Mexico_City')::date;
$$;

CREATE OR REPLACE FUNCTION public.fn_bar_date(p_ts timestamptz) RETURNS date
    LANGUAGE sql STABLE AS $$
    SELECT (p_ts AT TIME ZONE 'America/Mexico_City')::date;
$$;

-- ---------------------------------------------------------------------------
-- Purchase forecast (A6 labels, A12 consumption)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bola8_forecast_compras AS
 WITH consumo AS (
         SELECT m.inventory_item_id,
            (round(sum(
                CASE
                    -- sold, opened into shots/loose, or used in production
                    WHEN m.event_type IN ('SALE_DEDUCTION', 'SALE_CONSUMPTION',
                                          'CONVERSION_OUT', 'PRODUCTION_CONSUME')
                        THEN abs(m.quantity_delta)
                    WHEN m.event_type = 'VOID_REVERSAL' THEN - abs(m.quantity_delta)
                    ELSE 0::numeric
                END), 2))::numeric(18,2) AS consumo_neto_28d
           FROM public.inventory_movements m
          WHERE m.created_at >= (now() - '28 days'::interval)
          GROUP BY m.inventory_item_id
        ), calc AS (
         SELECT ii.id AS inventory_item_id,
            ii.name AS insumo,
            ii.category,
            ii.unit,
            (round((ii.stock_quantity)::numeric, 2))::numeric(18,2) AS stock_quantity,
            (round(COALESCE(ii.low_stock_threshold, (0)::numeric), 2))::numeric(18,2) AS low_stock_threshold,
            (round(((COALESCE(ii.unit_cost_cents, 0))::numeric / (100)::numeric), 2))::numeric(18,2) AS unit_cost_mxn,
            (round(((COALESCE(ii.purchase_cost_cents, 0))::numeric / (100)::numeric), 2))::numeric(18,2) AS purchase_cost_mxn,
            (round(COALESCE(ii.purchase_pack_size, (1)::numeric), 2))::numeric(18,2) AS purchase_pack_size,
            ii.supplier,
            (COALESCE(c.consumo_neto_28d, 0.00))::numeric(18,2) AS consumo_neto_28d,
            (round((COALESCE(c.consumo_neto_28d, (0)::numeric) / (4)::numeric), 2))::numeric(18,2) AS consumo_promedio_semanal,
                CASE
                    WHEN (COALESCE(c.consumo_neto_28d, (0)::numeric) > (0)::numeric) THEN (round(((ii.stock_quantity)::numeric / NULLIF((COALESCE(c.consumo_neto_28d, (0)::numeric) / (28)::numeric), (0)::numeric)), 2))::numeric(18,2)
                    ELSE NULL::numeric
                END AS dias_cobertura
           FROM (public.inventory_items ii
             LEFT JOIN consumo c ON (((c.inventory_item_id)::text = (ii.id)::text)))
          WHERE (COALESCE(ii.is_active, true) = true)
        )
 SELECT calc.inventory_item_id,
    calc.insumo,
    calc.category,
    calc.unit,
    calc.stock_quantity,
    calc.low_stock_threshold,
    calc.unit_cost_mxn,
    calc.purchase_cost_mxn,
    calc.purchase_pack_size,
    calc.supplier,
    calc.consumo_neto_28d,
    calc.consumo_promedio_semanal,
    calc.dias_cobertura,
    -- Enough for two weeks of consumption, and never less than what brings the
    -- item back up to the owner's minimum (an item below minimum with no recent
    -- sales used to suggest buying 0).
    (GREATEST(ceil(((calc.consumo_promedio_semanal * (2)::numeric) - calc.stock_quantity)),
              ceil(calc.low_stock_threshold - calc.stock_quantity),
              (0)::numeric))::numeric(18,2) AS sugerido_comprar_unidades,
    (round((GREATEST(ceil(((calc.consumo_promedio_semanal * (2)::numeric) - calc.stock_quantity)),
                     ceil(calc.low_stock_threshold - calc.stock_quantity),
                     (0)::numeric) * calc.unit_cost_mxn), 2))::numeric(18,2) AS costo_estimado_compra_mxn,
        CASE
            WHEN (calc.dias_cobertura < (7)::numeric)  THEN 'Comprar urgente'::text
            WHEN (calc.dias_cobertura < (14)::numeric) THEN 'Comprar esta semana'::text
            -- Below the owner's minimum beats "no recent consumption": the
            -- minimum is an explicit instruction.
            WHEN (calc.stock_quantity <= COALESCE(calc.low_stock_threshold, (0)::numeric)
                  AND COALESCE(calc.low_stock_threshold, 0) > 0)   THEN 'Debajo de mínimo'::text
            WHEN (calc.dias_cobertura IS NULL)          THEN 'Sin consumo últimos 28 días'::text
            ELSE 'OK'::text
        END AS recomendacion_compra
   FROM calc
  ORDER BY
        CASE
            WHEN (calc.dias_cobertura < (7)::numeric) THEN 1
            WHEN (calc.dias_cobertura < (14)::numeric) THEN 2
            WHEN (calc.dias_cobertura IS NULL) THEN 4
            ELSE 3
        END, calc.dias_cobertura, calc.insumo;

-- ---------------------------------------------------------------------------
-- Weekly sales forecast (A8 dates; closed days count as $0; no partial today)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bola8_forecast_semanal AS
 WITH days AS (
         -- the last 8 complete weeks, every calendar day, sales or not
         SELECT (generate_series(fn_bar_today() - 56, fn_bar_today() - 1, '1 day'::interval))::date AS fecha_mx
        ), sales AS (
         SELECT v.fecha_mx, sum(v.total_cents) AS total_cents, count(*) AS tickets
           FROM public.v_bola8_tickets_cerrados v
          WHERE v.fecha_mx >= fn_bar_today() - 56 AND v.fecha_mx < fn_bar_today()
          GROUP BY v.fecha_mx
        ), daily AS (
         SELECT d.fecha_mx,
            (EXTRACT(isodow FROM d.fecha_mx))::integer AS dia_semana_iso,
            (round((COALESCE(s.total_cents, 0))::numeric / (100)::numeric, 2))::numeric(18,2) AS ventas_mxn,
            COALESCE(s.tickets, 0) AS tickets
           FROM days d LEFT JOIN sales s ON s.fecha_mx = d.fecha_mx
        ), baseline AS (
         SELECT daily.dia_semana_iso,
            (round(avg(daily.ventas_mxn), 2))::numeric(18,2) AS forecast_ventas_mxn,
            (round(avg(daily.tickets), 2))::numeric(18,2) AS forecast_tickets
           FROM daily
          GROUP BY daily.dia_semana_iso
        ), next_7 AS (
         SELECT (generate_series(fn_bar_today(), fn_bar_today() + 6, '1 day'::interval))::date AS fecha_forecast
        )
 SELECT n.fecha_forecast,
    (EXTRACT(isodow FROM n.fecha_forecast))::integer AS dia_semana_iso,
    TRIM(BOTH FROM to_char((n.fecha_forecast)::timestamp with time zone, 'Day'::text)) AS dia_semana,
    (COALESCE(b.forecast_ventas_mxn, 0.00))::numeric(18,2) AS forecast_ventas_mxn,
    (COALESCE(b.forecast_tickets, 0.00))::numeric(18,2) AS forecast_tickets
   FROM (next_7 n
     LEFT JOIN baseline b ON ((b.dia_semana_iso = (EXTRACT(isodow FROM n.fecha_forecast))::integer)))
  ORDER BY n.fecha_forecast;

-- ---------------------------------------------------------------------------
-- Slow movers (A6 labels, A8 dates)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bola8_productos_lentos AS
 WITH ventas_30 AS (
         SELECT v_bola8_lineas_venta.menu_item_id,
            sum(v_bola8_lineas_venta.quantity) AS unidades_30d,
            (round(((sum(v_bola8_lineas_venta.net_sales_cents))::numeric / (100)::numeric), 2))::numeric(18,2) AS ventas_30d_mxn,
            max(v_bola8_lineas_venta.fecha_mx) AS ultima_fecha_venta
           FROM public.v_bola8_lineas_venta
          WHERE (v_bola8_lineas_venta.fecha_mx >= (fn_bar_today() - 30))
          GROUP BY v_bola8_lineas_venta.menu_item_id
        )
 SELECT mi.id AS menu_item_id,
    mi.name AS producto,
    mc.name AS categoria,
    (round(((mi.price_cents)::numeric / (100)::numeric), 2))::numeric(18,2) AS precio_mxn,
    COALESCE(v.unidades_30d, (0)::bigint) AS unidades_30d,
    (COALESCE(v.ventas_30d_mxn, 0.00))::numeric(18,2) AS ventas_30d_mxn,
    v.ultima_fecha_venta,
        CASE
            WHEN (COALESCE(v.unidades_30d, (0)::bigint) = 0) THEN 'Sin venta últimos 30 días'::text
            WHEN (COALESCE(v.unidades_30d, (0)::bigint) <= 3) THEN 'Baja rotación'::text
            ELSE 'OK'::text
        END AS diagnostico
   FROM ((public.menu_items mi
     LEFT JOIN public.menu_categories mc ON (((mc.id)::text = (mi.category_id)::text)))
     LEFT JOIN ventas_30 v ON (((v.menu_item_id)::text = (mi.id)::text)))
  WHERE ((COALESCE(mi.is_active, true) = true) AND (COALESCE(v.unidades_30d, (0)::bigint) <= 3))
  ORDER BY COALESCE(v.unidades_30d, (0)::bigint), mi.name;

-- ---------------------------------------------------------------------------
-- Active promotions (A8)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bola8_promociones_activas AS
 SELECT p.id AS promotion_id,
    p.name,
    p.promo_type,
    p.discount_type,
    p.discount_value,
    mi.name AS aplica_producto,
    mc.name AS aplica_categoria,
    p.happy_hour_start,
    p.happy_hour_end,
    p.valid_from,
    p.valid_to,
    p.required_quantity,
    p.free_quantity,
    p.discounted_quantity,
    p.max_applications_per_ticket,
    p.is_stackable,
    p.combine_across_items,
    p.priority,
    p.requires_confirmation
   FROM ((public.promotions p
     LEFT JOIN public.menu_items mi ON (((mi.id)::text = (p.applies_to_item_id)::text)))
     LEFT JOIN public.menu_categories mc ON (((mc.id)::text = (p.applies_to_category_id)::text)))
  WHERE ((COALESCE(p.is_active, false) = true) AND (fn_bar_today() >= p.valid_from) AND (fn_bar_today() <= p.valid_to))
  ORDER BY p.priority DESC, p.name;

-- ---------------------------------------------------------------------------
-- Recommendations (A6 labels; rank margin only where cost is known)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bola8_recomendaciones AS
 WITH top_margin AS (
         SELECT u.producto, u.categoria, u.ventas_mxn, u.utilidad_mxn, u.margen_pct
           FROM public.v_bola8_utilidad_producto u
          WHERE u.ventas_mxn > 0 AND u.margen_pct IS NOT NULL
            -- A product with no recorded cost shows 100% margin. Recommending
            -- it as "high margin" is recommending what we know nothing about.
            AND COALESCE(u.costo_mxn, 0) > 0
          ORDER BY u.margen_pct DESC, u.utilidad_mxn DESC
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

-- ---------------------------------------------------------------------------
-- Audit / shrinkage summaries grouped by the bar's day, not UTC's (A8)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_authorization_overrides_daily AS
 SELECT fn_bar_date(o.created_at) AS business_date,
    o.action_code,
    a.category,
    a.description_es,
    u_req.name AS requested_by_name,
    u_auth.name AS authorized_by_name,
    count(*) AS override_count,
    sum(COALESCE(o.value_delta_cents, 0)) AS total_value_delta_cents,
    count(*) FILTER (WHERE ((o.outcome)::text = 'WARN_ONLY'::text)) AS unauthorized_warn_count
   FROM (((public.authorization_overrides o
     JOIN public.users u_req ON (((u_req.id)::text = (o.requested_by)::text)))
     JOIN public.users u_auth ON (((u_auth.id)::text = (o.authorized_by)::text)))
     LEFT JOIN public.authorized_actions a ON (((a.action_code)::text = (o.action_code)::text)))
  GROUP BY fn_bar_date(o.created_at), o.action_code, a.category, a.description_es, u_req.name, u_auth.name;

CREATE OR REPLACE VIEW public.v_manager_override_summary AS
 SELECT fn_bar_date(o.created_at) AS fecha,
    ua.name AS gerente,
    a.category,
    count(*) AS overrides,
    ((sum(COALESCE(o.value_delta_cents, 0)))::numeric / 100.0) AS valor_removido,
    count(DISTINCT o.requested_by) AS solicitantes,
    count(*) FILTER (WHERE ((o.outcome)::text = 'WARN_ONLY'::text)) AS sin_autorizacion
   FROM ((public.authorization_overrides o
     JOIN public.users ua ON (((ua.id)::text = (o.authorized_by)::text)))
     LEFT JOIN public.authorized_actions a ON (((a.action_code)::text = (o.action_code)::text)))
  GROUP BY fn_bar_date(o.created_at), ua.name, a.category
  ORDER BY fn_bar_date(o.created_at) DESC, (count(*)) DESC;

CREATE OR REPLACE VIEW public.v_shrinkage_summary AS
 SELECT fn_bar_date(m.created_at) AS fecha,
    i.name AS producto,
    i.category,
    sum(m.quantity_delta) FILTER (WHERE ((m.event_type)::text = 'WASTE'::text)) AS merma,
    sum(m.quantity_delta) FILTER (WHERE ((m.event_type)::text = 'COUNT_ADJUSTMENT'::text)) AS ajuste_conteo,
    sum(m.quantity_delta) FILTER (WHERE ((m.event_type)::text = 'MANUAL_ADJUSTMENT'::text)) AS ajuste_manual,
    (sum((m.quantity_delta * (COALESCE(m.unit_cost_cents, 0))::numeric)) / 100.0) AS impacto_costo
   FROM (public.inventory_movements m
     JOIN public.inventory_items i ON (((i.id)::text = (m.inventory_item_id)::text)))
  WHERE (((m.event_type)::text = ANY (ARRAY[('WASTE'::character varying)::text, ('COUNT_ADJUSTMENT'::character varying)::text, ('MANUAL_ADJUSTMENT'::character varying)::text])) AND (m.created_at >= public.ledger_cutover()))
  GROUP BY fn_bar_date(m.created_at), i.name, i.category
  ORDER BY fn_bar_date(m.created_at) DESC;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('042', 'analytics_correct_numbers',
        'UTF-8 labels; bar-local dates (fn_bar_today/fn_bar_date); forecast counts bottle use; '
        'recommendations rank only costed products.')
ON CONFLICT (version) DO NOTHING;

-- Guard against a re-introduced encoding problem.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public'
                AND (definition LIKE '%├%' OR definition LIKE '%Ã%')) THEN
        RAISE EXCEPTION '042: a view definition still contains mojibake';
    END IF;
END $$;

DO $done$ BEGIN RAISE NOTICE '042_analytics_correct_numbers: OK'; END $done$;

COMMIT;

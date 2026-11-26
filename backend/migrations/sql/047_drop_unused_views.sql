-- ============================================================================
-- 047_drop_unused_views.sql
-- Remove views nothing uses (batch D4).
--
-- Checked against the whole repository (app, Telegram bot, scripts, deploy
-- runbooks, docs), every other view and every SQL function: no references.
-- Each one still had to be kept correct on every schema change (044 rebuilt
-- views, 045/046 rewrote timezones), so dead views were a real cost.
--
--   legacy cigarette-box system (retired; inserts blocked since 033)
--     v_cigarette_box_history, v_cigarette_count_sheet, v_cigarette_reconciliation
--   dashboard variants superseded by the Analítica endpoints
--     v_bola8_top_productos, v_bola8_ventas_por_dia_semana,
--     v_bola8_kpis_ejecutivos (all history in one row), v_bola8_promociones_activas,
--     v_bola8_recomendaciones (never shown anywhere), v_bola8_ventas_por_hora (fed only that)
--   migration-era helpers replaced by fn_effective_available / /stock-check
--     v_effective_modifier_rules, v_menu_availability, v_convertible_stock,
--     v_portion_availability, v_pack_lots_open
--
-- Diagnostic views that are unused today but worth surfacing later are KEPT and
-- listed in docs/DIAGNOSTIC-VIEWS.md.
--
-- No CASCADE: if anything unexpected depends on one of these, fail loudly.
-- Depends on: 046
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('046') THEN RAISE EXCEPTION '046 must be applied before 047.'; END IF;
END $$;

DROP VIEW IF EXISTS public.v_bola8_recomendaciones;      -- before ventas_por_hora (depends on it)
DROP VIEW IF EXISTS public.v_bola8_ventas_por_hora;
DROP VIEW IF EXISTS public.v_bola8_top_productos;
DROP VIEW IF EXISTS public.v_bola8_ventas_por_dia_semana;
DROP VIEW IF EXISTS public.v_bola8_kpis_ejecutivos;
DROP VIEW IF EXISTS public.v_bola8_promociones_activas;
DROP VIEW IF EXISTS public.v_cigarette_box_history;
DROP VIEW IF EXISTS public.v_cigarette_count_sheet;
DROP VIEW IF EXISTS public.v_cigarette_reconciliation;
DROP VIEW IF EXISTS public.v_effective_modifier_rules;
DROP VIEW IF EXISTS public.v_menu_availability;
DROP VIEW IF EXISTS public.v_convertible_stock;
DROP VIEW IF EXISTS public.v_portion_availability;
DROP VIEW IF EXISTS public.v_pack_lots_open;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('047', 'drop_unused_views', '14 unreferenced views removed; diagnostics kept (docs/DIAGNOSTIC-VIEWS.md).')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '047_drop_unused_views: OK'; END $done$;

COMMIT;

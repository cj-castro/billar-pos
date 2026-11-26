-- ============================================================================
-- 051_drop_old_purchase_forecast.sql
-- The old purchase forecast view is replaced (batch E3).
--
-- v_bola8_forecast_compras counted OPENING a bottle as consumption, suggested
-- buying shots in ml, ignored waste and case sizes and always aimed for two
-- weeks. Its replacement, v_purchase_forecast (defined in analytics_views.py,
-- rebuilt on every start), feeds Reportes, the Sunday email and the Telegram
-- bot. Nothing references the old view any more.
-- Depends on: 050
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('050') THEN RAISE EXCEPTION '050 must be applied before 051.'; END IF;
END $$;

DROP VIEW IF EXISTS public.v_bola8_forecast_compras;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('051', 'drop_old_purchase_forecast', 'v_bola8_forecast_compras replaced by v_purchase_forecast.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '051_drop_old_purchase_forecast: OK'; END $done$;

COMMIT;

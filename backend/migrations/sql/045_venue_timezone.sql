-- ============================================================================
-- 045_venue_timezone.sql
-- The bar's timezone comes from settings, not from a literal (batch D1).
--
-- Every date in the reports ("which day did this sale happen?") was computed
-- with a hard-coded 'America/Mexico_City'. A pool hall in Bogotá or Monterrey
-- running this build would get every day boundary wrong. Now:
--
--   fn_bar_tz()   the venue's timezone: settings.venue.timezone, falling back
--                 to America/Mexico_City. The application copies the install's
--                 TZ into that setting after migrations (venue_svc.ensure_defaults),
--                 and the owner can change it in Ajustes.
--   fn_bar_today() / fn_bar_date(ts)   (042) now use it.
--   Every view whose definition contains the literal is re-created with
--   fn_bar_tz() in its place (definitions otherwise unchanged).
--
-- Depends on: 044
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('044') THEN RAISE EXCEPTION '044 must be applied before 045.'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_bar_tz() RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT COALESCE(
        (SELECT NULLIF(btrim(value), '') FROM settings WHERE key = 'venue.timezone'),
        'America/Mexico_City');
$$;

CREATE OR REPLACE FUNCTION public.fn_bar_today() RETURNS date
    LANGUAGE sql STABLE AS $$
    SELECT (now() AT TIME ZONE fn_bar_tz())::date;
$$;

CREATE OR REPLACE FUNCTION public.fn_bar_date(p_ts timestamptz) RETURNS date
    LANGUAGE sql STABLE AS $$
    SELECT (p_ts AT TIME ZONE fn_bar_tz())::date;
$$;

-- Re-create every view that still hard-codes the timezone. Same columns, same
-- types (the expression still yields text), so CREATE OR REPLACE is enough.
-- Views owned by app/analytics_views.py are re-created by the app on start with
-- fn_bar_tz() already in them; this covers them too until then.
DO $$
DECLARE r record; n int := 0;
BEGIN
    FOR r IN
        SELECT c.relname AS name, pg_get_viewdef(c.oid) AS def
          FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind = 'v'
           AND pg_get_viewdef(c.oid) LIKE '%America/Mexico_City%'
    LOOP
        EXECUTE format('CREATE OR REPLACE VIEW public.%I AS %s', r.name,
                       rtrim(replace(replace(r.def,
                                     '''America/Mexico_City''::text', 'fn_bar_tz()'),
                                     '''America/Mexico_City''', 'fn_bar_tz()'),
                             '; ' || chr(10)));
        n := n + 1;
    END LOOP;
    RAISE NOTICE '045: % view(s) now use fn_bar_tz()', n;

    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public'
                AND definition LIKE '%America/Mexico_City%') THEN
        RAISE EXCEPTION '045: a view still hard-codes the timezone';
    END IF;
END $$;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('045', 'venue_timezone',
        'fn_bar_tz() from settings.venue.timezone; views and fn_bar_today/fn_bar_date use it.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '045_venue_timezone: OK'; END $done$;

COMMIT;

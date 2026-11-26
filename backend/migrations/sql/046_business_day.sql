-- ============================================================================
-- 046_business_day.sql
-- A bar's day ends at closing time, not at midnight (batch D1 follow-up).
--
-- About 29% of Bola8's sessions cross midnight. With calendar days, a 1:30 am
-- Sunday sale was reported as Sunday -- splitting Saturday night in two and
-- inflating Sunday. The owner now sets the closing hour (settings
-- venue.day_cutoff, "HH:MM", default 00:00 = calendar days, i.e. no change
-- until set):
--
--   fn_bar_cutoff()          the cutoff as an interval
--   fn_bar_business_ts(ts)   bar-local time minus the cutoff: its DATE and
--                            WEEKDAY are the business day
--   fn_bar_date(ts) / fn_bar_today()   now business days
--
-- Every view that derives a DATE or WEEKDAY from fn_bar_tz() is rewritten to
-- use fn_bar_business_ts(); HOUR-of-day expressions keep the real clock hour
-- (a 1 am sale still shows at 1 am on the hourly chart).
--
-- Depends on: 045
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('045') THEN RAISE EXCEPTION '045 must be applied before 046.'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_bar_cutoff() RETURNS interval
    LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT COALESCE(
        (SELECT CASE WHEN value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN value::interval END
           FROM settings WHERE key = 'venue.day_cutoff'),
        interval '0');
$$;

CREATE OR REPLACE FUNCTION public.fn_bar_business_ts(p_ts timestamptz) RETURNS timestamp
    LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT (p_ts AT TIME ZONE fn_bar_tz()) - fn_bar_cutoff();
$$;

CREATE OR REPLACE FUNCTION public.fn_bar_date(p_ts timestamptz) RETURNS date
    LANGUAGE sql STABLE AS $$
    SELECT fn_bar_business_ts(p_ts)::date;
$$;

CREATE OR REPLACE FUNCTION public.fn_bar_today() RETURNS date
    LANGUAGE sql STABLE AS $$
    SELECT fn_bar_business_ts(now())::date;
$$;

-- Rewrite date / weekday derivations. Hour-of-day is protected with a marker
-- first so it keeps the clock hour, then every remaining
-- "(<expr> AT TIME ZONE fn_bar_tz())" becomes "fn_bar_business_ts(<expr>)".
-- Column names and types are unchanged, so CREATE OR REPLACE is enough.
DO $$
DECLARE r record; d text; n int := 0;
BEGIN
    FOR r IN
        SELECT c.relname AS name, pg_get_viewdef(c.oid) AS def
          FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind = 'v'
           AND pg_get_viewdef(c.oid) LIKE '%AT TIME ZONE fn_bar_tz()%'
    LOOP
        d := replace(r.def, 'EXTRACT(hour FROM (', 'EXTRACT(hour FROM (/*CLOCK*/');
        d := regexp_replace(d,
               '\((?!/\*CLOCK\*/)((?:[^()]|\([^()]*\))+?) AT TIME ZONE fn_bar_tz\(\)\)',
               'fn_bar_business_ts(\1)', 'g');
        d := replace(d, '/*CLOCK*/', '');
        IF d <> r.def THEN
            EXECUTE format('CREATE OR REPLACE VIEW public.%I AS %s', r.name, rtrim(d, '; ' || chr(10)));
            n := n + 1;
        END IF;
    END LOOP;
    RAISE NOTICE '046: % view(s) now group by business day', n;

    -- Only hour-of-day may still use the raw timezone conversion.
    IF EXISTS (
        SELECT 1 FROM pg_views WHERE schemaname = 'public'
           AND regexp_replace(definition, 'EXTRACT\(hour FROM \([^()]+ AT TIME ZONE fn_bar_tz\(\)\)\)', '', 'g')
               LIKE '%AT TIME ZONE fn_bar_tz()%') THEN
        RAISE EXCEPTION '046: a view still derives a date from the raw timezone';
    END IF;
END $$;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('046', 'business_day',
        'venue.day_cutoff; fn_bar_business_ts(); dates/weekdays by business day, hours by clock.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '046_business_day: OK'; END $done$;

COMMIT;

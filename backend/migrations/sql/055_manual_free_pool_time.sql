-- ============================================================================
-- 055_manual_free_pool_time.sql
-- Free pool time without a promotion (batch E7 follow-up).
--
-- A manager can give minutes of table time free ("una hora gratis") with a
-- reason and a PIN. Kept apart from promo_free_seconds (the table's configured
-- free minutes) so the report can tell a gift from the house rule. Billing adds
-- it to the free seconds of the session; the report counts it as a cortesía at
-- the table's rate.
-- Depends on: 054
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('054') THEN RAISE EXCEPTION '054 must be applied before 055.'; END IF;
END $$;

ALTER TABLE pool_timer_sessions
    ADD COLUMN IF NOT EXISTS manual_free_seconds INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS manual_free_reason  TEXT,
    ADD COLUMN IF NOT EXISTS manual_free_by      VARCHAR(36) REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS manual_free_at      TIMESTAMPTZ;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pts_manual_free') THEN
        ALTER TABLE pool_timer_sessions ADD CONSTRAINT ck_pts_manual_free
            CHECK (manual_free_seconds >= 0 AND manual_free_seconds <= 86400);
    END IF;
END $$;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('055', 'manual_free_pool_time', 'pool_timer_sessions.manual_free_*: free table time given by a manager, with reason.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '055_manual_free_pool_time: OK'; END $done$;

COMMIT;

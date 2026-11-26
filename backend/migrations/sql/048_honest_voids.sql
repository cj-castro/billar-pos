-- ============================================================================
-- 048_honest_voids.sql
-- What happened to a voided line's product (batch E).
--
-- Until now every void of a sent item put the product back in stock -- a poured
-- shot, a cooked plate, an opened beer -- so real losses vanished and stock was
-- overstated. The void now records the disposition:
--
--   RETURNED  back on the shelf (stock restored)
--   WASTED    poured / made / opened: written off as WASTE, valued
--   NONE      voided before it was sent (nothing had left stock)
--   NULL      voided before this migration: unknown (every one was restored)
--
-- Depends on: 047
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('047') THEN RAISE EXCEPTION '047 must be applied before 048.'; END IF;
END $$;

ALTER TABLE ticket_line_items
    ADD COLUMN IF NOT EXISTS void_disposition VARCHAR(10);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_tli_void_disposition') THEN
        ALTER TABLE ticket_line_items ADD CONSTRAINT ck_tli_void_disposition
            CHECK (void_disposition IS NULL OR void_disposition IN ('RETURNED','WASTED','NONE'));
    END IF;
END $$;

COMMENT ON COLUMN ticket_line_items.void_disposition IS
    'Voided lines: RETURNED (restocked) / WASTED (written off) / NONE (never sent). NULL = before 048.';

INSERT INTO schema_migrations (version, name, notes)
VALUES ('048', 'honest_voids', 'ticket_line_items.void_disposition: returned vs wasted on void.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '048_honest_voids: OK'; END $done$;

COMMIT;

-- ============================================================================
-- 037_ui_settings.sql
-- Stage 10 — configuration for the ticket screen and admin editors.
--
-- ui.merge_identical_lines is the fix for issue (a): groupLineItemsUI merges
-- lines for DISPLAY and shows the sum, but the +/- stepper acts on ONE
-- underlying row (lastId/lastQty). So "-" is disabled whenever the newest row is
-- 1, and the waiter sees "2x" with a dead button and no explanation. Merging on
-- ADD server-side makes one visual row = one DB row and the stepper symmetric.
-- Depends on: 030
-- ============================================================================
BEGIN;
DO $$ BEGIN
    IF NOT _applied('030') THEN RAISE EXCEPTION '030 must be applied before 037.'; END IF;
END $$;

INSERT INTO settings (key, value) VALUES
    ('ui.merge_identical_lines',      'true'),
    ('ui.optimistic_qty_updates',     'true'),
    ('ui.show_availability_badges',   'true'),
    ('ui.block_add_beyond_available', 'false'),
    ('ui.pin_dialog_show_target',     'true'),
    ('ui.kds_poll_fallback_seconds',  '30')
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN ticket_line_items.needs_reprint IS
    'Set when a sent line changes. Stage 3 makes this delta-aware: print "+2 Alitas", '
    'not the whole line again.';

INSERT INTO schema_migrations (version, name, notes)
VALUES ('037','ui_settings','Line merging, optimistic updates, availability badges, PIN target display.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM settings WHERE key LIKE 'ui.%';
    IF n < 6 THEN RAISE EXCEPTION '037: % ui settings, expected >= 6', n; END IF;
    RAISE NOTICE '037 OK -- % ui settings registered', n;
END $$;
COMMIT;

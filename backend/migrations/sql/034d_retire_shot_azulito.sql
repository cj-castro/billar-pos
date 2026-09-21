-- ============================================================================
-- 034d_retire_shot_azulito.sql
-- 'Shot Azulito' ($39, 6 lifetime sales) would otherwise carry ingredients
-- identical to 'Azulito' ($89, 67 sales) at less than half the price. Retired
-- for clarity at the operator's request. Deactivated, not deleted: history
-- references it, and its Sprite recipe row is kept so reactivation is lossless.
-- Depends on: 034c
-- ============================================================================
BEGIN;
DO $$ BEGIN
    IF NOT _applied('034c') THEN RAISE EXCEPTION '034c must be applied before 034d.'; END IF;
END $$;

UPDATE menu_items SET is_active = false WHERE btrim(name) = 'Shot Azulito' AND is_active;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('034d','retire_shot_azulito','Deactivated; 6 lifetime sales. Sprite recipe row retained.')
ON CONFLICT (version) DO NOTHING;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM menu_items WHERE btrim(name)='Shot Azulito' AND is_active) THEN
        RAISE EXCEPTION '034d: Shot Azulito still active';
    END IF;
    RAISE NOTICE '034d OK -- Shot Azulito retired';
END $$;
COMMIT;

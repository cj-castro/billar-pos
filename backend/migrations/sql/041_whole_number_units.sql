-- ============================================================================
-- 041_whole_number_units.sql
-- Units you count (bottle, shot, piece, can, box...) take whole numbers only.
--
-- THE BUG THIS FIXES
--
-- Every quantity box on the inventory screen accepted any decimal, so a
-- restock of "0.01" bottles of Curazao went straight onto the books. Nobody
-- buys, wastes or counts a hundredth of a bottle; a decimal there is always a
-- typo, and it leaves stock like 1.01 that no physical count can ever match.
--
-- The rule belongs to the UNIT, not to a hard-coded list of item names: a new
-- pool hall that adds its own unit says once whether it can be fractional.
-- Measured units (ml, litro, gramo, kilogramo, onza, taza) stay fractional.
--
-- Scope: MANUAL entries only (restock, waste, physical count, manual
-- adjustment, initial stock). Sales are unaffected -- a bucket split across
-- three flavours legitimately deducts thirds of a beer.
--
-- Depends on: 040
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('040') THEN RAISE EXCEPTION '040 must be applied before 041.'; END IF;
END $$;

ALTER TABLE unit_catalog
    ADD COLUMN IF NOT EXISTS allows_fraction boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN unit_catalog.allows_fraction IS
    'false = counted unit (whole numbers only on manual entries); true = measured unit';

-- Only flip rows still at the default, so a later manual choice is never undone.
UPDATE unit_catalog SET allows_fraction = true
 WHERE key IN ('ml', 'litro', 'gramo', 'kilogramo', 'onza', 'taza')
   AND allows_fraction = false;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('041', 'whole_number_units',
        'unit_catalog.allows_fraction; counted units take whole numbers on manual entries.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '041_whole_number_units: OK'; END $done$;

COMMIT;

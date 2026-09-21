-- ============================================================================
-- 029b_retire_legacy_recipes.sql
--
-- Neutralises init-db STEP 16, which does:
--     INSERT INTO insumos_base SELECT ... FROM menu_item_ingredients
--     ON CONFLICT (menu_item_id, inventory_item_id) DO NOTHING
-- on EVERY container start. ON CONFLICT only skips rows that CURRENTLY exist,
-- so any insumos_base row deliberately deleted by 032 / 032c / 034 is
-- RE-INSERTED on the next restart -- silently reviving the Rusa/Fresca
-- double-deduction and the hardcoded combo sodas.
--
-- Fix strategy: remove the fuel rather than guard the spark. Emptying the source
-- table makes STEP 16 permanently inert regardless of ordering or future edits.
-- Safe because insumos_base is a verified superset (95 shared pairs, 0 quantity
-- conflicts, 1 extra row in insumos_base).
--
-- Depends on: 029.  MUST precede 032.
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('029') THEN
        RAISE EXCEPTION '029 must be applied before 029b.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Prove the superset before deleting anything.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing int; v_conflict int; v_total int;
BEGIN
    SELECT count(*) INTO v_missing
      FROM menu_item_ingredients mii
     WHERE NOT EXISTS (SELECT 1 FROM insumos_base b
                        WHERE b.menu_item_id      = mii.menu_item_id
                          AND b.inventory_item_id = mii.inventory_item_id);

    SELECT count(*) INTO v_conflict
      FROM menu_item_ingredients mii
      JOIN insumos_base b ON b.menu_item_id      = mii.menu_item_id
                         AND b.inventory_item_id = mii.inventory_item_id
     WHERE b.quantity <> mii.quantity;

    SELECT count(*) INTO v_total FROM menu_item_ingredients;

    IF v_missing > 0 OR v_conflict > 0 THEN
        RAISE EXCEPTION
            'ABORT: menu_item_ingredients is not a subset (missing=%, conflicts=%)',
            v_missing, v_conflict
            USING HINT = 'Reconcile manually before retiring the legacy table.';
    END IF;

    RAISE NOTICE '029b: superset verified -- all % legacy rows are represented in insumos_base', v_total;
END $$;

-- ---------------------------------------------------------------------------
-- PART 2 — Archive, then empty. The archive IS the rollback.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_item_ingredients_archive_029b AS
SELECT *, clock_timestamp() AS archived_at FROM menu_item_ingredients;

DELETE FROM menu_item_ingredients;

COMMENT ON TABLE menu_item_ingredients IS
    'RETIRED (029b). Emptied deliberately: init-db STEP 16 copies this table into '
    'insumos_base on every start, which resurrected rows deleted by 032/032c/034. '
    'Rows archived in menu_item_ingredients_archive_029b. Do not repopulate.';

-- ---------------------------------------------------------------------------
-- PART 3 — Block writes so nothing can refill it. Converts a silent failure
-- into a loud one: if STEP 16 or seed-beer ever writes here, you get an
-- exception naming the cause instead of mysterious inventory drift.
--
-- NOTE: STEP 16 only READS this table (it inserts into insumos_base), so it will
-- not trip this trigger -- it simply becomes a no-op over an empty source.
-- What DOES trip it is link_ingredient() in the seed-beer CLI command, which
-- writes to both tables. That helper must drop its legacy write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_block_legacy_recipe_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'menu_item_ingredients is retired (029b).'
        USING HINT = 'Write to insumos_base instead. See link_ingredient() in __init__.py.';
END $$;

DROP TRIGGER IF EXISTS trg_block_legacy_recipe_write ON menu_item_ingredients;
CREATE TRIGGER trg_block_legacy_recipe_write
    BEFORE INSERT OR UPDATE ON menu_item_ingredients
    FOR EACH ROW EXECUTE FUNCTION fn_block_legacy_recipe_write();

-- ---------------------------------------------------------------------------
-- PART 4 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('029b','retire_legacy_recipes',
        'Emptied menu_item_ingredients (archived). STEP 16 now inert. Write-blocked.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int; a int;
BEGIN
    SELECT count(*) INTO n FROM menu_item_ingredients;
    IF n <> 0 THEN RAISE EXCEPTION '029b: legacy table still has % rows', n; END IF;

    SELECT count(*) INTO a FROM menu_item_ingredients_archive_029b;
    IF a = 0 THEN RAISE EXCEPTION '029b: archive is empty -- rollback would be impossible'; END IF;

    -- insumos_base must be untouched
    SELECT count(*) INTO n FROM insumos_base;
    IF n < 90 THEN RAISE EXCEPTION '029b: insumos_base has only % rows -- expected ~96', n; END IF;

    RAISE NOTICE '029b OK -- legacy emptied, % rows archived, insumos_base intact at %', a, n;
END $$;

COMMIT;

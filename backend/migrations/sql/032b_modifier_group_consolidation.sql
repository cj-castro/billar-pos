-- ============================================================================
-- 032b_modifier_group_consolidation.sql
--
-- 'Wing Flavor', 'Wing Flavor 300gr' and 'Wing Flavor 700gr' hold BYTE-IDENTICAL
-- option sets (the same 7 sauces). Wing Flavor and Wing Flavor 700gr are also
-- identical in limits (min1/max2); only 300gr differs (max1). That is 21 modifier
-- rows and 21 inventory rules where 7 and 7 would do, and adding an eighth sauce
-- means three inserts instead of one.
--
-- Root cause: min/max_selections live on the GROUP, so any product needing
-- different limits must clone the whole option set. Moving them to the ATTACHMENT
-- lets one option pool serve every product.
--
-- NOTE: this mechanism is for groups whose OPTION SETS are the same and only the
-- limits differ. Where the option sets genuinely differ (sodas: bottle service
-- offers 11, combos should offer fewer and exclude Red Bull) separate groups are
-- correct -- see 032c.
--
-- Depends on: 032
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('032') THEN
        RAISE EXCEPTION 'Migration 032 must be applied before 032b.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Selection rules become per-product. NULL = inherit the group default.
-- ---------------------------------------------------------------------------
ALTER TABLE menu_item_modifier_groups
    ADD COLUMN IF NOT EXISTS min_selections int,
    ADD COLUMN IF NOT EXISTS max_selections int,
    ADD COLUMN IF NOT EXISTS allow_multiple boolean,
    ADD COLUMN IF NOT EXISTS sort_order     int NOT NULL DEFAULT 100;

COMMENT ON COLUMN menu_item_modifier_groups.min_selections IS
    'Overrides modifier_groups.min_selections for this product. NULL = inherit.';

DO $$ BEGIN
    ALTER TABLE menu_item_modifier_groups ADD CONSTRAINT ck_mimg_min_le_max
        CHECK (min_selections IS NULL OR max_selections IS NULL
               OR min_selections <= max_selections);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE VIEW v_effective_modifier_rules AS
SELECT mg.menu_item_id, g.id AS group_id, g.name AS group_name,
       COALESCE(mg.min_selections, g.min_selections) AS min_selections,
       COALESCE(mg.max_selections, g.max_selections) AS max_selections,
       COALESCE(mg.allow_multiple, g.allow_multiple) AS allow_multiple,
       mg.sort_order
  FROM menu_item_modifier_groups mg
  JOIN modifier_groups g ON g.id = mg.modifier_group_id;

-- ---------------------------------------------------------------------------
-- PART 2 — Collapse the three wing groups into one.
-- 2a: repoint attachments, carrying each product's ORIGINAL limits so behaviour
--     is preserved exactly (Alitas 300gr keeps max 1, 700gr keeps max 2).
-- ---------------------------------------------------------------------------
INSERT INTO menu_item_modifier_groups
       (menu_item_id, modifier_group_id, min_selections, max_selections, allow_multiple)
SELECT mg.menu_item_id, keep.id, old.min_selections, old.max_selections, old.allow_multiple
  FROM menu_item_modifier_groups mg
  JOIN modifier_groups old  ON old.id = mg.modifier_group_id
                           AND btrim(old.name) IN ('Wing Flavor 300gr','Wing Flavor 700gr')
  JOIN modifier_groups keep ON btrim(keep.name) = 'Wing Flavor'
 WHERE NOT EXISTS (SELECT 1 FROM menu_item_modifier_groups x
                    WHERE x.menu_item_id = mg.menu_item_id
                      AND x.modifier_group_id = keep.id);

-- 2b: drop the old attachments
DELETE FROM menu_item_modifier_groups mg
 USING modifier_groups g
 WHERE g.id = mg.modifier_group_id
   AND btrim(g.name) IN ('Wing Flavor 300gr','Wing Flavor 700gr');

-- 2c: DEACTIVATE the duplicate modifiers, never delete -- 5,391 line_item_modifiers
--     rows reference these ids historically, and name_snapshot keeps old tickets
--     readable.
UPDATE modifiers m SET is_active = false
  FROM modifier_groups g
 WHERE g.id = m.modifier_group_id
   AND btrim(g.name) IN ('Wing Flavor 300gr','Wing Flavor 700gr')
   AND m.is_active;

UPDATE modifier_groups SET is_mandatory = false
 WHERE btrim(name) IN ('Wing Flavor 300gr','Wing Flavor 700gr') AND is_mandatory;

-- ---------------------------------------------------------------------------
-- PART 3 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('032b','modifier_group_consolidation',
        'Per-attachment limits; 3 wing groups -> 1 (21 modifiers -> 7).')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 4 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM modifiers m
      JOIN modifier_groups g ON g.id = m.modifier_group_id
     WHERE btrim(g.name) LIKE 'Wing Flavor%' AND m.is_active;
    IF n <> 7 THEN RAISE EXCEPTION '032b: % active wing modifiers, expected 7 (was 21)', n; END IF;

    -- both wing products must still have a flavour group, with their original limits
    FOR n IN SELECT 1 FROM menu_items mi
              WHERE btrim(mi.name) IN ('Alitas 300gr','Alitas 700gr') AND mi.is_active
                AND NOT EXISTS (SELECT 1 FROM v_effective_modifier_rules v
                                 WHERE v.menu_item_id = mi.id
                                   AND v.group_name = 'Wing Flavor')
    LOOP
        RAISE EXCEPTION '032b: a wing product lost its flavour group';
    END LOOP;

    IF (SELECT max_selections FROM v_effective_modifier_rules v
         JOIN menu_items mi ON mi.id = v.menu_item_id
        WHERE btrim(mi.name) = 'Alitas 300gr' AND v.group_name = 'Wing Flavor') <> 1 THEN
        RAISE EXCEPTION '032b: Alitas 300gr should keep max_selections = 1';
    END IF;

    -- consolidation must not reopen coverage gaps or create overlaps
    SELECT count(*) INTO n FROM v_modifier_coverage_gaps;
    IF n <> 0 THEN RAISE EXCEPTION '032b: % coverage gaps reopened', n; END IF;
    SELECT count(*) INTO n FROM v_recipe_modifier_overlap;
    IF n <> 0 THEN RAISE EXCEPTION '032b: % overlaps introduced', n; END IF;

    RAISE NOTICE '032b OK -- 7 active wing modifiers, per-product limits preserved';
END $$;

COMMIT;

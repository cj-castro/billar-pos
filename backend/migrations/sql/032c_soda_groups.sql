-- ============================================================================
-- 032c_soda_groups.sql
--
-- Two purpose-built soda groups instead of one overloaded group.
--
-- 'Servicio Tequila y Whisky' is currently attached to 8 products including two
-- HOT DOG COMBOS -- it is already functioning as the generic soda picker, so the
-- name is simply wrong. But bottle service and combos need different OPTION SETS,
-- not just different limits: Red Bull is excluded everywhere, and Limonada /
-- Naranjada ($39 vs $32 for cans) do not belong bundled into a $100 combo.
-- Per-attachment limits (032b) cannot express a subset, so separate groups are
-- the correct mechanism here.
--
--   Refresco Servicio    11 options, 1-4 repeatable  -> 3 bottle products
--   Refresco Individual   9 options, exactly 1       -> 2 combos, Rusa, 3 shots
--
-- The hardcoded combo sodas were already removed by 032 PART 1.
--
-- Depends on: 032b
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('032b') THEN
        RAISE EXCEPTION 'Migration 032b must be applied before 032c.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Bottle service keeps the wide pool, renamed for what it is
-- ---------------------------------------------------------------------------
UPDATE modifier_groups SET name = 'Refresco Servicio'
 WHERE btrim(name) = 'Servicio Tequila y Whisky';

-- ---------------------------------------------------------------------------
-- PART 2 — New group: pick exactly ONE soda
-- ---------------------------------------------------------------------------
INSERT INTO modifier_groups
  (id, name, is_mandatory, min_selections, max_selections, allow_multiple, split_modifier_qty)
SELECT gen_random_uuid()::varchar, 'Refresco Individual', true, 1, 1, false, false
 WHERE NOT EXISTS (SELECT 1 FROM modifier_groups WHERE btrim(name) = 'Refresco Individual');

-- Option names deliberately match the inventory item names exactly, so the rule
-- join below is unambiguous. Red Bull, Limonada and Naranjada are excluded.
INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_active)
SELECT gen_random_uuid()::varchar, g.id, v.n, 0, true
  FROM modifier_groups g,
       (VALUES ('Coca Cola'),('Coca Light'),('Sprite'),('Fanta'),('Fresca'),
               ('Manzanita'),('Agua Mineral'),('Agua Natural'),('Sin refresco')) AS v(n)
 WHERE btrim(g.name) = 'Refresco Individual'
   AND NOT EXISTS (SELECT 1 FROM modifiers m
                    WHERE m.modifier_group_id = g.id
                      AND lower(btrim(m.name)) = lower(btrim(v.n)));

UPDATE modifiers m SET deducts_no_inventory = true
  FROM modifier_groups g
 WHERE g.id = m.modifier_group_id AND btrim(g.name) = 'Refresco Individual'
   AND btrim(m.name) ILIKE 'Sin %' AND NOT m.deducts_no_inventory;

INSERT INTO modifier_inventory_rules (id, modifier_id, inventory_item_id, quantity)
SELECT gen_random_uuid()::varchar, m.id, i.id, 1
  FROM modifiers m
  JOIN modifier_groups g  ON g.id = m.modifier_group_id
                         AND btrim(g.name) = 'Refresco Individual'
  JOIN inventory_items i  ON lower(btrim(i.name)) = lower(btrim(m.name)) AND i.is_active
 WHERE m.is_active AND NOT m.deducts_no_inventory
   AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);

-- ---------------------------------------------------------------------------
-- PART 3 — Repoint combos, Rusa and the three shots
-- ---------------------------------------------------------------------------
INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
SELECT mi.id, g.id
  FROM menu_items mi, modifier_groups g
 WHERE btrim(g.name) = 'Refresco Individual'
   AND mi.is_active
   AND btrim(mi.name) IN ('Combo Dogo 1','Combo Dogo 2','Rusa',
                          'Tequila Blanco Shot','Tequila Cristalino Shot','Shot Whisky Red label')
   AND NOT EXISTS (SELECT 1 FROM menu_item_modifier_groups x
                    WHERE x.menu_item_id = mi.id AND x.modifier_group_id = g.id);

-- detach them from the bottle-service group and the retired Rusa group
DELETE FROM menu_item_modifier_groups mg
 USING modifier_groups g, menu_items mi
 WHERE g.id = mg.modifier_group_id AND mi.id = mg.menu_item_id
   AND btrim(g.name) IN ('Refresco Servicio','Rusa Refresco')
   AND btrim(mi.name) IN ('Combo Dogo 1','Combo Dogo 2','Rusa',
                          'Tequila Blanco Shot','Tequila Cristalino Shot','Shot Whisky Red label');

-- ---------------------------------------------------------------------------
-- PART 4 — Retire the 2-option Rusa group (deactivate; history references it)
-- ---------------------------------------------------------------------------
UPDATE modifiers m SET is_active = false
  FROM modifier_groups g
 WHERE g.id = m.modifier_group_id AND btrim(g.name) = 'Rusa Refresco' AND m.is_active;

UPDATE modifier_groups SET is_mandatory = false, name = 'Rusa Refresco (retirado)'
 WHERE btrim(name) = 'Rusa Refresco';

-- ---------------------------------------------------------------------------
-- PART 5 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('032c','soda_groups',
        'Refresco Servicio (1-4) + Refresco Individual (exactly 1). Red Bull excluded from both.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 6 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM modifiers m
      JOIN modifier_groups g ON g.id = m.modifier_group_id
     WHERE btrim(g.name) = 'Refresco Individual' AND m.is_active;
    IF n <> 9 THEN RAISE EXCEPTION '032c: % Refresco Individual options, expected 9', n; END IF;

    -- Red Bull must not be selectable in EITHER soda group
    IF EXISTS (SELECT 1 FROM modifiers m JOIN modifier_groups g ON g.id = m.modifier_group_id
               WHERE btrim(g.name) IN ('Refresco Servicio','Refresco Individual')
                 AND btrim(m.name) ILIKE 'Red Bull%' AND m.is_active) THEN
        RAISE EXCEPTION '032c: Red Bull must not be a soda-group option';
    END IF;

    -- combos and Rusa must have exactly ONE soda group each
    SELECT count(*) INTO n
      FROM menu_items mi
      JOIN menu_item_modifier_groups mg ON mg.menu_item_id = mi.id
      JOIN modifier_groups g ON g.id = mg.modifier_group_id
     WHERE btrim(mi.name) IN ('Combo Dogo 1','Combo Dogo 2','Rusa')
       AND btrim(g.name) LIKE 'Refresco%';
    IF n <> 3 THEN RAISE EXCEPTION '032c: expected 3 soda-group attachments on combos+Rusa, found %', n; END IF;

    SELECT count(*) INTO n FROM v_modifier_coverage_gaps;
    IF n <> 0 THEN RAISE EXCEPTION '032c: % coverage gaps', n; END IF;
    SELECT count(*) INTO n FROM v_recipe_modifier_overlap;
    IF n <> 0 THEN RAISE EXCEPTION '032c: % overlaps', n; END IF;

    RAISE NOTICE '032c OK -- Individual 9 opts, Servicio %, gaps 0, overlaps 0',
        (SELECT count(*) FROM modifiers m JOIN modifier_groups g ON g.id=m.modifier_group_id
          WHERE btrim(g.name)='Refresco Servicio' AND m.is_active);
END $$;

COMMIT;

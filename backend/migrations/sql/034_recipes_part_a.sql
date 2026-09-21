-- ============================================================================
-- 034_recipes_part_a.sql
-- Stage 7 — Ranch + the salchicha family
--
-- 'Salchicha botanera + Papa dorada' exists as BOTH a $154 menu item and an
-- inventory item, and the menu item consumes the inventory item of the same
-- name -- a finished plate modelled as stock. Same category error as
-- yields_item_id pointing at Agua Mineral.
--
-- Salchicha moves to gram tracking (300 g portions, editable later). A NEW item
-- is created rather than re-denominating 'Salchicha Cocktail': changing an
-- item's unit would put servings and grams in one quantity_after chain and
-- break 027's invariant.
--
-- Depends on: 032d
-- ============================================================================
BEGIN;

DO $$ BEGIN
    IF NOT _applied('032d') THEN RAISE EXCEPTION '032d must be applied before 034.'; END IF;
END $$;

-- PART 1 — Ranch Dressing -> existing Aderezo Ranch portion (95 in stock)
INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
SELECT gen_random_uuid()::varchar, mi.id, ii.id, 1, ii.base_unit_key
  FROM menu_items mi, inventory_items ii
 WHERE btrim(mi.name) = 'Ranch Dressing' AND mi.is_active
   AND btrim(ii.name) = 'Aderezo Ranch' AND ii.is_active
   AND NOT EXISTS (SELECT 1 FROM insumos_base b WHERE b.menu_item_id = mi.id);

-- PART 2 — Bulk salchicha in grams, portioned at 300 g
INSERT INTO inventory_items
  (id, name, unit, base_unit_key, stock_quantity, category, item_type, stock_nature,
   portion_size, portion_unit_key, is_active)
SELECT gen_random_uuid()::varchar, 'Salchicha Botanera (granel)', 'gramo', 'gramo',
       0, 'food', 'STANDARD', 'BULK', 300, 'gramo', true
 WHERE NOT EXISTS (SELECT 1 FROM inventory_items
                    WHERE btrim(name) = 'Salchicha Botanera (granel)');

-- PART 3 — All three dishes deduct grams from the one pool.
-- Keeping them on one item avoids two stock pools for one physical sausage,
-- which is the drift pattern this project exists to remove.
INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
SELECT gen_random_uuid()::varchar, mi.id, ii.id, 300, 'gramo'
  FROM (VALUES ('Salchicha Botanera'),
               ('Salchicha botanera + Papa dorada'),
               ('Platillo Botanero')) AS v(dish)
  JOIN menu_items mi ON btrim(mi.name) = v.dish AND mi.is_active
  JOIN inventory_items ii ON btrim(ii.name) = 'Salchicha Botanera (granel)'
 WHERE NOT EXISTS (SELECT 1 FROM insumos_base b
                    WHERE b.menu_item_id = mi.id AND b.inventory_item_id = ii.id);

-- Papa dorada on the $154 plate (Platillo Botanero already has one)
INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
SELECT gen_random_uuid()::varchar, mi.id, ii.id, 1, ii.base_unit_key
  FROM menu_items mi, inventory_items ii
 WHERE btrim(mi.name) = 'Salchicha botanera + Papa dorada' AND mi.is_active
   AND btrim(ii.name) = 'Papas Doradas Caseras' AND ii.is_active
   AND NOT EXISTS (SELECT 1 FROM insumos_base b
                    WHERE b.menu_item_id = mi.id AND b.inventory_item_id = ii.id);

-- PART 4 — Retire the superseded rows
DELETE FROM insumos_base b USING inventory_items ii
 WHERE ii.id = b.inventory_item_id
   AND btrim(ii.name) IN ('Salchicha Cocktail','Salchicha botanera + Papa dorada');

UPDATE inventory_items SET is_active = false
 WHERE btrim(name) IN ('Salchicha Cocktail','Salchicha botanera + Papa dorada')
   AND is_active;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('034','recipes_part_a','Ranch wired; salchicha moved to 300 g granel; dish-as-ingredient retired.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM insumos_base b JOIN menu_items mi ON mi.id=b.menu_item_id
                    WHERE btrim(mi.name)='Ranch Dressing') THEN
        RAISE EXCEPTION '034: Ranch Dressing still has no recipe';
    END IF;

    SELECT count(*) INTO n FROM insumos_base b
      JOIN menu_items mi ON mi.id=b.menu_item_id
      JOIN inventory_items ii ON ii.id=b.inventory_item_id
     WHERE btrim(ii.name)='Salchicha Botanera (granel)' AND b.quantity=300;
    IF n <> 3 THEN RAISE EXCEPTION '034: % dishes deduct 300g salchicha, expected 3', n; END IF;

    IF EXISTS (SELECT 1 FROM inventory_items
                WHERE btrim(name)='Salchicha botanera + Papa dorada' AND is_active) THEN
        RAISE EXCEPTION '034: dish-as-ingredient item still active';
    END IF;

    SELECT count(*) INTO n FROM v_recipe_modifier_overlap;
    IF n <> 0 THEN RAISE EXCEPTION '034: % overlaps introduced', n; END IF;

    RAISE NOTICE '034 OK -- Ranch wired, 3 dishes on 300g granel, legacy salchicha retired';
END $$;
COMMIT;

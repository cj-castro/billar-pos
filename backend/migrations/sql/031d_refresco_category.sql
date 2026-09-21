-- ============================================================================
-- 031d_refresco_category.sql
--
-- Three related fixes:
--  1. The 'mixer' inventory category is factually wrong for every item in it --
--     all of them are sold standalone as refrescos, and several are also cocktail
--     ingredients. Category should describe WHAT an item is, not how it is used;
--     usage is already expressed by insumos_base / modifier_inventory_rules.
--     One item, many consumption paths: Fresca alone feeds Paloma, Rusa, Combo
--     Dogo 1, standalone sales AND bottle service from one stock pool.
--  2. Fanta ($32) and Red bull ($69) are sellable menu items with ZERO recipe
--     rows -- they deduct nothing at all. A third leak class, distinct from
--     missing modifier rules.
--  3. Damage charges and income lines legitimately have no recipe. Without a
--     flag they pollute coverage reporting forever.
--
-- Depends on: 031c
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('031c') THEN
        RAISE EXCEPTION 'Migration 031c must be applied before 031d.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — 'mixer' describes usage, not identity
-- ---------------------------------------------------------------------------
UPDATE inventory_items SET category = 'refresco' WHERE category = 'mixer';

-- ---------------------------------------------------------------------------
-- PART 2 — Make Fanta and Red bull actually deduct stock.
-- Both already exist as menu items; their inventory items were created in 031b.
-- Matching is lower(btrim(...)) because the menu item is 'Red bull' while the
-- inventory item is 'Red Bull' -- and because 'Red bull ' carried a trailing
-- space until 027b normalised it, which would otherwise have made this a
-- silent no-op.
-- ---------------------------------------------------------------------------
INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
SELECT gen_random_uuid()::varchar, mi.id, ii.id, 1, ii.base_unit_key
  FROM menu_items mi
  JOIN inventory_items ii ON lower(btrim(ii.name)) = lower(btrim(mi.name)) AND ii.is_active
 WHERE mi.is_active AND lower(btrim(mi.name)) IN ('fanta','red bull')
   AND NOT EXISTS (SELECT 1 FROM insumos_base b WHERE b.menu_item_id = mi.id);

-- ---------------------------------------------------------------------------
-- PART 3 — Non-product menu items
-- ---------------------------------------------------------------------------
ALTER TABLE menu_items
    ADD COLUMN IF NOT EXISTS tracks_inventory boolean NOT NULL DEFAULT true;

UPDATE menu_items mi SET tracks_inventory = false
  FROM menu_categories c
 WHERE c.id = mi.category_id
   AND btrim(c.name) IN ('Daños','INGRESOS','Promociones')
   AND mi.tracks_inventory;

COMMENT ON COLUMN menu_items.tracks_inventory IS
    'false = deliberately consumes no stock (damage charges, income lines). '
    'Keeps them out of recipe-coverage reporting.';

-- ---------------------------------------------------------------------------
-- PART 4 — Recipe coverage reporting.
-- has_modifier_coverage matters: Salsa Extra has no recipe but deducts via the
-- Wing Flavor modifier, so it is covered, not missing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_menu_items_without_recipe AS
SELECT c.name AS categoria, mi.id, mi.name, mi.price_cents,
       (SELECT count(*) FROM ticket_line_items li
         WHERE li.menu_item_id = mi.id AND li.status <> 'VOIDED') AS times_sold,
       EXISTS (SELECT 1 FROM menu_item_modifier_groups g
                JOIN modifiers m  ON m.modifier_group_id = g.modifier_group_id
                JOIN modifier_inventory_rules r ON r.modifier_id = m.id
               WHERE g.menu_item_id = mi.id AND m.is_active) AS has_modifier_coverage
  FROM menu_items mi LEFT JOIN menu_categories c ON c.id = mi.category_id
 WHERE mi.is_active AND mi.tracks_inventory
   AND NOT EXISTS (SELECT 1 FROM insumos_base b WHERE b.menu_item_id = mi.id)
 ORDER BY times_sold DESC;

-- ---------------------------------------------------------------------------
-- PART 5 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('031d','refresco_category',
        'mixer -> refresco; Fanta/Red bull recipes; tracks_inventory flag.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 6 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    IF EXISTS (SELECT 1 FROM inventory_items WHERE category = 'mixer') THEN
        RAISE EXCEPTION '031d: items still categorised as mixer';
    END IF;

    -- THE regression test for the trailing-space bug 027b fixed
    SELECT count(*) INTO n
      FROM insumos_base b JOIN menu_items mi ON mi.id = b.menu_item_id
     WHERE lower(btrim(mi.name)) IN ('fanta','red bull');
    IF n <> 2 THEN
        RAISE EXCEPTION '031d: % recipe rows for Fanta/Red bull, expected 2 '
            '(a trailing space in the menu item name would silently break this)', n;
    END IF;

    SELECT count(*) INTO n FROM inventory_items WHERE category = 'refresco';
    IF n < 12 THEN RAISE EXCEPTION '031d: % refresco items, expected >= 12', n; END IF;

    -- damage/income lines must be excluded from coverage reporting
    IF EXISTS (SELECT 1 FROM v_menu_items_without_recipe v
                JOIN menu_items mi ON mi.id = v.id
                JOIN menu_categories c ON c.id = mi.category_id
               WHERE btrim(c.name) IN ('Daños','INGRESOS','Promociones')) THEN
        RAISE EXCEPTION '031d: non-product categories still appear in coverage report';
    END IF;

    RAISE NOTICE '031d OK -- % refresco items, Fanta+Red bull deduct, % products still without recipe',
        (SELECT count(*) FROM inventory_items WHERE category='refresco'),
        (SELECT count(*) FROM v_menu_items_without_recipe);
END $$;

COMMIT;

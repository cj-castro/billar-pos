-- ============================================================================
-- 035b_sauce_production.sql
-- Sauces are pre-portioned into ramekins from 3.78 L (US gallon) bottles.
--
-- That is PRODUCTION, not conversion: auto-conversion would credit 84 ramekins
-- the instant portions hit zero WITHOUT anyone filling them. A bottle becomes
-- ramekins only when a human does the work, and the count they get is what it is.
--
-- Ramekin size inferred from current stock: portions cluster at 85-95, i.e.
-- roughly one bottle's worth, so 3780 / 88 ~= 43 ml. Using 45 ml -> 84 portions.
-- Bulk is tracked in ML (not whole bottles) so partial bottles stay visible.
-- Depends on: 035, 031b (portion_size)
-- ============================================================================
BEGIN;
DO $$ BEGIN
    IF NOT _applied('035') THEN RAISE EXCEPTION '035 must be applied before 035b.'; END IF;
END $$;

-- PART 1 — Bulk parent per sauce, purchased by the gallon, tracked in ml.
-- btrim() inside the concatenation: an untrimmed source name would produce
-- 'Aderezo Ranch  Bulk' with a double space, which would then fail to match on
-- re-run and create a SECOND bulk item.
INSERT INTO inventory_items
  (id, name, unit, base_unit_key, purchase_unit_key, purchase_pack_size,
   stock_quantity, category, item_type, stock_nature, portion_size, portion_unit_key, is_active)
SELECT gen_random_uuid()::varchar, btrim(i.name) || ' Bulk', 'ml', 'ml', 'botella', 3780,
       0, 'food', 'STANDARD', 'BULK', 45, 'ml', true
  FROM inventory_items i
 WHERE i.is_active AND i.base_unit_key = 'porcion'
   AND btrim(i.name) IN ('BBQ','Buffalo','Mango Habanero','Lemon Pepper','Parmesano',
                         'Hot Bbq','Tamarindo Habanero','Aderezo Ranch','Aderezo Catsup','Queso Extra')
   AND NOT EXISTS (SELECT 1 FROM inventory_items x
                    WHERE btrim(x.name) = btrim(i.name) || ' Bulk');

-- PART 2 — Production recipe: 1 gallon -> 84 ramekins
INSERT INTO production_recipes (id, output_item_id, expected_yield, yield_unit_key, variance_warn_pct, notes)
SELECT gen_random_uuid()::varchar, portion.id, 84, 'porcion', 10,
       'Botella 3.78 L (galon) a ramekins de 45 ml'
  FROM inventory_items portion
  JOIN inventory_items bulk ON btrim(bulk.name) = btrim(portion.name) || ' Bulk'
 WHERE portion.base_unit_key = 'porcion' AND portion.is_active
   AND NOT EXISTS (SELECT 1 FROM production_recipes p WHERE p.output_item_id = portion.id);

INSERT INTO production_recipe_inputs (id, production_recipe_id, input_item_id, quantity, unit_key)
SELECT gen_random_uuid()::varchar, p.id, bulk.id, 3780, 'ml'
  FROM production_recipes p
  JOIN inventory_items portion ON portion.id = p.output_item_id
  JOIN inventory_items bulk    ON btrim(bulk.name) = btrim(portion.name) || ' Bulk'
 WHERE NOT EXISTS (SELECT 1 FROM production_recipe_inputs x
                    WHERE x.production_recipe_id = p.id AND x.input_item_id = bulk.id);

INSERT INTO schema_migrations (version, name, notes)
VALUES ('035b','sauce_production','Bulk sauce in ml (gallon bottles) + production recipes at 84 ramekins.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM inventory_items WHERE btrim(name) LIKE '% Bulk' AND is_active;
    IF n <> 10 THEN RAISE EXCEPTION '035b: % bulk sauce items, expected 10', n; END IF;

    -- the concatenation bug: a double space means a duplicate was created
    SELECT count(*) INTO n FROM inventory_items WHERE name LIKE '%  Bulk';
    IF n <> 0 THEN RAISE EXCEPTION '035b: % double-space Bulk names (concat bug)', n; END IF;

    SELECT count(*) INTO n FROM production_recipes;
    IF n <> 10 THEN RAISE EXCEPTION '035b: % production recipes, expected 10', n; END IF;

    SELECT count(*) INTO n FROM production_recipe_inputs;
    IF n <> 10 THEN RAISE EXCEPTION '035b: % recipe inputs, expected 10', n; END IF;

    SELECT count(*) INTO n FROM inventory_items
     WHERE btrim(name) LIKE '% Bulk' AND stock_quantity <> 0;
    IF n <> 0 THEN RAISE EXCEPTION '035b: % bulk items have invented stock', n; END IF;

    RAISE NOTICE '035b OK -- 10 bulk sauces, 10 production recipes, all at 0 pending count';
END $$;
COMMIT;

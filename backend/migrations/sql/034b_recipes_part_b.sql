-- ============================================================================
-- 034b_recipes_part_b.sql
-- Stage 7 — Vodka + Curazao as bottle->shot pairs; Azulito
--
-- Azulito ($89, sold 67x) currently deducts NOTHING. It needs one shot each of
-- vodka and curazao plus a Sprite; neither spirit existed in inventory.
--
-- DELIBERATELY OMITTED: a clamato row for Vaso Michelado. It carries the
-- 'Sabor Michelada' group, which has deducted 150 ml of clamato since 031b, so
-- adding a recipe row would double-deduct -- the exact Rusa/Fresca pattern
-- removed in 032. Vaso Ruso gets nothing either (lime + salt, untracked by
-- decision; see 034e).
--
-- Depends on: 034
-- ============================================================================
BEGIN;

DO $$ BEGIN
    IF NOT _applied('034') THEN RAISE EXCEPTION '034 must be applied before 034b.'; END IF;
END $$;

-- PART 1 — Spirit items (0 stock, awaiting a physical count)
INSERT INTO inventory_items
  (id, name, unit, base_unit_key, stock_quantity, category, item_type, stock_nature, is_active)
SELECT gen_random_uuid()::varchar, v.n, v.u, v.bu, 0, 'spirit', 'STANDARD', v.sn, true
  FROM (VALUES
    ('Vodka Bottle',        'bottle', 'botella',   'CONVERTIBLE'),
    ('Vodka Shot',          'shot',   'caballito', 'DERIVED'),
    ('Curazao Azul Bottle', 'bottle', 'botella',   'CONVERTIBLE'),
    ('Curazao Azul Shot',   'shot',   'caballito', 'DERIVED')
  ) AS v(n,u,bu,sn)
 WHERE NOT EXISTS (SELECT 1 FROM inventory_items i
                    WHERE lower(btrim(i.name)) = lower(btrim(v.n)));

-- PART 2 — Conversions, 15 shots per bottle (same as the tequilas)
INSERT INTO inventory_conversions (id, from_item_id, to_item_id, ratio, conversion_type, notes)
SELECT gen_random_uuid()::varchar, f.id, t.id, 15, 'BOTTLE_TO_SHOT', v.note
  FROM (VALUES
    ('Vodka Bottle',        'Vodka Shot',        'Vodka: 15 shots/botella'),
    ('Curazao Azul Bottle', 'Curazao Azul Shot', 'Curazao: 15 shots/botella')
  ) AS v(fn, tn, note)
  JOIN inventory_items f ON btrim(f.name) = v.fn
  JOIN inventory_items t ON btrim(t.name) = v.tn
 WHERE NOT EXISTS (SELECT 1 FROM inventory_conversions c
                    WHERE c.from_item_id = f.id AND c.to_item_id = t.id);

-- PART 3 — Azulito = vodka shot + curazao shot + Sprite
INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
SELECT gen_random_uuid()::varchar, mi.id, ii.id, 1, ii.base_unit_key
  FROM menu_items mi
  JOIN (VALUES ('Vodka Shot'),('Curazao Azul Shot'),('Sprite')) AS v(item) ON true
  JOIN inventory_items ii ON btrim(ii.name) = v.item AND ii.is_active
 WHERE btrim(mi.name) = 'Azulito' AND mi.is_active
   AND NOT EXISTS (SELECT 1 FROM insumos_base b
                    WHERE b.menu_item_id = mi.id AND b.inventory_item_id = ii.id);

INSERT INTO schema_migrations (version, name, notes)
VALUES ('034b','recipes_part_b','Vodka + Curazao bottle/shot pairs; Azulito wired. Vaso Michelado left to its modifier.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM inventory_items
     WHERE btrim(name) IN ('Vodka Bottle','Vodka Shot','Curazao Azul Bottle','Curazao Azul Shot');
    IF n <> 4 THEN RAISE EXCEPTION '034b: % spirit items, expected 4', n; END IF;

    SELECT count(*) INTO n FROM insumos_base b JOIN menu_items mi ON mi.id=b.menu_item_id
     WHERE btrim(mi.name)='Azulito';
    IF n <> 3 THEN RAISE EXCEPTION '034b: Azulito has % ingredients, expected 3', n; END IF;

    -- Vaso Michelado must stay on its modifier only -- a recipe row here would
    -- double-deduct clamato
    SELECT count(*) INTO n FROM insumos_base b JOIN menu_items mi ON mi.id=b.menu_item_id
     WHERE btrim(mi.name)='Vaso Michelado';
    IF n <> 0 THEN
        RAISE EXCEPTION '034b: Vaso Michelado has % recipe rows -- clamato already comes from Sabor Michelada', n;
    END IF;

    SELECT count(*) INTO n FROM v_recipe_modifier_overlap;
    IF n <> 0 THEN RAISE EXCEPTION '034b: % overlaps introduced', n; END IF;

    RAISE NOTICE '034b OK -- 4 spirit items, 2 conversions, Azulito wired, 0 overlaps';
END $$;
COMMIT;

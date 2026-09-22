-- ============================================================================
-- 034c_recipes_final.sql
-- Stage 7 — Orphan retired, Gold Caja sellable, unit safety, cost propagation
--
-- unit_catalog carries NO conversion factors, so a recipe that deducts a unit
-- different from the item's base unit cannot be converted -- only silently
-- mis-scaled by orders of magnitude. All 96 rows currently match; a trigger
-- keeps it that way now that gram- and ml-tracked items exist.
--
-- Depends on: 034b
-- ============================================================================
BEGIN;

DO $$ BEGIN
    IF NOT _applied('034b') THEN RAISE EXCEPTION '034b must be applied before 034c.'; END IF;
END $$;

-- PART 0 — Repair unit labels edited on the POS after 2026-08-07.
--
-- These four items were relabelled in the admin UI to describe how they are
-- PURCHASED (a case of beer, a serving of wings) rather than how they are
-- STOCKED and SOLD. Nothing else moved: the recipes still deduct botella/pieza,
-- the restock history is still recorded in botella/pieza, and stock_quantity is
-- still a bottle/piece count. Only the label drifted.
--
-- unit_catalog carries no conversion factors, so this never mis-scaled the
-- arithmetic -- 1 is subtracted either way. It is corrected because the label
-- feeds reporting, purchase units, and 035b (which keys sauce production off
-- base_unit_key = 'porcion'), and because leaving it would trip the guard
-- installed in PART 3 on the next legitimate recipe edit.
--
-- Scoped by name AND by the exact wrong value, so this cannot touch an item
-- that is genuinely stocked by the case.
UPDATE inventory_items SET base_unit_key = 'botella'
 WHERE btrim(name) IN ('Corona','Indio','Tecate')
   AND base_unit_key = 'caja' AND is_active;

UPDATE inventory_items SET base_unit_key = 'pieza'
 WHERE btrim(name) = 'Alitas 700gr'
   AND base_unit_key = 'porcion' AND is_active;

-- PART 1 — Retire the orphan (used by nothing; deactivate, keep history)
UPDATE inventory_items SET is_active = false
 WHERE btrim(name) = 'Salchichas' AND is_active;

-- PART 2 — Marlboro Gold Caja: 29 packs were unsellable as packs
INSERT INTO menu_items (id, category_id, name, price_cents, requires_flavor, is_active, sort_order)
SELECT gen_random_uuid()::varchar, c.id, 'Marlboro Gold Caja', 14000, false, true, 50
  FROM menu_categories c
 WHERE btrim(c.name) = 'Cigarros'
   AND NOT EXISTS (SELECT 1 FROM menu_items WHERE btrim(name) = 'Marlboro Gold Caja');

INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
SELECT gen_random_uuid()::varchar, mi.id, ii.id, 1, ii.base_unit_key
  FROM menu_items mi, inventory_items ii
 WHERE btrim(mi.name) = 'Marlboro Gold Caja' AND mi.is_active
   AND btrim(ii.name) = 'Marlboro Gold' AND ii.is_active
   AND NOT EXISTS (SELECT 1 FROM insumos_base b WHERE b.menu_item_id = mi.id);

-- PART 3 — Recipes must deduct in the item's own base unit
CREATE OR REPLACE FUNCTION fn_recipe_unit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_base varchar(50);
BEGIN
    SELECT base_unit_key INTO v_base FROM inventory_items WHERE id = NEW.inventory_item_id;
    IF NEW.deduction_unit_key IS NOT NULL AND NEW.deduction_unit_key <> v_base THEN
        RAISE EXCEPTION 'UNIT MISMATCH: recipe deducts % but the item is stocked in %',
            NEW.deduction_unit_key, v_base
            USING HINT = 'unit_catalog has no conversion factors. Use the base unit.';
    END IF;
    NEW.deduction_unit_key := COALESCE(NEW.deduction_unit_key, v_base);
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_recipe_unit_guard ON insumos_base;
CREATE TRIGGER trg_recipe_unit_guard
    BEFORE INSERT OR UPDATE ON insumos_base
    FOR EACH ROW EXECUTE FUNCTION fn_recipe_unit_guard();

-- PART 4 — Cost propagation through conversions.
-- A $70 pack becoming 20 loose makes each loose cost $3.50. Without this,
-- converted stock has no cost basis and cigarette margin reads as 100%.
CREATE OR REPLACE FUNCTION fn_conversion_unit_cost(p_from_item varchar(36))
RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN c.ratio > 0
                THEN round(COALESCE(i.unit_cost_cents, 0) / c.ratio)::integer END
      FROM inventory_conversions c
      JOIN inventory_items i ON i.id = c.from_item_id
     WHERE c.from_item_id = p_from_item AND c.is_active LIMIT 1;
$$;

-- PART 5 — Coverage reporting + config
INSERT INTO settings (key, value) VALUES
    ('recipes.block_sale_without_recipe', 'false'),
    ('recipes.warn_on_zero_cost',         'true')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE VIEW v_recipe_coverage AS
SELECT c.name AS categoria, mi.name AS producto, mi.price_cents,
       (SELECT count(*) FROM insumos_base b WHERE b.menu_item_id = mi.id) AS ingredientes,
       EXISTS (SELECT 1 FROM menu_item_modifier_groups g
                JOIN modifiers m ON m.modifier_group_id = g.modifier_group_id
                JOIN modifier_inventory_rules r ON r.modifier_id = m.id
               WHERE g.menu_item_id = mi.id AND m.is_active) AS cubierto_por_modificador,
       (SELECT count(*) FROM ticket_line_items li
         WHERE li.menu_item_id = mi.id AND li.status <> 'VOIDED') AS vendido
  FROM menu_items mi LEFT JOIN menu_categories c ON c.id = mi.category_id
 WHERE mi.is_active AND mi.tracks_inventory
 ORDER BY 1, 2;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('034c','recipes_final','Salchichas retired; Gold Caja sellable; unit guard; cost propagation.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE n int; detail text;
BEGIN
    IF EXISTS (SELECT 1 FROM inventory_items WHERE btrim(name)='Salchichas' AND is_active) THEN
        RAISE EXCEPTION '034c: Salchichas orphan still active';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM insumos_base b JOIN menu_items mi ON mi.id=b.menu_item_id
                    WHERE btrim(mi.name)='Marlboro Gold Caja') THEN
        RAISE EXCEPTION '034c: Marlboro Gold Caja has no recipe';
    END IF;

    -- the unit guard must actually reject a cross-unit recipe
    BEGIN
        INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
        SELECT 'assert-034c', mi.id, ii.id, 1, 'kilogramo'
          FROM menu_items mi, inventory_items ii
         WHERE btrim(mi.name)='Marlboro Gold Caja' AND btrim(ii.name)='Cebolla' LIMIT 1;
        RAISE EXCEPTION '034c: unit guard did not reject a cross-unit recipe';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'UNIT MISMATCH%' THEN RAISE; END IF;
    END;

    SELECT count(*) INTO n FROM insumos_base b
      JOIN inventory_items ii ON ii.id = b.inventory_item_id
     WHERE b.deduction_unit_key IS DISTINCT FROM ii.base_unit_key;
    IF n <> 0 THEN
        -- Name the offenders. A bare count sends the operator digging at 1am.
        SELECT string_agg(format('%s/%s: recipe %s vs stock %s',
                                 btrim(mi.name), btrim(ii.name),
                                 b.deduction_unit_key, ii.base_unit_key), '; ')
          INTO detail
          FROM insumos_base b
          JOIN inventory_items ii ON ii.id = b.inventory_item_id
          JOIN menu_items mi      ON mi.id = b.menu_item_id
         WHERE b.deduction_unit_key IS DISTINCT FROM ii.base_unit_key;
        RAISE EXCEPTION '034c: % recipe rows have a unit mismatch -- %', n, detail;
    END IF;

    RAISE NOTICE '034c OK -- Gold Caja sellable, unit guard active, 0 unit mismatches';
END $$;
COMMIT;

-- ============================================================================
-- 032_variant_availability.sql
-- Stage 5 — Option-level availability; the parent product stays sellable
--
-- Root cause of "RUSA blocks the whole item when one flavour is out of stock":
-- the Rusa recipe contains Fresca AND its mandatory Rusa Refresco modifier also
-- deducts Fresca. So Fresca is deducted TWICE when chosen, and deducted anyway
-- when Mineral is chosen -- which means Rusa becomes unsellable whenever Fresca
-- hits zero, regardless of which flavour the customer picks.
--
-- The fix is a DELETION, not new logic: 'Rusa Refresco' is mandatory with
-- min=max=1, so exactly one soda is always selected and the modifier fully
-- covers it. The recipe row is pure duplication in every possible order.
--
-- Depends on: 029b (which stops init-db STEP 16 resurrecting the deleted row),
--             031 (deducts_no_inventory)
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('029b') THEN
        RAISE EXCEPTION '029b MUST be applied before 032. Without it, init-db STEP 16 '
                        're-inserts the Rusa/Fresca row on the next backend restart '
                        'and this fix silently reverts.';
    END IF;
    IF NOT _applied('031') THEN
        RAISE EXCEPTION '031 must be applied before 032.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Remove ALL recipe/modifier double-deductions.
--
-- Three products hardcode a specific soda in their recipe while ALSO offering a
-- soda modifier group:
--   Rusa         -> Fresca     (Rusa Refresco, mandatory min=max=1)
--   Combo Dogo 1 -> Fresca     (Servicio group)
--   Combo Dogo 2 -> Manzanita  (Servicio group)
--
-- The combos were latent until 031/031c wired up the mixer rules -- before that
-- the group deducted nothing, so only the hardcoded soda came out and the
-- customer's actual choice was ignored. That is also a third contributor to
-- Fresca sitting at 5 while comparable sodas are at 24-30: every Combo Dogo 1
-- took Fresca regardless of what was actually served.
--
-- Deleting the recipe row is safe in all three cases because the soda group is
-- attached, so the customer's selection always supplies exactly one soda.
-- ---------------------------------------------------------------------------
-- Two further families surfaced when this ran against live POS data. They are
-- the same bug, not new ones, and are listed explicitly rather than deleted by
-- a generic "recipe overlaps modifier" rule -- an optional 'Extra X' modifier
-- SHOULD stack on top of a recipe row, so a blanket delete would be wrong.
--
--   Rusa         -> Agua Mineral  the Fresca row above has a twin; 'Rusa
--                                 Refresco' is min=max=1, so whichever soda is
--                                 picked is already deducted by the modifier.
--   Cubeta Premium -> Corona      'Cubeta Premium'/'Cubeta Regular' are
--   Cubeta Regular -> Indio,      min=max=10 with allow_multiple, so the ten
--                     Tecate,     selections already account for every beer in
--                     Tecate      the bucket. The recipe rows deduct one MORE
--                     Light,      of each listed beer on top: a Cubeta Regular
--                     XX Ambar,   was taking 15 beers out of stock per sale
--                     XX Lager    instead of 10.
DELETE FROM insumos_base b
 USING menu_items mi, inventory_items ii
 WHERE b.menu_item_id = mi.id AND ii.id = b.inventory_item_id
   AND ( (btrim(mi.name) = 'Rusa'         AND btrim(ii.name) = 'Fresca')
      OR (btrim(mi.name) = 'Combo Dogo 1' AND btrim(ii.name) = 'Fresca')
      OR (btrim(mi.name) = 'Combo Dogo 2' AND btrim(ii.name) = 'Manzanita')
      OR (btrim(mi.name) = 'Rusa'         AND btrim(ii.name) = 'Agua Mineral')
      OR (btrim(mi.name) = 'Cubeta Cerveza Premium (10 beers)'
          AND btrim(ii.name) = 'Corona')
      OR (btrim(mi.name) = 'Cubeta Cerveza Regular (10 beers)'
          AND btrim(ii.name) IN ('Indio','Tecate','Tecate Light',
                                 'XX Ambar','XX Lager')) );

-- ---------------------------------------------------------------------------
-- PART 2 — Prevent the pattern from returning.
-- Any item deducted by BOTH a recipe and a modifier on the same product is a
-- double-deduction. Target: zero rows, reported nightly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_recipe_modifier_overlap AS
SELECT mi.id AS menu_item_id, mi.name AS producto, ii.name AS insumo,
       b.quantity AS recipe_qty, g.name AS grupo, m.name AS opcion, r.quantity AS modifier_qty
  FROM menu_items mi
  JOIN insumos_base b               ON b.menu_item_id = mi.id
  JOIN menu_item_modifier_groups mg ON mg.menu_item_id = mi.id
  JOIN modifier_groups g            ON g.id = mg.modifier_group_id
  JOIN modifiers m                  ON m.modifier_group_id = g.id AND m.is_active
  JOIN modifier_inventory_rules r   ON r.modifier_id = m.id
                                   AND r.inventory_item_id = b.inventory_item_id
  JOIN inventory_items ii           ON ii.id = b.inventory_item_id
 WHERE mi.is_active;

COMMENT ON VIEW v_recipe_modifier_overlap IS
    'Items deducted by BOTH recipe and modifier on the same product = double '
    'deduction. Caught Rusa/Fresca on 2026-08-07. Target: 0 rows.';

-- ---------------------------------------------------------------------------
-- PART 3 — Per-option availability.
-- DISPLAY ONLY: takes no locks and reserves nothing. Authoritative enforcement
-- stays in check_stock_for_item, which locks rows in ascending id order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_option_availability(
    p_menu_item_id varchar(36), p_quantity int DEFAULT 1)
RETURNS TABLE (
    group_id varchar(36), group_name varchar(100), is_mandatory boolean,
    min_selections int, max_selections int, allow_multiple boolean,
    modifier_id varchar(36), modifier_name varchar(100),
    max_units numeric, is_available boolean, limiting_item varchar(100))
LANGUAGE sql STABLE AS $$
WITH recipe_need AS (
    SELECT b.inventory_item_id, sum(b.quantity) * p_quantity AS need
      FROM insumos_base b WHERE b.menu_item_id = p_menu_item_id GROUP BY 1),
remaining AS (
    SELECT i.id, GREATEST(i.stock_quantity - COALESCE(rn.need, 0), 0) AS avail
      FROM inventory_items i
      LEFT JOIN recipe_need rn ON rn.inventory_item_id = i.id)
SELECT g.id, g.name, g.is_mandatory, g.min_selections, g.max_selections, g.allow_multiple,
       m.id, m.name,
       CASE WHEN m.deducts_no_inventory THEN 9999
            ELSE COALESCE(min(floor(rem.avail / NULLIF(r.quantity,0) / p_quantity)), 9999)
       END,
       CASE WHEN m.deducts_no_inventory THEN true
            ELSE COALESCE(min(floor(rem.avail / NULLIF(r.quantity,0) / p_quantity)), 9999) >= 1
       END,
       (array_agg(ii.name ORDER BY floor(rem.avail / NULLIF(r.quantity,0)) NULLS LAST))[1]
  FROM menu_item_modifier_groups mg
  JOIN modifier_groups g ON g.id = mg.modifier_group_id
  JOIN modifiers m       ON m.modifier_group_id = g.id AND m.is_active
  LEFT JOIN modifier_inventory_rules r ON r.modifier_id = m.id
  LEFT JOIN remaining rem              ON rem.id = r.inventory_item_id
  LEFT JOIN inventory_items ii         ON ii.id = r.inventory_item_id
 WHERE mg.menu_item_id = p_menu_item_id
 GROUP BY g.id, g.name, g.is_mandatory, g.min_selections, g.max_selections,
          g.allow_multiple, m.id, m.name, m.deducts_no_inventory;
$$;

-- ---------------------------------------------------------------------------
-- PART 4 — Product-level rollup.
-- allow_multiple matters: Cubeta Premium needs 10 selections WITH repetition, so
-- availability is the SUM of beer units across options, not "at least one option
-- in stock".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_product_availability(
    p_menu_item_id varchar(36), p_quantity int DEFAULT 1)
RETURNS TABLE (is_sellable boolean, blocking_reason text, blocking_detail text)
LANGUAGE plpgsql STABLE AS $$
DECLARE r record; v_short text;
BEGIN
    SELECT string_agg(ii.name || ' (' || i.stock_quantity || '/' ||
                      (b.quantity * p_quantity) || ')', ', ') INTO v_short
      FROM insumos_base b
      JOIN inventory_items i  ON i.id = b.inventory_item_id
      JOIN inventory_items ii ON ii.id = b.inventory_item_id
     WHERE b.menu_item_id = p_menu_item_id
       AND i.stock_quantity < b.quantity * p_quantity;

    IF v_short IS NOT NULL THEN
        RETURN QUERY SELECT false, 'INGREDIENT_OUT_OF_STOCK', v_short; RETURN;
    END IF;

    FOR r IN
        SELECT group_name, min_selections, allow_multiple,
               count(*) FILTER (WHERE is_available) AS options_available,
               sum(max_units)                       AS total_units
          FROM fn_option_availability(p_menu_item_id, p_quantity)
         WHERE is_mandatory
         GROUP BY group_name, min_selections, allow_multiple
    LOOP
        IF r.allow_multiple THEN
            IF COALESCE(r.total_units,0) < r.min_selections THEN
                RETURN QUERY SELECT false, 'GROUP_INSUFFICIENT_UNITS',
                    format('%s: %s de %s unidades', r.group_name,
                           COALESCE(r.total_units,0), r.min_selections);
                RETURN;
            END IF;
        ELSE
            IF r.options_available < r.min_selections THEN
                RETURN QUERY SELECT false, 'GROUP_NO_OPTIONS',
                    format('%s: %s de %s opciones con stock', r.group_name,
                           r.options_available, r.min_selections);
                RETURN;
            END IF;
        END IF;
    END LOOP;

    RETURN QUERY SELECT true, NULL::text, NULL::text;
END $$;

-- ---------------------------------------------------------------------------
-- PART 5 — Configuration
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('availability.low_stock_badge_qty',        '5'),
    ('availability.show_unavailable_options',   'true'),
    ('availability.block_parent_on_group_empty','true')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 6 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('032','variant_availability',
        'Rusa double-deduction removed; option-level availability engine.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 7 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM v_recipe_modifier_overlap;
    IF n <> 0 THEN RAISE EXCEPTION '032: % recipe/modifier overlaps remain', n; END IF;

    -- Rusa must no longer have ANY recipe row for a soda: both its sodas are
    -- supplied by the mandatory 'Rusa Refresco' group.
    IF EXISTS (SELECT 1 FROM insumos_base b
                JOIN menu_items mi ON mi.id = b.menu_item_id
                JOIN inventory_items ii ON ii.id = b.inventory_item_id
               WHERE btrim(mi.name) = 'Rusa'
                 AND btrim(ii.name) IN ('Fresca','Agua Mineral')) THEN
        RAISE EXCEPTION '032: Rusa still deducts a soda via its recipe';
    END IF;

    -- A Cubeta must take exactly its 10 selected beers, never a recipe row too.
    IF EXISTS (SELECT 1 FROM insumos_base b
                JOIN menu_items mi ON mi.id = b.menu_item_id
               WHERE btrim(mi.name) IN ('Cubeta Cerveza Premium (10 beers)',
                                        'Cubeta Cerveza Regular (10 beers)')) THEN
        RAISE EXCEPTION '032: a Cubeta still deducts beer via its recipe';
    END IF;

    -- the availability engine must answer for Rusa without erroring
    PERFORM * FROM fn_product_availability(
        (SELECT id FROM menu_items WHERE btrim(name) = 'Rusa' AND is_active LIMIT 1), 1);

    RAISE NOTICE '032 OK -- overlaps 0, Rusa recipe cleaned, availability engine live';
END $$;

COMMIT;

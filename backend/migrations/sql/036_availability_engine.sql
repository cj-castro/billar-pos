-- ============================================================================
-- 036_availability_engine.sql
-- Stage 9 — One availability answer across direct / conversion / portion / production
--
-- Key distinction: production capacity must NOT count as available. Auto-
-- convertible parents (a pack, a bottle) need no human, so they count. Sauce
-- bottles need someone to fill ramekins, so counting them would let a waiter
-- sell 84 portions that do not physically exist. Hence two numbers.
-- Depends on: 035b
-- ============================================================================
BEGIN;
DO $$ BEGIN
    IF NOT _applied('035b') THEN RAISE EXCEPTION '035b must be applied before 036.'; END IF;
END $$;

CREATE OR REPLACE FUNCTION fn_effective_available(p_item varchar(36))
RETURNS TABLE (available_now numeric, available_with_prep numeric, sources jsonb)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_now numeric := 0; v_prep numeric := 0; v_src jsonb := '[]'::jsonb; r record;
BEGIN
    FOR r IN
        WITH RECURSIVE up AS (
            SELECT i.id AS item_id, i.name, i.stock_quantity AS qty, 1::numeric AS factor, 0 AS depth
              FROM inventory_items i WHERE i.id = p_item
            UNION ALL
            SELECT src.id, src.name, src.stock_quantity,
                   u.factor * c.ratio * (1 - c.loss_factor), u.depth + 1
              FROM up u
              JOIN inventory_conversions c ON c.to_item_id = u.item_id
                                          AND c.is_active AND c.is_automatic
              JOIN inventory_items src ON src.id = c.from_item_id AND src.is_active
             WHERE u.depth < 5)
        SELECT item_id, name, qty, factor, depth FROM up
    LOOP
        v_now := v_now + (r.qty * r.factor);
        v_src := v_src || jsonb_build_object(
            'item_id', r.item_id, 'name', r.name, 'stock', r.qty, 'factor', r.factor,
            'contributes', r.qty * r.factor, 'depth', r.depth,
            'kind', CASE WHEN r.depth = 0 THEN 'own' ELSE 'convertible' END);
    END LOOP;

    SELECT COALESCE(min(floor(i.stock_quantity / ri.quantity)) * p.expected_yield, 0)
      INTO v_prep
      FROM production_recipes p
      JOIN production_recipe_inputs ri ON ri.production_recipe_id = p.id
      JOIN inventory_items i ON i.id = ri.input_item_id
     WHERE p.output_item_id = p_item AND p.is_active AND ri.quantity > 0
     GROUP BY p.expected_yield;

    RETURN QUERY SELECT v_now, v_now + COALESCE(v_prep, 0), v_src;
END $$;

COMMENT ON FUNCTION fn_effective_available IS
    'available_now includes auto-convertible parents. available_with_prep adds '
    'production capacity, which needs a human and must NOT gate a sale. Advisory: '
    'takes no locks and reserves nothing -- check_stock_for_item remains authoritative.';

CREATE OR REPLACE FUNCTION fn_menu_item_max_sellable(p_menu_item varchar(36))
RETURNS TABLE (max_sellable integer, limiting_factor text, limiting_item text)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_max integer := 999; r record; v_avail numeric; v_can integer;
        v_kind text; v_item text;
BEGIN
    FOR r IN SELECT b.inventory_item_id, b.quantity, ii.name
               FROM insumos_base b JOIN inventory_items ii ON ii.id = b.inventory_item_id
              WHERE b.menu_item_id = p_menu_item AND b.quantity > 0
    LOOP
        SELECT a.available_now INTO v_avail FROM fn_effective_available(r.inventory_item_id) a;
        v_can := floor(v_avail / r.quantity)::integer;
        IF v_can < v_max THEN v_max := v_can; v_kind := 'INGREDIENT'; v_item := r.name; END IF;
    END LOOP;

    FOR r IN SELECT o.group_name, o.min_selections, o.allow_multiple,
                    count(*) FILTER (WHERE o.is_available) AS opts,
                    sum(o.max_units) AS units
               FROM fn_option_availability(p_menu_item, 1) o
              WHERE o.is_mandatory
              GROUP BY o.group_name, o.min_selections, o.allow_multiple
    LOOP
        IF r.allow_multiple THEN
            v_can := floor(COALESCE(r.units,0) / GREATEST(r.min_selections,1))::integer;
        ELSE
            v_can := CASE WHEN r.opts >= r.min_selections THEN 999 ELSE 0 END;
        END IF;
        IF v_can < v_max THEN v_max := v_can; v_kind := 'MODIFIER_GROUP'; v_item := r.group_name; END IF;
    END LOOP;

    IF v_max = 999 THEN v_kind := NULL; v_item := NULL; END IF;
    RETURN QUERY SELECT GREATEST(v_max,0), v_kind, v_item;
END $$;

-- Hard oversell backstop. A trigger, not a CHECK, so it follows the same
-- off/warn/block ladder: stock counts are still being corrected and a hard
-- failure mid-service is worse than a logged warning.
INSERT INTO settings (key, value) VALUES ('inventory.negative_stock_mode','warn')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION fn_prevent_negative_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_mode text;
BEGIN
    IF NEW.stock_quantity >= 0 THEN RETURN NEW; END IF;
    SELECT COALESCE(lower(value),'warn') INTO v_mode
      FROM settings WHERE key='inventory.negative_stock_mode';
    IF v_mode = 'block' THEN
        RAISE EXCEPTION 'NEGATIVE STOCK blocked: % would go to %', NEW.name, NEW.stock_quantity
            USING HINT = 'Oversell prevented. Verify the physical count.';
    ELSIF v_mode = 'warn' THEN
        INSERT INTO ledger_violations
            (violation_type, source, inventory_item_id, expected_value, actual_value, context)
        VALUES ('NEGATIVE_STOCK','TRIGGER', NEW.id, 0, NEW.stock_quantity,
                jsonb_build_object('item_name', NEW.name, 'tg_op', TG_OP,
                                   'previous', CASE WHEN TG_OP='UPDATE'
                                                    THEN OLD.stock_quantity END));
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_prevent_negative_stock ON inventory_items;
CREATE TRIGGER trg_prevent_negative_stock
    BEFORE INSERT OR UPDATE OF stock_quantity ON inventory_items
    FOR EACH ROW EXECUTE FUNCTION fn_prevent_negative_stock();

CREATE OR REPLACE VIEW v_menu_availability AS
SELECT c.name AS categoria, mi.id AS menu_item_id, mi.name AS producto,
       mi.price_cents, s.max_sellable, s.limiting_factor, s.limiting_item,
       (s.max_sellable = 0) AS agotado
  FROM menu_items mi
  LEFT JOIN menu_categories c ON c.id = mi.category_id
  CROSS JOIN LATERAL fn_menu_item_max_sellable(mi.id) s
 WHERE mi.is_active AND mi.tracks_inventory
 ORDER BY (s.max_sellable = 0) DESC, c.name, mi.name;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('036','availability_engine','Effective availability across all 4 mechanisms + negative-stock guard.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE v_now numeric; v_prep numeric; v_own numeric; v_conv numeric;
        v_item varchar(36); n int;
BEGIN
    -- Loose cigarettes must include pack-equivalents.
    --
    -- Previously this asserted "> 250", a magnitude taken from one snapshot's
    -- stock. That tests inventory levels, not the recursion: a bar that is
    -- simply low on cigarettes fails it, while a genuinely broken CTE passes it
    -- whenever loose stock alone clears the bar. Anchor to what the data says
    -- the answer should be instead, so the test means the same thing at any
    -- stock level. Resolved by name -- a hardcoded UUID does not survive a
    -- rebuilt database.
    SELECT id, stock_quantity INTO v_item, v_own
      FROM inventory_items WHERE btrim(name) = 'Marlboro Blanco Suelto' AND is_active;
    IF v_item IS NULL THEN RAISE EXCEPTION '036: Marlboro Blanco Suelto not found'; END IF;

    IF NOT EXISTS (SELECT 1 FROM inventory_conversions c
                    WHERE c.to_item_id = v_item AND c.is_active AND c.is_automatic) THEN
        RAISE EXCEPTION '036: no active automatic pack->loose conversion into Blanco';
    END IF;

    SELECT COALESCE(sum(f.stock_quantity * c.ratio * (1 - c.loss_factor)), 0) INTO v_conv
      FROM inventory_conversions c
      JOIN inventory_items f ON f.id = c.from_item_id AND f.is_active
     WHERE c.to_item_id = v_item AND c.is_active AND c.is_automatic;

    SELECT a.available_now INTO v_now FROM fn_effective_available(v_item) a;
    IF v_now <> v_own + v_conv THEN
        RAISE EXCEPTION '036: loose Blanco shows %, expected own % + pack equivalents % = %',
            v_now, v_own, v_conv, v_own + v_conv;
    END IF;

    -- A sauce portion must EXCLUDE bottle capacity from available_now.
    -- Compared against the item's own stock plus any automatic conversions
    -- (none, for a sauce) rather than a fixed 85: if production capacity ever
    -- leaks into available_now, this fires regardless of how much sauce is on
    -- hand.
    SELECT id, stock_quantity INTO v_item, v_own
      FROM inventory_items WHERE btrim(name) = 'BBQ' AND is_active;
    IF v_item IS NULL THEN RAISE EXCEPTION '036: BBQ not found'; END IF;

    SELECT COALESCE(sum(f.stock_quantity * c.ratio * (1 - c.loss_factor)), 0) INTO v_conv
      FROM inventory_conversions c
      JOIN inventory_items f ON f.id = c.from_item_id AND f.is_active
     WHERE c.to_item_id = v_item AND c.is_active AND c.is_automatic;

    SELECT a.available_now, a.available_with_prep INTO v_now, v_prep
      FROM fn_effective_available(v_item) a;
    IF v_now <> v_own + v_conv THEN
        RAISE EXCEPTION '036: BBQ available_now is %, expected % -- production capacity leaked into available_now',
            v_now, v_own + v_conv;
    END IF;
    IF v_prep < v_now THEN
        RAISE EXCEPTION '036: BBQ available_with_prep % is below available_now %', v_prep, v_now;
    END IF;

    SELECT count(*) INTO n FROM v_menu_availability;
    IF n = 0 THEN RAISE EXCEPTION '036: availability board is empty'; END IF;

    RAISE NOTICE '036 OK -- board has % products, % agotados',
        n, (SELECT count(*) FROM v_menu_availability WHERE agotado);
END $$;
COMMIT;

-- ============================================================================
-- 040_bottle_conversion_fixes.sql
-- Inventory review 2026-11-24, batch 1: make inventory_conversions the single
-- source of truth for bottle -> shot, and make conversions carry cost.
--
-- THE BUGS THIS FIXES
--
-- 1. Two yield configurations disagreed. Auto-conversion (fn_ensure_available)
--    reads inventory_conversions; the manual "Abrir botella" button read
--    inventory_items.yields_item_id / shots_per_bottle. In the data:
--      * Whisky Red Label Bottle yielded "Agua Mineral" (opening one added 15
--        mineral waters and no whisky shots);
--      * Tequila Blanco SHOT was flagged item_type BOTTLE yielding Tequila
--        Blanco BOTTLE -- the inverse conversion. Opening it on 2026-07-30 took
--        Tequila Blanco Bottle from 4 to 19 (15 phantom bottles, still on the
--        books -- this migration does NOT touch stock; a physical count must);
--      * Curazao Azul / Vodka Bottle had no yield at all, so they could never be
--        opened manually while spirits auto-convert is off.
--    The application's open_bottle() now calls fn_convert_stock(), and this
--    migration mirrors the conversion onto the legacy columns so the inventory
--    screen (which still displays them) shows the truth.
--
-- 2. fn_convert_stock() moved quantity but never cost. Shots created by a
--    conversion kept whatever unit_cost_cents the shot item already had (0 in
--    practice), so every converted shot sold at $0 COGS. fn_conversion_unit_cost
--    existed but nothing called it. Cost now moves with the stock.
--
-- 3. fn_convert_stock() looked its conversion up by from_item_id LIMIT 1 while
--    fn_ensure_available() looked it up by to_item_id. With two active
--    conversions on one parent they could pick different rows. A partial unique
--    index now allows at most one active conversion per parent, which makes
--    both lookups agree by construction.
--
-- 4. Shots only exist by opening a bottle. Shot / loose-cigarette items
--    (stock_nature DERIVED) may never go below zero, whatever
--    inventory.negative_stock_mode says. (The app also refuses RESTOCK and
--    upward adjustments on them; see inventory_svc._assert_no_increase_without_opening.)
--
-- Stock quantities are NOT modified. Every metadata change is written to
-- audit_log with action MIGRATION_040_ITEM_FIX (before/after JSON).
--
-- Depends on: 001 (squashed baseline, which contains 027..039)
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('001') THEN
        RAISE EXCEPTION '001 (baseline) must be applied before 040.';
    END IF;
END $$;

SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- PART 1 — At most one active conversion per parent item
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_offenders text;
BEGIN
    SELECT string_agg(i.name || ' (' || x.n || ')', ', ')
      INTO v_offenders
      FROM (SELECT from_item_id, count(*) AS n
              FROM inventory_conversions WHERE is_active
             GROUP BY from_item_id HAVING count(*) > 1) x
      JOIN inventory_items i ON i.id = x.from_item_id;
    IF v_offenders IS NOT NULL THEN
        RAISE EXCEPTION '040: items with more than one active conversion: %. '
                        'Deactivate the extra rows (is_active=false) and re-run.', v_offenders;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_one_active_per_source
    ON inventory_conversions (from_item_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- PART 2 — fn_convert_stock: carry weighted-average cost from parent to child
--
-- Same signature as before (fn_open_pack and fn_ensure_available call it), so
-- CREATE OR REPLACE swaps the body in place without creating an overload.
--
-- p_units parents at the parent's WAC become v_created children, so the child's
-- new WAC is (old_qty*old_wac + p_units*parent_wac) / (old_qty + v_created),
-- or simply (p_units*parent_wac)/v_created when the child had no stock. That is
-- the same formula as inventory_svc._compute_wac, rounded half-up the same way.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_convert_stock(
    p_from_item character varying,
    p_units     numeric,
    p_user      character varying,
    p_reference character varying DEFAULT NULL::character varying,
    p_reason    text DEFAULT NULL::text)
RETURNS TABLE(from_new_stock numeric, to_item character varying,
              to_new_stock numeric, units_created numeric)
LANGUAGE plpgsql
AS $$
DECLARE c record;
        v_from numeric;  v_from_wac integer;
        v_to_old numeric; v_to_wac_old integer;
        v_to numeric;    v_to_wac integer;
        v_created numeric;
BEGIN
    IF p_units <= 0 THEN
        RAISE EXCEPTION 'units must be positive, got %', p_units;
    END IF;

    -- uq_conv_one_active_per_source guarantees at most one row here
    SELECT * INTO c FROM inventory_conversions
     WHERE from_item_id = p_from_item AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active conversion defined for item %', p_from_item;
    END IF;

    -- lock both sides, lowest id first, matching inventory_svc's lock order
    PERFORM 1 FROM inventory_items
      WHERE id IN (p_from_item, c.to_item_id) ORDER BY id FOR UPDATE;

    SELECT stock_quantity, COALESCE(unit_cost_cents, 0)
      INTO v_from, v_from_wac
      FROM inventory_items WHERE id = p_from_item;
    IF v_from < p_units THEN
        RAISE EXCEPTION 'INSUFFICIENT_SOURCE: % has %, need %', p_from_item, v_from, p_units;
    END IF;

    v_created := floor(p_units * c.ratio * (1 - c.loss_factor));
    IF v_created <= 0 THEN
        RAISE EXCEPTION 'CONVERSION_YIELDS_ZERO: % unit(s) of % produce nothing (ratio %, loss %)',
            p_units, p_from_item, c.ratio, c.loss_factor;
    END IF;

    SELECT stock_quantity, COALESCE(unit_cost_cents, 0)
      INTO v_to_old, v_to_wac_old
      FROM inventory_items WHERE id = c.to_item_id;

    IF v_to_old <= 0 THEN
        v_to_wac := round((p_units * v_from_wac) / v_created)::integer;
    ELSE
        v_to_wac := round((v_to_old * v_to_wac_old + p_units * v_from_wac)
                          / (v_to_old + v_created))::integer;
    END IF;

    v_from := v_from - p_units;
    v_to   := v_to_old + v_created;

    UPDATE inventory_items SET stock_quantity = v_from, updated_at = clock_timestamp()
     WHERE id = p_from_item;
    INSERT INTO inventory_movements
       (id, inventory_item_id, event_type, quantity_delta, quantity_after,
        unit_cost_cents, reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, p_from_item, 'CONVERSION_OUT', -p_units, v_from,
            v_from_wac, p_reference,
            COALESCE(p_reason, format('Conversion %s -> %s', p_units, v_created)),
            p_user, clock_timestamp());

    UPDATE inventory_items SET stock_quantity = v_to, unit_cost_cents = v_to_wac,
                               updated_at = clock_timestamp()
     WHERE id = c.to_item_id;
    INSERT INTO inventory_movements
       (id, inventory_item_id, event_type, quantity_delta, quantity_after,
        unit_cost_cents, reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, c.to_item_id, 'CONVERSION_IN', v_created, v_to,
            v_to_wac, p_reference,
            COALESCE(p_reason, format('Desde %s x %s', p_units, c.conversion_type)),
            p_user, clock_timestamp());

    RETURN QUERY SELECT v_from, c.to_item_id, v_to, v_created;
END $$;

-- ---------------------------------------------------------------------------
-- PART 3 — Mirror BOTTLE_TO_SHOT conversions onto the legacy display columns
-- ---------------------------------------------------------------------------

-- 3a. Every active bottle->shot parent becomes item_type BOTTLE with the
--     conversion's ratio and target. (Fixes Red Label -> Agua Mineral and gives
--     Curazao / Vodka a yield.) Non-integer ratios are left alone: the column is
--     integer and rounding a yield would misstate it.
WITH fix AS (
    SELECT i.id,
           json_build_object('item_type', i.item_type,
                             'shots_per_bottle', i.shots_per_bottle,
                             'yields_item_id', i.yields_item_id,
                             'yields_item_name', (SELECT y.name FROM inventory_items y
                                                   WHERE y.id = i.yields_item_id)) AS before_state,
           c.ratio::integer AS new_spb,
           c.to_item_id     AS new_yield,
           t.name           AS new_yield_name
      FROM inventory_items i
      JOIN inventory_conversions c ON c.from_item_id = i.id
                                  AND c.is_active
                                  AND c.conversion_type = 'BOTTLE_TO_SHOT'
      JOIN inventory_items t ON t.id = c.to_item_id
     WHERE c.ratio = trunc(c.ratio)
       AND (i.item_type, i.shots_per_bottle, i.yields_item_id)
           IS DISTINCT FROM ('BOTTLE'::varchar, c.ratio::integer, c.to_item_id)
), upd AS (
    UPDATE inventory_items i
       SET item_type        = 'BOTTLE',
           shots_per_bottle = f.new_spb,
           yields_item_id   = f.new_yield,
           updated_at       = clock_timestamp()
      FROM fix f
     WHERE i.id = f.id
    RETURNING i.id
)
INSERT INTO audit_log (user_id, action, entity_type, entity_id,
                       before_state, after_state, reason, created_at)
SELECT NULL, 'MIGRATION_040_ITEM_FIX', 'inventory_item', f.id,
       f.before_state,
       json_build_object('item_type', 'BOTTLE', 'shots_per_bottle', f.new_spb,
                         'yields_item_id', f.new_yield, 'yields_item_name', f.new_yield_name),
       '040: yield aligned with inventory_conversions (BOTTLE_TO_SHOT)',
       clock_timestamp()
  FROM fix f JOIN upd u ON u.id = f.id;

-- 3b. Anything still flagged BOTTLE that is NOT a bottle->shot parent loses the
--     flag and its stale yield, so the "Abrir botella" button stops appearing on
--     it. (Fixes Tequila Blanco Shot -> Tequila Blanco Bottle.)
WITH fix AS (
    SELECT i.id,
           json_build_object('item_type', i.item_type,
                             'shots_per_bottle', i.shots_per_bottle,
                             'yields_item_id', i.yields_item_id,
                             'yields_item_name', (SELECT y.name FROM inventory_items y
                                                   WHERE y.id = i.yields_item_id)) AS before_state
      FROM inventory_items i
     WHERE i.item_type = 'BOTTLE'
       AND NOT EXISTS (SELECT 1 FROM inventory_conversions c
                        WHERE c.from_item_id = i.id AND c.is_active
                          AND c.conversion_type = 'BOTTLE_TO_SHOT')
), upd AS (
    UPDATE inventory_items i
       SET item_type        = 'STANDARD',
           shots_per_bottle = NULL,
           yields_item_id   = NULL,
           updated_at       = clock_timestamp()
      FROM fix f
     WHERE i.id = f.id
    RETURNING i.id
)
INSERT INTO audit_log (user_id, action, entity_type, entity_id,
                       before_state, after_state, reason, created_at)
SELECT NULL, 'MIGRATION_040_ITEM_FIX', 'inventory_item', f.id,
       f.before_state,
       json_build_object('item_type', 'STANDARD', 'shots_per_bottle', NULL,
                         'yields_item_id', NULL),
       '040: flagged BOTTLE but is not the source of any bottle->shot conversion',
       clock_timestamp()
  FROM fix f JOIN upd u ON u.id = f.id;

-- 3c. stock_nature follows the conversion: the bottle/box is CONVERTIBLE, the
--     shot/loose item is DERIVED. PART 5's guard keys off DERIVED.
UPDATE inventory_items i SET stock_nature = 'DERIVED', updated_at = clock_timestamp()
  FROM inventory_conversions c
 WHERE c.to_item_id = i.id AND c.is_active
   AND c.conversion_type IN ('BOTTLE_TO_SHOT', 'PACK_TO_LOOSE')
   AND i.stock_nature IS DISTINCT FROM 'DERIVED';

UPDATE inventory_items i SET stock_nature = 'CONVERTIBLE', updated_at = clock_timestamp()
  FROM inventory_conversions c
 WHERE c.from_item_id = i.id AND c.is_active
   AND c.conversion_type IN ('BOTTLE_TO_SHOT', 'PACK_TO_LOOSE')
   AND i.stock_nature IS DISTINCT FROM 'CONVERTIBLE';

-- ---------------------------------------------------------------------------
-- PART 3d — A shot (or loose cigarette) that does not exist cannot be sold
--
-- inventory.negative_stock_mode = 'warn' lets most items dip below zero and
-- logs a violation. For DERIVED items that would mean selling shots no opened
-- bottle contains, so they are blocked in every mode. The application already
-- refuses these sales; this is the backstop for any path that does not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_prevent_negative_stock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_mode text;
BEGIN
    IF NEW.stock_quantity >= 0 THEN RETURN NEW; END IF;

    IF NEW.stock_nature = 'DERIVED' THEN
        RAISE EXCEPTION 'NEGATIVE STOCK blocked: % would go to % (open a bottle/box first)',
            NEW.name, NEW.stock_quantity
            USING HINT = 'Shots and loose cigarettes only exist once their bottle/box is opened.';
    END IF;

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

-- ---------------------------------------------------------------------------
-- PART 4 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('040', 'bottle_conversion_fixes',
        'Conversions carry WAC; one active conversion per source; '
        'bottle yield columns mirrored from inventory_conversions.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM inventory_items i
     WHERE i.item_type = 'BOTTLE'
       AND NOT EXISTS (SELECT 1 FROM inventory_conversions c
                        WHERE c.from_item_id = i.id AND c.is_active
                          AND c.conversion_type = 'BOTTLE_TO_SHOT');
    IF n > 0 THEN RAISE EXCEPTION '040: % BOTTLE item(s) without a conversion remain', n; END IF;

    SELECT count(*) INTO n FROM inventory_items i
      JOIN inventory_conversions c ON c.from_item_id = i.id AND c.is_active
                                  AND c.conversion_type = 'BOTTLE_TO_SHOT'
     WHERE c.ratio = trunc(c.ratio)
       AND (i.yields_item_id IS DISTINCT FROM c.to_item_id
            OR i.shots_per_bottle IS DISTINCT FROM c.ratio::integer);
    IF n > 0 THEN RAISE EXCEPTION '040: % bottle(s) still disagree with their conversion', n; END IF;

    -- Not fatal, but these rows can no longer move until counted: any update
    -- that leaves them below zero is now refused by fn_prevent_negative_stock.
    FOR n IN SELECT 1 FROM inventory_items WHERE stock_nature = 'DERIVED' AND stock_quantity < 0 LOOP
        RAISE WARNING '040: DERIVED items with negative stock exist -- count them (Ajuste por conteo fisico): %',
            (SELECT string_agg(name || '=' || stock_quantity, ', ')
               FROM inventory_items WHERE stock_nature = 'DERIVED' AND stock_quantity < 0);
        EXIT;
    END LOOP;
END $$;

DO $done$ BEGIN RAISE NOTICE '040_bottle_conversion_fixes: OK'; END $done$;

COMMIT;

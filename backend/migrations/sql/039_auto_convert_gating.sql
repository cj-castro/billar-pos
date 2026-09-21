-- ============================================================================
-- 039_auto_convert_gating.sql
-- Stage 6 — Split the auto-conversion gate by conversion type.
--
-- THE BUG THIS FIXES
--
-- 033 gated fn_ensure_available() on a single setting named
-- 'cigarettes.auto_convert_enabled'. But every active conversion is flagged
-- is_automatic, and only three of the eight are cigarettes:
--
--     PACK_TO_LOOSE   Marlboro Blanco / Gold / Rojo          (3)
--     BOTTLE_TO_SHOT  Tequila Blanco / Cristalino, Whisky
--                     Red Label, Vodka, Curazao Azul         (5)
--
-- So flipping the cigarette flag would also start auto-opening tequila, whisky
-- and vodka bottles mid-sale. Opening a bottle is a real decision with real
-- consequences -- an opened bottle cannot be returned to the supplier and its
-- shots expire against the bar's own shrinkage. It must not happen as a side
-- effect of a setting whose name says "cigarettes".
--
-- The two mechanisms also become trustworthy at different times: cigarette
-- packs need one physical count, whereas the spirit items were created at
-- stock 0 by 034b and have no counts at all yet.
--
-- After this migration the gate is chosen by conversion_type, so each half of
-- the ladder flips independently. The old key keeps working for PACK_TO_LOOSE,
-- so nothing that already references it changes meaning.
--
-- Depends on: 038
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('038') THEN RAISE EXCEPTION '038 must be applied before 039.'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — One setting per conversion family, both shipping disabled
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('cigarettes.auto_convert_enabled', 'false'),   -- PACK_TO_LOOSE  (pre-existing)
    ('spirits.auto_convert_enabled',    'false')    -- BOTTLE_TO_SHOT (new)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 2 — Resolve the gate for a given conversion type
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_auto_convert_enabled(p_conversion_type varchar(30))
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(lower(s.value) = 'true', false)
      FROM settings s
     WHERE s.key = CASE p_conversion_type
                       WHEN 'PACK_TO_LOOSE'  THEN 'cigarettes.auto_convert_enabled'
                       WHEN 'BOTTLE_TO_SHOT' THEN 'spirits.auto_convert_enabled'
                       ELSE 'inventory.auto_convert_unknown_type'
                   END;
$$;

COMMENT ON FUNCTION fn_auto_convert_enabled IS
    'Per-family gate. An unrecognised conversion_type resolves to a key that is '
    'deliberately never seeded, so new conversion families default to DISABLED '
    'rather than silently inheriting someone else''s permission.';

-- ---------------------------------------------------------------------------
-- PART 3 — Rewrite fn_ensure_available to consult the per-type gate.
--
-- Signature and return value are unchanged (source units consumed, 0 = none),
-- so no caller needs to change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ensure_available(
    p_item varchar(36), p_needed numeric, p_user varchar(36),
    p_reference varchar(36) DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE v_have numeric; v_deficit numeric; c record; v_units numeric;
BEGIN
    -- Lock the child first. The caller (inventory_svc) has already locked every
    -- row this transaction will touch, parents included, in ascending id order,
    -- so re-taking this lock is free and cannot deadlock.
    SELECT stock_quantity INTO v_have FROM inventory_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND THEN RETURN 0; END IF;
    IF v_have >= p_needed THEN RETURN 0; END IF;          -- loose stock covers it

    SELECT * INTO c FROM inventory_conversions
     WHERE to_item_id = p_item AND is_active AND is_automatic LIMIT 1;
    IF NOT FOUND THEN RETURN 0; END IF;                   -- caller reports shortage

    -- The gate is now per family, not one flag for everything.
    IF NOT fn_auto_convert_enabled(c.conversion_type) THEN RETURN 0; END IF;

    v_deficit := p_needed - v_have;
    v_units   := ceil(v_deficit / (c.ratio * (1 - c.loss_factor)));

    -- Do not open a parent that does not exist. Without this the conversion
    -- raises mid-sale instead of letting the caller report a clean shortage.
    IF (SELECT stock_quantity FROM inventory_items WHERE id = c.from_item_id) < v_units THEN
        RETURN 0;
    END IF;

    PERFORM fn_convert_stock(c.from_item_id, v_units, p_user, p_reference,
                             'Conversion automatica por venta');
    RETURN v_units;
END $$;

COMMENT ON FUNCTION fn_ensure_available IS
    'Materialises child units from an automatic parent when stock runs short. '
    'Gated per conversion family by fn_auto_convert_enabled(). Returns 0 and '
    'leaves the shortage to the caller when disabled, when no automatic '
    'conversion exists, or when the parent itself is short.';

-- ---------------------------------------------------------------------------
-- PART 4 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('039','auto_convert_gating',
        'Gate split: cigarettes.auto_convert_enabled (PACK_TO_LOOSE) vs spirits.auto_convert_enabled (BOTTLE_TO_SHOT). Parent-stock guard added.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    -- Both gates must ship closed.
    IF fn_auto_convert_enabled('PACK_TO_LOOSE') THEN
        RAISE EXCEPTION '039: PACK_TO_LOOSE gate must ship disabled';
    END IF;
    IF fn_auto_convert_enabled('BOTTLE_TO_SHOT') THEN
        RAISE EXCEPTION '039: BOTTLE_TO_SHOT gate must ship disabled';
    END IF;

    -- An unknown family must never inherit permission from another.
    IF fn_auto_convert_enabled('SOMETHING_NEW') THEN
        RAISE EXCEPTION '039: unknown conversion types must default to disabled';
    END IF;

    -- Every active automatic conversion must map to a real gate, or it is
    -- unreachable and the operator would have no way to switch it on.
    SELECT count(*) INTO n FROM inventory_conversions
     WHERE is_active AND is_automatic
       AND conversion_type NOT IN ('PACK_TO_LOOSE','BOTTLE_TO_SHOT');
    IF n <> 0 THEN
        RAISE EXCEPTION '039: % automatic conversion(s) have no gate mapping', n;
    END IF;

    -- With both gates closed, nothing converts. Proves the wiring is inert
    -- on arrival rather than assuming it.
    SELECT count(*) INTO n FROM inventory_conversions c
     WHERE c.is_active AND c.is_automatic
       AND fn_ensure_available(c.to_item_id, 999999, NULL) <> 0;
    IF n <> 0 THEN
        RAISE EXCEPTION '039: % conversion(s) fired while disabled', n;
    END IF;

    SELECT count(*) INTO n FROM inventory_conversions
     WHERE is_active AND is_automatic AND conversion_type = 'BOTTLE_TO_SHOT';
    RAISE NOTICE '039 OK -- gates split, both closed, % bottle conversions no longer ride the cigarette flag', n;
END $$;

COMMIT;

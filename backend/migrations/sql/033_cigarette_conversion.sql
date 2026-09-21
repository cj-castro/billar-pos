-- ============================================================================
-- 033_cigarette_conversion.sql
-- Stage 6 — Pack<->loose as ledger transactions; retire the parallel counter
--
-- Diagnosis: the conversion mechanism was ABANDONED, not merely buggy. No box has
-- been opened in the system since 2026-05-14, yet loose cigarettes kept selling
-- through August -- Marlboro Rojo Suelto was restocked directly four times. So
-- packs and loose have been two DISCONNECTED stock pools: someone physically
-- opens a pack, the system never decrements it, and loose is topped up by hand.
--
-- Design rule: consume loose first; if none, convert 1 pack -> N loose, consume 1,
-- keep N-1 -- each step a DISTINCT movement. N is per item (20/20/14).
--
-- Ships with cigarettes.auto_convert_enabled = false: the pack counts are not
-- trustworthy (Marlboro Blanco Caja reads 378 after a +361 adjustment that was
-- applied to BOTH the pack and loose items on 2026-05-21) and must be established
-- by a physical count first.
--
-- Depends on: 029 (inventory_conversions, movement_event_types)
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('029') THEN
        RAISE EXCEPTION 'Migration 029 must be applied before 033.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Atomic conversion: two movements, both stock rows updated.
-- Uses clock_timestamp() (not now(), which is transaction-constant) and relies
-- on 027's seq column for ordering when several movements land in one txn.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_convert_stock(
    p_from_item varchar(36), p_units numeric, p_user varchar(36),
    p_reference varchar(36) DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS TABLE (from_new_stock numeric, to_item varchar(36),
               to_new_stock numeric, units_created numeric)
LANGUAGE plpgsql AS $$
DECLARE c record; v_from numeric; v_to numeric; v_created numeric;
BEGIN
    IF p_units <= 0 THEN
        RAISE EXCEPTION 'units must be positive, got %', p_units;
    END IF;

    SELECT * INTO c FROM inventory_conversions
     WHERE from_item_id = p_from_item AND is_active LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active conversion defined for item %', p_from_item;
    END IF;

    -- lock both sides, lowest id first, matching check_stock_for_item's order
    PERFORM 1 FROM inventory_items
      WHERE id IN (p_from_item, c.to_item_id) ORDER BY id FOR UPDATE;

    SELECT stock_quantity INTO v_from FROM inventory_items WHERE id = p_from_item;
    IF v_from < p_units THEN
        RAISE EXCEPTION 'INSUFFICIENT_SOURCE: % has %, need %', p_from_item, v_from, p_units;
    END IF;

    v_created := floor(p_units * c.ratio * (1 - c.loss_factor));
    v_from    := v_from - p_units;
    SELECT stock_quantity + v_created INTO v_to FROM inventory_items WHERE id = c.to_item_id;

    UPDATE inventory_items SET stock_quantity = v_from, updated_at = clock_timestamp()
     WHERE id = p_from_item;
    INSERT INTO inventory_movements
       (id, inventory_item_id, event_type, quantity_delta, quantity_after,
        reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, p_from_item, 'CONVERSION_OUT', -p_units, v_from,
            p_reference, COALESCE(p_reason, format('Conversion %s -> %s', p_units, v_created)),
            p_user, clock_timestamp());

    UPDATE inventory_items SET stock_quantity = v_to, updated_at = clock_timestamp()
     WHERE id = c.to_item_id;
    INSERT INTO inventory_movements
       (id, inventory_item_id, event_type, quantity_delta, quantity_after,
        reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, c.to_item_id, 'CONVERSION_IN', v_created, v_to,
            p_reference, COALESCE(p_reason, format('Desde %s x %s', p_units, c.conversion_type)),
            p_user, clock_timestamp());

    RETURN QUERY SELECT v_from, c.to_item_id, v_to, v_created;
END $$;

-- ---------------------------------------------------------------------------
-- PART 2 — Convert-on-demand. Called BEFORE the sale deduction, never merged
-- with it, so the three movements stay individually auditable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ensure_available(
    p_item varchar(36), p_needed numeric, p_user varchar(36),
    p_reference varchar(36) DEFAULT NULL)
RETURNS numeric      -- source units consumed; 0 = no conversion required
LANGUAGE plpgsql AS $$
DECLARE v_have numeric; v_deficit numeric; c record; v_units numeric; v_enabled text;
BEGIN
    SELECT COALESCE(lower(value),'false') INTO v_enabled
      FROM settings WHERE key = 'cigarettes.auto_convert_enabled';
    IF v_enabled <> 'true' THEN RETURN 0; END IF;

    SELECT stock_quantity INTO v_have FROM inventory_items WHERE id = p_item FOR UPDATE;
    IF v_have >= p_needed THEN RETURN 0; END IF;          -- loose first

    SELECT * INTO c FROM inventory_conversions
     WHERE to_item_id = p_item AND is_active AND is_automatic LIMIT 1;
    IF NOT FOUND THEN RETURN 0; END IF;                   -- caller reports shortage

    v_deficit := p_needed - v_have;
    v_units   := ceil(v_deficit / (c.ratio * (1 - c.loss_factor)));

    PERFORM fn_convert_stock(c.from_item_id, v_units, p_user, p_reference,
                             'Conversion automatica por venta');
    RETURN v_units;
END $$;

COMMENT ON FUNCTION fn_ensure_available IS
    'Gated by cigarettes.auto_convert_enabled so it stays inert until a physical '
    'count establishes trustworthy pack quantities.';

-- ---------------------------------------------------------------------------
-- PART 3 — Retire the parallel counter.
-- 7 rows, all finished, 0 currently open -- nothing in flight, so this is safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cigarette_box_history AS
SELECT o.id, i.name AS box_item, o.brand, o.cigs_per_box, o.cigs_sold,
       (o.cigs_sold > o.cigs_per_box)  AS oversold,
       (o.cigs_sold - o.cigs_per_box)  AS oversold_by,
       o.opened_at, o.finished_at, u.name AS opened_by_name
  FROM open_cigarette_boxes o
  JOIN inventory_items i ON i.id = o.box_item_id
  LEFT JOIN users u ON u.id = o.opened_by;

COMMENT ON TABLE open_cigarette_boxes IS
    'DEPRECATED (033). Superseded by inventory_conversions + CONVERSION_OUT/IN '
    'movements. Unused since 2026-05-14. Read-only via v_cigarette_box_history; '
    'the 2 oversold rows are frozen pre-cutover history by decision.';

CREATE OR REPLACE FUNCTION fn_block_cig_box_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'open_cigarette_boxes is deprecated (033).'
        USING HINT = 'Use fn_open_pack_fifo() / fn_ensure_available() instead.';
END $$;

DROP TRIGGER IF EXISTS trg_block_cig_box_insert ON open_cigarette_boxes;
CREATE TRIGGER trg_block_cig_box_insert
    BEFORE INSERT ON open_cigarette_boxes
    FOR EACH ROW EXECUTE FUNCTION fn_block_cig_box_insert();

-- ---------------------------------------------------------------------------
-- PART 4 — Configuration + reconciliation
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('cigarettes.auto_convert_enabled', 'false'),
    ('cigarettes.baseline_counted_at',  ''),
    ('conversions.require_baseline',    'true')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE VIEW v_cigarette_reconciliation AS
SELECT b.name AS pack_item, b.stock_quantity AS packs,
       s.name AS loose_item, s.stock_quantity AS loose,
       c.ratio AS per_pack,
       (b.stock_quantity * c.ratio + s.stock_quantity) AS total_cigarettes_equiv,
       (SELECT max(created_at)::date FROM inventory_movements m
         WHERE m.inventory_item_id = b.id
           AND m.event_type IN ('CONVERSION_OUT','BOX_OPENING')) AS last_pack_opened
  FROM inventory_conversions c
  JOIN inventory_items b ON b.id = c.from_item_id
  JOIN inventory_items s ON s.id = c.to_item_id
 WHERE c.conversion_type = 'PACK_TO_LOOSE';

-- ---------------------------------------------------------------------------
-- PART 5 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('033','cigarette_conversion',
        'fn_convert_stock + fn_ensure_available. open_cigarette_boxes retired. auto_convert=false.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 6 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM v_cigarette_reconciliation;
    IF n <> 3 THEN RAISE EXCEPTION '033: % pack/loose pairs, expected 3', n; END IF;

    -- history preserved, including the two oversold boxes
    SELECT count(*) INTO n FROM v_cigarette_box_history WHERE oversold;
    IF n <> 2 THEN RAISE EXCEPTION '033: % oversold historical boxes, expected 2', n; END IF;

    -- must ship disabled
    IF (SELECT lower(value) FROM settings WHERE key='cigarettes.auto_convert_enabled') <> 'false' THEN
        RAISE EXCEPTION '033: auto_convert must ship disabled until a physical count';
    END IF;

    -- and be inert while disabled
    IF fn_ensure_available('211e924e-53d5-4204-a33c-bdf665561d3f', 999999,
                           (SELECT id FROM users WHERE role='ADMIN' LIMIT 1)) <> 0 THEN
        RAISE EXCEPTION '033: fn_ensure_available acted while disabled';
    END IF;

    RAISE NOTICE '033 OK -- 3 pack/loose pairs, 2 oversold boxes preserved, auto_convert off';
END $$;

COMMIT;

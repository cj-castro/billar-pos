-- ============================================================================
-- 033b_pack_open_and_baseline.sql
--
-- Two distinct triggers for the same three-movement ledger flow:
--   explicit  -- a bartender opens a pack at the counter (operator decides)
--   automatic -- loose hits 0 mid-sale (fn_ensure_available, 033)
--
-- fn_open_pack is deliberately NOT gated by cigarettes.auto_convert_enabled: the
-- operator is physically holding the pack, so their action is authoritative even
-- before the baseline count lands.
--
-- Also adds fn_count_adjustment, the generic physical-count helper used to
-- establish trustworthy baselines for all ~28 items awaiting a count.
--
-- Depends on: 033
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('033') THEN
        RAISE EXCEPTION 'Migration 033 must be applied before 033b.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Operator-initiated pack opening
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_open_pack(
    p_pack_item varchar(36), p_user varchar(36), p_packs numeric DEFAULT 1,
    p_reference varchar(36) DEFAULT NULL)
RETURNS TABLE (packs_remaining numeric, loose_item varchar(36),
               loose_total numeric, loose_added numeric)
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
    IF p_packs <= 0 THEN RAISE EXCEPTION 'packs must be positive'; END IF;

    SELECT * INTO r FROM fn_convert_stock(
        p_pack_item, p_packs, p_user, p_reference,
        format('Apertura manual de %s cajetilla(s)', p_packs));

    RETURN QUERY SELECT r.from_new_stock, r.to_item, r.to_new_stock, r.units_created;
END $$;

COMMENT ON FUNCTION fn_open_pack IS
    'Explicit pack opening. Unlike fn_ensure_available it is not tied to a sale, so '
    'the full pack contents land in loose stock immediately. One-way: once opened a '
    'pack cannot be sold as a pack.';

-- Opening is a transformation, not a value reduction -> no manager PIN.
-- Reversing one DOES require a grant (INVENTORY.CONVERSION_REVERSE below).
INSERT INTO authorized_actions
 (action_code, description_es, category, min_role, requires_pin, requires_reason,
  reduces_value, increases_inventory)
VALUES
 ('INVENTORY.PACK_OPEN','Abrir cajetilla','INVENTORY','WAITER',false,false,false,false),
 ('INVENTORY.CONVERSION_REVERSE','Revertir apertura de botella/caja','INVENTORY','MANAGER',
  true,true,false,true)
ON CONFLICT (action_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 2 — Generic physical-count helper.
-- Writes a COUNT_ADJUSTMENT movement so each correction is attributable rather
-- than silently overwriting stock -- which is what keeps 027's invariant intact
-- while the ~28 pending baselines are established.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_count_adjustment(
    p_item varchar(36), p_counted numeric, p_user varchar(36), p_note text DEFAULT NULL)
RETURNS numeric      -- the delta applied; 0 when the count already matched
LANGUAGE plpgsql AS $$
DECLARE v_current numeric; v_delta numeric;
BEGIN
    IF p_counted < 0 THEN RAISE EXCEPTION 'counted quantity cannot be negative'; END IF;

    SELECT stock_quantity INTO v_current FROM inventory_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown inventory item %', p_item; END IF;

    v_delta := p_counted - v_current;
    IF v_delta = 0 THEN RETURN 0; END IF;

    UPDATE inventory_items SET stock_quantity = p_counted, updated_at = clock_timestamp()
     WHERE id = p_item;

    INSERT INTO inventory_movements
       (id, inventory_item_id, event_type, quantity_delta, quantity_after,
        reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, p_item, 'COUNT_ADJUSTMENT', v_delta, p_counted,
            COALESCE(p_note, 'Conteo fisico'), p_user, clock_timestamp());

    RETURN v_delta;
END $$;

-- ---------------------------------------------------------------------------
-- PART 3 — Count sheets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cigarette_count_sheet AS
SELECT i.id, i.name, i.item_type,
       i.stock_quantity AS system_says,
       CASE i.item_type WHEN 'CIG_BOX' THEN 'contar cajetillas SELLADAS'
                        ELSE 'contar cigarros SUELTOS' END AS count_unit,
       c.ratio AS cigs_per_pack
  FROM inventory_items i
  LEFT JOIN inventory_conversions c
         ON c.from_item_id = i.id AND c.conversion_type = 'PACK_TO_LOOSE'
 WHERE i.item_type IN ('CIG_BOX','CIG_SINGLE') AND i.is_active
 ORDER BY i.item_type, i.name;

-- Everything awaiting a baseline: zero-stock items that are already sellable,
-- plus anything low enough to block a dish.
CREATE OR REPLACE VIEW v_items_pending_count AS
SELECT i.id, i.name, i.unit, i.stock_quantity, i.category,
       CASE WHEN i.stock_quantity = 0 THEN 'EN CERO - bloqueara ventas'
            WHEN i.stock_quantity <= 2 THEN 'muy bajo'
            ELSE 'revisar' END AS motivo,
       EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.inventory_item_id = i.id)
         AS usado_por_modificador,
       EXISTS (SELECT 1 FROM insumos_base b WHERE b.inventory_item_id = i.id)
         AS usado_por_receta
  FROM inventory_items i
 WHERE i.is_active
   AND (i.stock_quantity <= 2 OR i.item_type IN ('CIG_BOX','CIG_SINGLE'))
 ORDER BY i.stock_quantity, i.name;

-- ---------------------------------------------------------------------------
-- PART 4 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('033b','pack_open_and_baseline',
        'fn_open_pack + fn_count_adjustment + count sheets. PACK_OPEN/CONVERSION_REVERSE actions.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int; v_delta numeric;
BEGIN
    SELECT count(*) INTO n FROM v_cigarette_count_sheet;
    IF n <> 6 THEN RAISE EXCEPTION '033b: % cigarette items on the count sheet, expected 6', n; END IF;

    IF NOT EXISTS (SELECT 1 FROM authorized_actions WHERE action_code='INVENTORY.PACK_OPEN') THEN
        RAISE EXCEPTION '033b: PACK_OPEN action not registered';
    END IF;

    -- reversing a conversion must require a manager PIN and a reason
    IF NOT EXISTS (SELECT 1 FROM authorized_actions
                    WHERE action_code='INVENTORY.CONVERSION_REVERSE'
                      AND requires_pin AND requires_reason AND increases_inventory) THEN
        RAISE EXCEPTION '033b: CONVERSION_REVERSE must require PIN + reason';
    END IF;

    -- fn_count_adjustment must be a no-op when the count already matches
    SELECT fn_count_adjustment(i.id, i.stock_quantity,
             (SELECT id FROM users WHERE role='ADMIN' LIMIT 1), 'assertion no-op')
      INTO v_delta
      FROM inventory_items i WHERE i.is_active LIMIT 1;
    IF v_delta <> 0 THEN
        RAISE EXCEPTION '033b: fn_count_adjustment wrote a movement for an unchanged count';
    END IF;

    RAISE NOTICE '033b OK -- 6 cigarette items, % items pending a count',
        (SELECT count(*) FROM v_items_pending_count);
END $$;

COMMIT;

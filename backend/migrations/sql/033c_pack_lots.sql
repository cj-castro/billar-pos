-- ============================================================================
-- 033c_pack_lots.sql
--
-- Pack contents vary by delivery: Marlboro is normally 20/pack but 14-packs are
-- sold in Mexico (Gold is already configured as 14). A single per-item ratio
-- cannot express "this delivery came as 14s", so contents belong to the DELIVERY,
-- not the item.
--
-- Same mechanism generalises to any bulk intake with variable pack size -- e.g.
-- salchicha packages of differing weight in Stage 7.
--
-- Depends on: 033b
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('033b') THEN
        RAISE EXCEPTION 'Migration 033b must be applied before 033c.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Lots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_pack_lots (
    id                  varchar(36)   PRIMARY KEY,
    inventory_item_id   varchar(36)   NOT NULL REFERENCES inventory_items(id),
    units_per_pack      numeric(12,4) NOT NULL,
    packs_received      numeric(12,4) NOT NULL,
    packs_remaining     numeric(12,4) NOT NULL,
    received_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
    received_by         varchar(36)   REFERENCES users(id),
    restock_movement_id varchar(36),
    unit_cost_cents     integer,
    notes               text,
    CONSTRAINT ck_lot_units_positive  CHECK (units_per_pack > 0),
    CONSTRAINT ck_lot_received_positive CHECK (packs_received > 0),
    CONSTRAINT ck_lot_remaining_range CHECK (packs_remaining >= 0
                                        AND packs_remaining <= packs_received)
);

CREATE INDEX IF NOT EXISTS idx_pack_lots_fifo
    ON inventory_pack_lots (inventory_item_id, received_at)
 WHERE packs_remaining > 0;

COMMENT ON TABLE inventory_pack_lots IS
    'Per-delivery pack contents. FIFO on open. When an item has no lot on record '
    '(stock predating 033c) fn_open_pack_fifo falls back to the item conversion ratio.';

-- ---------------------------------------------------------------------------
-- PART 2 — FIFO open: consumes the OLDEST lot and uses ITS units_per_pack
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_open_pack_fifo(
    p_pack_item varchar(36), p_user varchar(36), p_reference varchar(36) DEFAULT NULL)
RETURNS TABLE (lot_id varchar(36), units_per_pack numeric,
               packs_remaining numeric, loose_total numeric)
LANGUAGE plpgsql AS $$
DECLARE l record; c record; v_loose numeric; v_packs numeric; r record;
BEGIN
    SELECT * INTO c FROM inventory_conversions
     WHERE from_item_id = p_pack_item AND is_active LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No conversion defined for %', p_pack_item;
    END IF;

    -- Table columns MUST be qualified: RETURNS TABLE puts packs_remaining and
    -- units_per_pack in scope as PL/pgSQL variables, so an unqualified reference
    -- is ambiguous and raises at runtime.
    SELECT * INTO l FROM inventory_pack_lots pl
     WHERE pl.inventory_item_id = p_pack_item AND pl.packs_remaining > 0
     ORDER BY pl.received_at, pl.id
     FOR UPDATE SKIP LOCKED LIMIT 1;

    -- No lot on record: fall back to the item-level ratio.
    IF l.id IS NULL THEN
        FOR r IN SELECT * FROM fn_convert_stock(p_pack_item, 1, p_user, p_reference,
                                'Apertura (sin lote; ratio por defecto)') LOOP
            RETURN QUERY SELECT NULL::varchar, c.ratio, r.from_new_stock, r.to_new_stock;
        END LOOP;
        RETURN;
    END IF;

    PERFORM 1 FROM inventory_items WHERE id IN (p_pack_item, c.to_item_id)
     ORDER BY id FOR UPDATE;

    SELECT stock_quantity INTO v_packs FROM inventory_items WHERE id = p_pack_item;
    IF v_packs < 1 THEN
        RAISE EXCEPTION 'INSUFFICIENT_SOURCE: % has % packs', p_pack_item, v_packs;
    END IF;
    v_packs := v_packs - 1;
    SELECT stock_quantity + l.units_per_pack INTO v_loose
      FROM inventory_items WHERE id = c.to_item_id;

    UPDATE inventory_items SET stock_quantity = v_packs, updated_at = clock_timestamp()
     WHERE id = p_pack_item;
    INSERT INTO inventory_movements (id, inventory_item_id, event_type, quantity_delta,
        quantity_after, reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, p_pack_item, 'CONVERSION_OUT', -1, v_packs,
            p_reference, format('Apertura lote %s (%s cig/cajetilla)', l.id, l.units_per_pack),
            p_user, clock_timestamp());

    UPDATE inventory_items SET stock_quantity = v_loose, updated_at = clock_timestamp()
     WHERE id = c.to_item_id;
    INSERT INTO inventory_movements (id, inventory_item_id, event_type, quantity_delta,
        quantity_after, reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, c.to_item_id, 'CONVERSION_IN', l.units_per_pack,
            v_loose, p_reference, format('Lote %s', l.id), p_user, clock_timestamp());

    UPDATE inventory_pack_lots
       SET packs_remaining = inventory_pack_lots.packs_remaining - 1
     WHERE inventory_pack_lots.id = l.id;

    RETURN QUERY SELECT l.id, l.units_per_pack, v_packs, v_loose;
END $$;

-- ---------------------------------------------------------------------------
-- PART 3 — Reporting
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_pack_lots_open AS
SELECT l.id, i.name AS pack_item, l.units_per_pack, l.packs_received, l.packs_remaining,
       l.packs_remaining * l.units_per_pack AS loose_equivalent, l.received_at
  FROM inventory_pack_lots l
  JOIN inventory_items i ON i.id = l.inventory_item_id
 WHERE l.packs_remaining > 0
 ORDER BY i.name, l.received_at;

-- ---------------------------------------------------------------------------
-- PART 4 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('033c','pack_lots',
        'Per-delivery units_per_pack, FIFO open, fallback to item ratio when no lot.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name='inventory_pack_lots') THEN
        RAISE EXCEPTION '033c: inventory_pack_lots not created';
    END IF;

    -- a lot cannot claim more remaining than received
    BEGIN
        INSERT INTO inventory_pack_lots (id, inventory_item_id, units_per_pack,
                                         packs_received, packs_remaining)
        VALUES ('assert-033c', '0965f096-2980-401f-abd5-0fd5017b4776', 20, 1, 5);
        RAISE EXCEPTION '033c: packs_remaining > packs_received was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- zero or negative pack contents must be rejected
    BEGIN
        INSERT INTO inventory_pack_lots (id, inventory_item_id, units_per_pack,
                                         packs_received, packs_remaining)
        VALUES ('assert-033c2', '0965f096-2980-401f-abd5-0fd5017b4776', 0, 1, 1);
        RAISE EXCEPTION '033c: units_per_pack = 0 was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- fn_open_pack_fifo is deliberately NOT called here: it mutates stock, and a
    -- migration assertion must be side-effect free. Verify it with the rolled-back
    -- test in verify_pack_lots.sql instead.
    --
    -- Static check that catches the bug the first version of this file shipped: the
    -- function raised "packs_remaining is ambiguous" on every call, because
    -- RETURNS TABLE puts its output column names in scope as PL/pgSQL variables and
    -- the table columns were unqualified.
    IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_open_pack_fifo')
         !~ 'pl\.packs_remaining' THEN
        RAISE EXCEPTION '033c: fn_open_pack_fifo does not qualify pl.packs_remaining -- '
                        'it will raise "ambiguous" on first call';
    END IF;

    SELECT count(*) INTO n FROM v_pack_lots_open;
    RAISE NOTICE '033c OK -- lot table + FIFO open live, % open lots', n;
END $$;

COMMIT;
